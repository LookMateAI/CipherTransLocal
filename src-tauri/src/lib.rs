pub mod commands;
pub mod db;
pub mod discovery;
pub mod models;
pub mod transfer;

pub use commands::*;
pub use db::*;
pub use discovery::*;
pub use models::*;
pub use transfer::*;

use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use tauri::Manager;

#[cfg(desktop)]
use std::sync::atomic::{AtomicBool, Ordering};
#[cfg(desktop)]
use tauri::{
    menu::MenuBuilder,
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    WindowEvent,
};

#[cfg(desktop)]
static QUIT_REQUESTED: AtomicBool = AtomicBool::new(false);

#[cfg(desktop)]
const DESKTOP_WINDOW_ICON: &[u8] = include_bytes!("../icons/icon.png");

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            #[cfg(desktop)]
            if let Some(window) = app.get_webview_window("main") {
                if let Ok(icon) = tauri::image::Image::from_bytes(DESKTOP_WINDOW_ICON) {
                    let _ = window.set_icon(icon);
                }
            }
            #[cfg(desktop)]
            configure_desktop_background_mode(app)?;

            let app_handle = app.handle();

            let app_data_dir = app_handle
                .path()
                .app_data_dir()
                .map_err(|e| anyhow::anyhow!("Failed to get app data directory: {}", e))?;
            std::fs::create_dir_all(&app_data_dir)
                .map_err(|e| anyhow::anyhow!("Failed to create app data directory: {}", e))?;

            let db_path = app_data_dir.join("ciphertranslocal.db");
            let db = Arc::new(Database::new(db_path));

            let mut settings = db.get_settings();
            if cfg!(target_os = "android")
                && matches!(
                    settings.android_storage_mode.as_str(),
                    "app_private" | "app_media"
                )
            {
                settings.android_storage_mode = "public_downloads".to_string();
                db.save_settings(&settings);
            }
            let download_path = resolve_download_path(&app_data_dir, &settings);
            if settings.download_path != download_path.to_string_lossy() {
                settings.download_path = download_path.to_string_lossy().to_string();
                db.save_settings(&settings);
            }

            println!("Download path: {}", download_path.display());

            let discovery = tauri::async_runtime::block_on(DiscoveryService::new(
                7891,
                settings.device_id.clone(),
                settings.device_name.clone(),
            ))
            .map_err(|e| anyhow::anyhow!("Failed to start discovery service: {}", e))?;

            tauri::async_runtime::block_on(discovery.start())
                .map_err(|e| anyhow::anyhow!("Failed to run discovery: {}", e))?;

            println!("Discovery service started on port 7890");

            let transfer = TransferService::new(download_path, app_handle.clone(), db.clone());

            tauri::async_runtime::block_on(transfer.start_http_server())
                .map_err(|e| anyhow::anyhow!("Failed to start HTTP server: {}", e))?;

            println!("HTTP transfer server started on port 7891");

            let app_state = commands::AppState {
                discovery: Arc::new(discovery),
                transfer: Arc::new(transfer),
                db,
            };

            app.manage(app_state);

            println!("CipherTransLocal initialized successfully");

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_devices,
            commands::trigger_discovery,
            commands::update_device_alias,
            commands::toggle_favorite,
            commands::predeclare_send_files,
            commands::send_files,
            commands::send_text,
            commands::pause_transfer,
            commands::resume_transfer,
            commands::cancel_transfer,
            commands::retry_transfer,
            commands::get_chat_history,
            commands::get_all_history,
            commands::search_history,
            commands::clear_history,
            commands::clear_all_history,
            commands::delete_message,
            commands::get_settings,
            commands::update_settings,
            commands::set_device_name,
            commands::delete_device,
            commands::announce_offline,
            commands::get_device_info,
            commands::open_file_location,
        ])
        .on_window_event(|_window, _event| {
            #[cfg(desktop)]
            if let WindowEvent::CloseRequested { api, .. } = _event {
                if !QUIT_REQUESTED.load(Ordering::SeqCst) {
                    api.prevent_close();
                    let _ = _window.hide();
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(desktop)]
fn configure_desktop_background_mode(app: &mut tauri::App) -> tauri::Result<()> {
    let menu = MenuBuilder::new(app)
        .text("show", "显示窗口")
        .separator()
        .text("quit", "退出")
        .build()?;
    let icon = app.default_window_icon().cloned();

    let mut tray = TrayIconBuilder::with_id("main")
        .menu(&menu)
        .tooltip("CipherTransLocal - 后台保持连接")
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "show" => show_main_window(app),
            "quit" => {
                QUIT_REQUESTED.store(true, Ordering::SeqCst);
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| match event {
            TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            }
            | TrayIconEvent::DoubleClick {
                button: MouseButton::Left,
                ..
            } => show_main_window(tray.app_handle()),
            _ => {}
        });

    if let Some(icon) = icon {
        tray = tray.icon(icon);
    }

    tray.build(app)?;
    Ok(())
}

#[cfg(desktop)]
fn show_main_window<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

pub(crate) fn resolve_download_path(app_data_dir: &Path, settings: &Settings) -> PathBuf {
    let fallback = app_data_dir.join("downloads");

    if cfg!(target_os = "android") {
        let selected = fallback.clone();

        if selected != PathBuf::from("/") && std::fs::create_dir_all(&selected).is_ok() {
            return selected;
        }

        if let Err(e) = std::fs::create_dir_all(&fallback) {
            eprintln!(
                "Failed to create Android fallback downloads dir {}: {}",
                fallback.display(),
                e
            );
        }
        return fallback;
    }

    if !settings.download_path.trim().is_empty() {
        let configured = PathBuf::from(&settings.download_path);
        if configured != PathBuf::from("/") && std::fs::create_dir_all(&configured).is_ok() {
            return configured;
        }

        eprintln!(
            "Configured download path is not writable, falling back to app data dir: {}",
            configured.display()
        );
    }

    if let Err(e) = std::fs::create_dir_all(&fallback) {
        eprintln!(
            "Failed to create app private downloads dir {}: {}",
            fallback.display(),
            e
        );
    }

    fallback
}
