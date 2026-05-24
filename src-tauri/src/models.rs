use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Device {
    pub device_id: String,
    pub device_name: String,
    pub device_type: String,
    pub ip: String,
    pub port: u16,
    pub last_seen: i64,
    pub is_online: bool,
    pub alias: Option<String>,
    pub is_favorite: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatMessage {
    pub message_id: String,
    pub device_id: String,
    pub file_id: String,
    pub file_name: String,
    pub file_size: u64,
    pub file_type: String,
    pub direction: String,
    pub status: String,
    pub timestamp: i64,
    pub thumbnail: Option<String>,
    pub progress: Option<f32>,
    pub speed: Option<u64>,
    pub error: Option<String>,
    pub file_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Settings {
    pub device_id: String,
    pub device_name: String,
    pub download_path: String,
    pub speed_limit: u64,
    pub auto_start: bool,
    pub notification: bool,
    pub theme: String,
    pub android_storage_mode: String,
    pub auto_save_images_to_gallery: bool,
    pub android_custom_directory_uri: String,
    pub android_custom_directory_name: String,
    pub android_keep_screen_awake: bool,
    pub android_haptics: bool,
    pub android_wifi_only: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            device_id: uuid::Uuid::new_v4().to_string(),
            device_name: default_device_name(),
            download_path: dirs::download_dir()
                .unwrap_or_else(|| std::env::current_dir().unwrap())
                .to_string_lossy()
                .to_string(),
            speed_limit: 0,
            auto_start: false,
            notification: true,
            theme: "light".to_string(),
            android_storage_mode: "public_downloads".to_string(),
            auto_save_images_to_gallery: false,
            android_custom_directory_uri: String::new(),
            android_custom_directory_name: String::new(),
            android_keep_screen_awake: true,
            android_haptics: true,
            android_wifi_only: true,
        }
    }
}

pub fn default_device_name() -> String {
    #[cfg(target_os = "android")]
    {
        let manufacturer = android_getprop("ro.product.manufacturer");
        let model = android_getprop("ro.product.model");
        let name = match (manufacturer, model) {
            (Some(maker), Some(model)) if !model.to_lowercase().contains(&maker.to_lowercase()) => {
                format!("{maker} {model}")
            }
            (_, Some(model)) => model,
            (Some(maker), _) => maker,
            _ => "Android Device".to_string(),
        };

        return clean_device_name(name);
    }

    #[cfg(not(target_os = "android"))]
    {
        let hostname = gethostname::gethostname().to_string_lossy().to_string();
        let fallback = std::env::var("COMPUTERNAME")
            .or_else(|_| std::env::var("HOSTNAME"))
            .unwrap_or_else(|_| "Desktop Device".to_string());
        clean_device_name(
            if hostname.trim().is_empty() || hostname.eq_ignore_ascii_case("localhost") {
                fallback
            } else {
                hostname
            },
        )
    }
}

#[cfg(target_os = "android")]
fn android_getprop(key: &str) -> Option<String> {
    let output = std::process::Command::new("/system/bin/getprop")
        .arg(key)
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }

    let value = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if value.is_empty() {
        None
    } else {
        Some(value)
    }
}

fn clean_device_name(name: String) -> String {
    let name = name.trim().to_string();
    if name.is_empty() || name.eq_ignore_ascii_case("localhost") {
        "CipherTransLocal Device".to_string()
    } else {
        name
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TransferProgress {
    pub file_id: String,
    pub completed_chunks: u64,
    pub total_chunks: u64,
    pub bytes_transferred: u64,
    pub speed: u64,
    pub eta: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileMetadata {
    pub file_id: String,
    pub file_name: String,
    pub file_size: u64,
    pub chunk_size: u64,
    pub total_chunks: u64,
    pub checksum: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiscoveryMessage {
    #[serde(rename = "type")]
    pub msg_type: String,
    pub device_id: String,
    pub device_name: String,
    pub device_type: String,
    pub ip: String,
    pub port: u16,
    pub timestamp: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileTransferRequest {
    pub file_id: String,
    pub file_name: String,
    pub file_size: u64,
    pub sender_device_id: String,
    pub sender_device_name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileTransferResponse {
    pub accepted: bool,
    pub file_id: String,
    pub save_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChunkRequest {
    pub file_id: String,
    pub chunk_index: u64,
    pub offset: u64,
    pub length: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChunkResponse {
    pub file_id: String,
    pub chunk_index: u64,
    pub data: Vec<u8>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TextMessage {
    pub message_id: String,
    pub sender_device_id: String,
    pub sender_device_name: String,
    pub content: String,
    pub timestamp: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TransferManifest {
    pub message_id: String,
    pub file_id: String,
    pub file_name: String,
    pub file_size: u64,
    pub file_type: String,
    pub chunk_size: u64,
    pub total_chunks: u64,
    pub checksum: String,
    pub sender_device_id: String,
    pub timestamp: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TransferAnnouncedFile {
    pub message_id: String,
    pub file_id: String,
    pub file_name: String,
    pub file_size: u64,
    pub file_type: String,
    pub timestamp: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TransferAnnouncement {
    pub sender_device_id: String,
    pub files: Vec<TransferAnnouncedFile>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProbeResponse {
    pub received_chunks: Vec<u64>,
    pub complete: bool,
}
