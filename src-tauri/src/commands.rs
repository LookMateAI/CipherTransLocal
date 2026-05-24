use crate::{ChatMessage, Database, Device, DiscoveryService, Settings, TransferAnnouncedFile, TransferService};
use std::path::Path;
use std::sync::Arc;
use tauri::{Manager, State};

pub struct AppState {
    pub discovery: Arc<DiscoveryService>,
    pub transfer: Arc<TransferService>,
    pub db: Arc<Database>,
}

#[tauri::command]
pub async fn get_devices(state: State<'_, AppState>) -> Result<Vec<Device>, String> {
    let online_devices = state.discovery.get_devices().await;
    let saved_devices = state.db.get_saved_devices();
    let mut all_devices: Vec<Device> = Vec::new();

    for saved in saved_devices {
        if let Some(online) = online_devices
            .iter()
            .find(|d| d.device_id == saved.device_id)
        {
            let is_online = online.is_online;
            let device = Device {
                is_online,
                alias: saved.alias,
                is_favorite: saved.is_favorite,
                ..online.clone()
            };
            if is_online {
                state.db.save_device(&device);
            }
            upsert_device_by_id(&mut all_devices, device);
        } else {
            upsert_device_by_id(&mut all_devices, saved);
        }
    }

    for online in online_devices {
        if !all_devices.iter().any(|d| d.device_id == online.device_id) {
            state.db.save_device(&online);
            upsert_device_by_id(&mut all_devices, online);
        }
    }

    Ok(all_devices)
}

fn upsert_device_by_id(devices: &mut Vec<Device>, device: Device) {
    if let Some(existing) = devices
        .iter_mut()
        .find(|existing| existing.device_id == device.device_id)
    {
        let alias = existing.alias.clone().or(device.alias.clone());
        let is_favorite = existing.is_favorite || device.is_favorite;
        let should_replace =
            device.is_online || (!existing.is_online && device.last_seen >= existing.last_seen);

        if should_replace {
            *existing = Device {
                alias,
                is_favorite,
                ..device
            };
        } else {
            existing.alias = alias;
            existing.is_favorite = is_favorite;
        }
        return;
    }

    devices.push(device);
}

#[tauri::command]
pub async fn trigger_discovery(state: State<'_, AppState>) -> Result<Vec<Device>, String> {
    state
        .discovery
        .announce_once()
        .await
        .map_err(|e| e.to_string())?;
    tokio::time::sleep(std::time::Duration::from_millis(250)).await;
    get_devices(state).await
}

#[tauri::command]
pub async fn update_device_alias(
    state: State<'_, AppState>,
    device_id: String,
    alias: String,
) -> Result<(), String> {
    let devices = state.discovery.get_devices().await;

    let device = devices
        .iter()
        .find(|d| d.device_id == device_id)
        .cloned()
        .or_else(|| {
            state
                .db
                .get_saved_devices()
                .iter()
                .find(|d| d.device_id == device_id)
                .cloned()
        })
        .ok_or("Device not found")?;

    let updated_device = Device {
        alias: Some(alias),
        ..device
    };

    state.db.save_device(&updated_device);

    Ok(())
}

#[tauri::command]
pub async fn toggle_favorite(state: State<'_, AppState>, device_id: String) -> Result<(), String> {
    let devices = state.discovery.get_devices().await;

    let device = devices
        .iter()
        .find(|d| d.device_id == device_id)
        .cloned()
        .or_else(|| {
            state
                .db
                .get_saved_devices()
                .iter()
                .find(|d| d.device_id == device_id)
                .cloned()
        })
        .ok_or("Device not found")?;

    let updated_device = Device {
        is_favorite: !device.is_favorite,
        ..device
    };

    state.db.save_device(&updated_device);
    state
        .discovery
        .toggle_favorite(&device_id)
        .await
        .map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
pub async fn send_files(
    state: State<'_, AppState>,
    device_id: String,
    file_paths: Vec<String>,
    prepared_message_ids: Option<Vec<String>>,
) -> Result<Vec<(String, String)>, String> {
    let devices = state.discovery.get_devices().await;
    let saved_devices = state.db.get_saved_devices();
    let device = devices
        .iter()
        .find(|d| d.device_id == device_id)
        .or_else(|| saved_devices.iter().find(|d| d.device_id == device_id))
        .ok_or_else(|| "Device not found".to_string())?;
    if !device.is_online {
        return Err("Device is offline".to_string());
    }

    let target_ip = device.ip.clone();
    let self_device_id = state.discovery.get_device_id();

    state.db.save_device(device);

    let results = state
        .transfer
        .send_files(
            device_id.clone(),
            file_paths,
            target_ip,
            self_device_id.to_string(),
            prepared_message_ids,
        )
        .await
        .map_err(|e| e.to_string())?;

    let messages = state.transfer.get_chat_history(&device_id).await;
    for message in &messages {
        state.db.save_message(message);
    }

    Ok(results)
}

#[tauri::command]
pub async fn predeclare_send_files(
    state: State<'_, AppState>,
    device_id: String,
    files: Vec<TransferAnnouncedFile>,
) -> Result<(), String> {
    let devices = state.discovery.get_devices().await;
    let saved_devices = state.db.get_saved_devices();
    let device = devices
        .iter()
        .find(|d| d.device_id == device_id)
        .or_else(|| saved_devices.iter().find(|d| d.device_id == device_id))
        .ok_or_else(|| "Device not found".to_string())?;
    if !device.is_online {
        return Err("Device is offline".to_string());
    }

    state.db.save_device(device);
    state
        .transfer
        .predeclare_send_files(
            device.ip.clone(),
            state.discovery.get_device_id().to_string(),
            files,
        )
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn send_text(
    state: State<'_, AppState>,
    device_id: String,
    text: String,
) -> Result<String, String> {
    let devices = state.discovery.get_devices().await;
    let device = devices.iter().find(|d| d.device_id == device_id);

    if device.is_none() {
        return Err("Device not found".to_string());
    }

    let device = device.unwrap();
    if !device.is_online {
        return Err("Device is offline".to_string());
    }

    state.db.save_device(device);

    let message_id = state
        .transfer
        .send_text(
            device_id.clone(),
            device.ip.clone(),
            state.discovery.get_device_id().to_string(),
            state.discovery.get_device_name(),
            text,
        )
        .await
        .map_err(|e| e.to_string())?;

    let messages = state.transfer.get_chat_history(&device_id).await;
    for message in &messages {
        state.db.save_message(message);
    }

    Ok(message_id)
}

#[tauri::command]
pub async fn get_chat_history(
    state: State<'_, AppState>,
    device_id: String,
) -> Result<Vec<ChatMessage>, String> {
    let recent_messages = state.transfer.get_chat_history(&device_id).await;
    let mut all_messages = state.db.get_messages(&device_id);

    for msg in recent_messages {
        state.db.save_message(&msg);

        if let Some(saved) = all_messages
            .iter_mut()
            .find(|m| m.message_id == msg.message_id)
        {
            *saved = msg;
        } else {
            all_messages.push(msg);
        }
    }

    all_messages.sort_by(|a, b| a.timestamp.cmp(&b.timestamp));

    Ok(all_messages)
}

#[tauri::command]
pub async fn get_all_history(state: State<'_, AppState>) -> Result<Vec<ChatMessage>, String> {
    Ok(state.db.get_all_messages())
}

#[tauri::command]
pub async fn search_history(
    state: State<'_, AppState>,
    query: String,
) -> Result<Vec<ChatMessage>, String> {
    Ok(state.db.search_messages(&query))
}

#[tauri::command]
pub async fn clear_history(state: State<'_, AppState>, device_id: String) -> Result<(), String> {
    let has_active_transfer = state
        .db
        .get_messages(&device_id)
        .iter()
        .any(is_delete_locked_message);
    let has_memory_active_transfer = state
        .transfer
        .get_chat_history(&device_id)
        .await
        .iter()
        .any(is_delete_locked_message);
    if has_active_transfer || has_memory_active_transfer {
        return Err("传输中的文件不能直接删除，请先取消或等待完成".to_string());
    }

    state.db.clear_messages(&device_id);
    Ok(())
}

#[tauri::command]
pub async fn clear_all_history(state: State<'_, AppState>) -> Result<(), String> {
    let has_active_transfer = state
        .db
        .get_all_messages()
        .iter()
        .any(is_delete_locked_message);
    let mut has_memory_active_transfer = false;
    for device in state.discovery.get_devices().await {
        if state
            .transfer
            .get_chat_history(&device.device_id)
            .await
            .iter()
            .any(is_delete_locked_message)
        {
            has_memory_active_transfer = true;
            break;
        }
    }
    if has_active_transfer || has_memory_active_transfer {
        return Err("传输中的文件不能直接删除，请先取消或等待完成".to_string());
    }

    state.db.clear_all_messages();
    Ok(())
}

#[tauri::command]
pub async fn delete_message(state: State<'_, AppState>, message_id: String) -> Result<(), String> {
    let message = state
        .db
        .get_message(&message_id)
        .ok_or_else(|| "Message not found".to_string())?;
    let memory_message = state
        .transfer
        .get_chat_history(&message.device_id)
        .await
        .into_iter()
        .find(|item| item.message_id == message_id);

    if is_delete_locked_message(&message)
        || memory_message
            .as_ref()
            .map(is_delete_locked_message)
            .unwrap_or(false)
    {
        return Err("传输中的文件不能直接删除，请先取消或等待完成".to_string());
    }

    state
        .transfer
        .delete_message(&message.device_id, &message_id)
        .await;
    state.db.delete_message(&message_id);
    Ok(())
}

fn is_delete_locked_message(message: &ChatMessage) -> bool {
    message.file_type != "text"
        && matches!(
            message.status.as_str(),
            "pending" | "transferring" | "paused"
        )
}

#[tauri::command]
pub async fn pause_transfer(state: State<'_, AppState>, message_id: String) -> Result<(), String> {
    match state.transfer.pause_transfer(&message_id).await {
        Ok(()) => Ok(()),
        Err(_) => forward_transfer_control(state, message_id, "pause", "paused").await,
    }
}

#[tauri::command]
pub async fn resume_transfer(state: State<'_, AppState>, message_id: String) -> Result<(), String> {
    match state.transfer.resume_transfer(&message_id).await {
        Ok(()) => Ok(()),
        Err(_) => forward_transfer_control(state, message_id, "resume", "transferring").await,
    }
}

#[tauri::command]
pub async fn cancel_transfer(state: State<'_, AppState>, message_id: String) -> Result<(), String> {
    match state.transfer.cancel_transfer(&message_id).await {
        Ok(()) => Ok(()),
        Err(_) => forward_transfer_control(state, message_id, "cancel", "canceled").await,
    }
}

#[tauri::command]
pub async fn retry_transfer(state: State<'_, AppState>, message_id: String) -> Result<(), String> {
    match state.transfer.retry_transfer(&message_id).await {
        Ok(()) => Ok(()),
        Err(_) => forward_transfer_control(state, message_id, "retry", "pending").await,
    }
}

async fn forward_transfer_control(
    state: State<'_, AppState>,
    message_id: String,
    action: &str,
    local_status: &str,
) -> Result<(), String> {
    let message = state
        .db
        .get_message(&message_id)
        .ok_or_else(|| "Transfer not found".to_string())?;

    let devices = state.discovery.get_devices().await;
    let saved_devices = state.db.get_saved_devices();
    let device = devices
        .iter()
        .find(|d| d.device_id == message.device_id)
        .or_else(|| {
            saved_devices
                .iter()
                .find(|d| d.device_id == message.device_id)
        });

    if let Some(device) = device {
        if let Err(err) = state
            .transfer
            .send_remote_control(&device.ip, &message_id, action)
            .await
        {
            if action != "cancel" {
                return Err(format!("无法同步到对方设备：{err}。请确认对方在线后重试"));
            }
        }
    } else if action != "cancel" {
        return Err("没有找到该设备。请刷新设备列表，确认对方仍在附近后重试".to_string());
    }

    state
        .transfer
        .set_remote_control_status(&message.device_id, &message_id, local_status)
        .await;

    Ok(())
}

#[tauri::command]
pub async fn get_settings(state: State<'_, AppState>) -> Result<Settings, String> {
    Ok(state.db.get_settings())
}

#[tauri::command]
pub async fn update_settings(
    state: State<'_, AppState>,
    app_handle: tauri::AppHandle,
    mut settings: Settings,
) -> Result<(), String> {
    let app_data_dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data directory: {e}"))?;
    let download_path = crate::resolve_download_path(&app_data_dir, &settings);
    settings.download_path = download_path.to_string_lossy().to_string();
    state.transfer.set_download_path(download_path).await;
    state
        .discovery
        .set_device_name(settings.device_name.clone())
        .await;
    state.db.save_settings(&settings);
    Ok(())
}

#[tauri::command]
pub async fn set_device_name(state: State<'_, AppState>, name: String) -> Result<(), String> {
    state.discovery.set_device_name(name.clone()).await;

    let mut settings = state.db.get_settings();
    settings.device_name = name;
    state.db.save_settings(&settings);

    Ok(())
}

#[tauri::command]
pub async fn delete_device(state: State<'_, AppState>, device_id: String) -> Result<(), String> {
    let has_active_transfer = state
        .db
        .get_messages(&device_id)
        .iter()
        .any(is_delete_locked_message);
    let has_memory_active_transfer = state
        .transfer
        .get_chat_history(&device_id)
        .await
        .iter()
        .any(is_delete_locked_message);
    if has_active_transfer || has_memory_active_transfer {
        return Err("传输中的文件不能直接删除，请先取消或等待完成".to_string());
    }

    state.db.delete_device(&device_id);
    state
        .discovery
        .forget_device(&device_id)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn announce_offline(state: State<'_, AppState>) -> Result<(), String> {
    state
        .discovery
        .announce_offline()
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_device_info(
    state: State<'_, AppState>,
) -> Result<(String, String, String), String> {
    let device_id = state.discovery.get_device_id();
    let device_name = state.discovery.get_device_name();
    let ip = state.discovery.get_ip();

    Ok((device_id.to_string(), device_name, ip.to_string()))
}

#[tauri::command]
pub async fn open_file_location(file_path: String) -> Result<(), String> {
    let path = Path::new(&file_path);
    if !path.exists() {
        return Err("文件已被删除或移动，无法打开原始位置".to_string());
    }

    #[cfg(target_os = "windows")]
    {
        if path.is_file() {
            std::process::Command::new("explorer.exe")
                .arg("/select,")
                .arg(path)
                .spawn()
                .map_err(|e| e.to_string())?;
        } else {
            std::process::Command::new("explorer.exe")
                .arg(path)
                .spawn()
                .map_err(|e| e.to_string())?;
        }
        return Ok(());
    }

    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .args(["-R", &file_path])
            .spawn()
            .map_err(|e| e.to_string())?;
        return Ok(());
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let parent = path.parent().unwrap_or(path);
        std::process::Command::new("xdg-open")
            .arg(parent)
            .spawn()
            .map_err(|e| e.to_string())?;
        return Ok(());
    }

    #[allow(unreachable_code)]
    Err("当前平台不支持打开文件所在位置".to_string())
}
