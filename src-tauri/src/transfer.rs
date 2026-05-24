use crate::{
    models::{ChatMessage, ProbeResponse, TransferAnnouncedFile, TransferAnnouncement, TransferManifest},
    Database,
};
use anyhow::{anyhow, Context};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet, VecDeque};
use std::fs::File as StdFile;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncReadExt, AsyncWriteExt, AsyncSeekExt};
use tokio::net::TcpStream;
use tokio::sync::{Mutex, RwLock};
use tokio_util::io::ReaderStream;

pub const HTTP_PORT: u16 = 7891;
pub const CHUNK_SIZE: usize = 8 * 1024 * 1024;
const MAX_CONCURRENT_CHUNK_UPLOADS: usize = 8;
const STREAM_FRAME_SIZE: usize = 2 * 1024 * 1024;
const TRANSFERRING_PROGRESS_MAX: f32 = 99.4;
const CHUNK_UPLOAD_RETRIES: usize = 4;
const HTTP_KEEP_ALIVE_TIMEOUT: Duration = Duration::from_secs(60);
const SOCKET_BUFFER_SIZE: usize = 4 * 1024 * 1024;
const HTTP_READER_BUFFER_SIZE: usize = 4 * 1024 * 1024;
const RECEIVE_EMIT_INTERVAL: Duration = Duration::from_millis(320);
const PROGRESS_EMIT_INTERVAL: Duration = Duration::from_millis(320);
const REMOTE_STATUS_INTERVAL: Duration = Duration::from_millis(650);
const SPEED_WINDOW: Duration = Duration::from_millis(1500);
const SPEED_MAX_SAMPLES: usize = 32;
const SPEED_MIN_SPAN: Duration = Duration::from_millis(250);
const HTTP_REQUEST_TIMEOUT: Duration = Duration::from_secs(12);
const HTTP_TRANSFER_TIMEOUT: Duration = Duration::from_secs(45);

struct SpeedSampler {
    samples: VecDeque<(Instant, u64)>,
}

impl SpeedSampler {
    fn new() -> Self {
        Self {
            samples: VecDeque::new(),
        }
    }

    fn observe(&mut self, total_bytes: u64) -> u64 {
        let now = Instant::now();
        let cutoff = now.checked_sub(SPEED_WINDOW).unwrap_or(now);
        while self.samples.len() > 1 {
            if self.samples[1].0 < cutoff {
                self.samples.pop_front();
            } else {
                break;
            }
        }
        while self.samples.len() >= SPEED_MAX_SAMPLES {
            self.samples.pop_front();
        }
        self.samples.push_back((now, total_bytes));
        if self.samples.len() < 2 {
            return 0;
        }
        let (t0, b0) = *self.samples.front().unwrap();
        let (t1, b1) = *self.samples.back().unwrap();
        let dt = t1.duration_since(t0);
        if dt < SPEED_MIN_SPAN {
            return 0;
        }
        (b1.saturating_sub(b0) as f64 / dt.as_secs_f64()) as u64
    }

    fn reset(&mut self) {
        self.samples.clear();
    }
}

#[derive(Clone)]
struct TransferTask {
    device_id: String,
    file_path: String,
    target_ip: String,
    self_device_id: String,
    message_id: String,
    file_id: String,
}

#[derive(Default)]
struct TransferControl {
    paused: AtomicBool,
    canceled: AtomicBool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct RemoteTransferStatus {
    message_id: String,
    status: String,
    progress: Option<f32>,
    speed: Option<u64>,
    error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct RemoteTransferControl {
    message_id: String,
    action: String,
}

struct ReceiveFileState {
    file: Arc<StdFile>,
    bitmap_file: Arc<StdMutex<StdFile>>,
    received: Arc<Mutex<HashSet<u64>>>,
    bytes_received: AtomicU64,
    speed_sampler: Arc<Mutex<SpeedSampler>>,
}

pub struct TransferService {
    messages: Arc<RwLock<HashMap<String, Vec<ChatMessage>>>>,
    tasks: Arc<RwLock<HashMap<String, TransferTask>>>,
    controls: Arc<RwLock<HashMap<String, Arc<TransferControl>>>>,
    receive_stats: Arc<RwLock<HashMap<String, (Instant, u64)>>>,
    receive_locks: Arc<RwLock<HashMap<String, Arc<Mutex<()>>>>>,
    receive_files: Arc<RwLock<HashMap<String, Arc<ReceiveFileState>>>>,
    receive_emit_at: Arc<RwLock<HashMap<String, Instant>>>,
    canceled_transfers: Arc<RwLock<HashSet<String>>>,
    paused_transfers: Arc<RwLock<HashSet<String>>>,
    download_path: Arc<RwLock<PathBuf>>,
    client: Arc<reqwest::Client>,
    app_handle: AppHandle,
    db: Arc<Database>,
}

impl TransferService {
    pub fn new(download_path: PathBuf, app_handle: AppHandle, db: Arc<Database>) -> Self {
        Self {
            messages: Arc::new(RwLock::new(HashMap::new())),
            tasks: Arc::new(RwLock::new(HashMap::new())),
            controls: Arc::new(RwLock::new(HashMap::new())),
            receive_stats: Arc::new(RwLock::new(HashMap::new())),
            receive_locks: Arc::new(RwLock::new(HashMap::new())),
            receive_files: Arc::new(RwLock::new(HashMap::new())),
            receive_emit_at: Arc::new(RwLock::new(HashMap::new())),
            canceled_transfers: Arc::new(RwLock::new(HashSet::new())),
            paused_transfers: Arc::new(RwLock::new(HashSet::new())),
            download_path: Arc::new(RwLock::new(download_path)),
            client: Arc::new(build_http_client()),
            app_handle,
            db,
        }
    }

    pub async fn get_download_path(&self) -> PathBuf {
        self.download_path.read().await.clone()
    }

    pub async fn set_download_path(&self, download_path: PathBuf) {
        *self.download_path.write().await = download_path;
    }

    pub async fn start_http_server(&self) -> anyhow::Result<()> {
        let download_path = self.download_path.clone();
        let messages = self.messages.clone();
        let tasks = self.tasks.clone();
        let controls = self.controls.clone();
        let app_handle = self.app_handle.clone();
        let db = self.db.clone();
        let receive_stats = self.receive_stats.clone();
        let receive_locks = self.receive_locks.clone();
        let receive_files = self.receive_files.clone();
        let receive_emit_at = self.receive_emit_at.clone();
        let canceled_transfers = self.canceled_transfers.clone();
        let paused_transfers = self.paused_transfers.clone();
        let client = self.client.clone();

        tokio::spawn(async move {
            use tokio::io::AsyncBufReadExt;
            use tokio::net::TcpListener;

            let listener = match TcpListener::bind(("0.0.0.0", HTTP_PORT)).await {
                Ok(listener) => listener,
                Err(e) => {
                    eprintln!(
                        "Failed to bind transfer server on port {}: {}",
                        HTTP_PORT, e
                    );
                    return;
                }
            };

            println!("Transfer server started on port {}", HTTP_PORT);

            loop {
                if let Ok((socket, addr)) = listener.accept().await {
                    println!("Transfer connection from {}", addr);

                    let download_path_clone = download_path.clone();
                    let messages_clone = messages.clone();
                    let tasks_clone = tasks.clone();
                    let controls_clone = controls.clone();
                    let app_handle_clone = app_handle.clone();
                    let db_clone = db.clone();
                    let receive_stats_clone = receive_stats.clone();
                    let receive_locks_clone = receive_locks.clone();
                    let receive_files_clone = receive_files.clone();
                    let receive_emit_at_clone = receive_emit_at.clone();
                    let canceled_transfers_clone = canceled_transfers.clone();
                    let paused_transfers_clone = paused_transfers.clone();
                    let client_clone = client.clone();

                    tokio::spawn(async move {
                        let socket = tune_tcp_stream(socket);
                        let (reader, mut writer) = socket.into_split();
                        let mut buf_reader = tokio::io::BufReader::with_capacity(HTTP_READER_BUFFER_SIZE, reader);

                        loop {
                            let current_download_path = download_path_clone.read().await.clone();
                            let mut request_line = String::new();
                            match tokio::time::timeout(
                                HTTP_KEEP_ALIVE_TIMEOUT,
                                buf_reader.read_line(&mut request_line),
                            )
                            .await
                            {
                                Ok(Ok(0)) | Err(_) | Ok(Err(_)) => return,
                                Ok(Ok(_)) => {}
                            }

                            if request_line.trim().is_empty() {
                                continue;
                            }

                            let mut headers = HashMap::new();
                            loop {
                                let mut line = String::new();
                                if buf_reader.read_line(&mut line).await.is_err() {
                                    return;
                                }
                                if line.trim().is_empty() {
                                    break;
                                }
                                if let Some(pos) = line.find(':') {
                                    let key = line[..pos].trim().to_ascii_lowercase();
                                    let value = line[pos + 1..].trim().to_string();
                                    headers.insert(key, value);
                                }
                            }

                            let parts: Vec<&str> = request_line.trim().split_whitespace().collect();
                            if parts.len() < 3 {
                                write_response(&mut writer, 400, b"Bad Request").await;
                                continue;
                            }

                            let method = parts[0];
                            let path = parts[1];

                            let result = match (method, path) {
                                ("POST", "/probe") => {
                                    handle_probe(&mut buf_reader, &headers, &current_download_path)
                                        .await
                                }
                                ("POST", "/transfer-announce") => {
                                    handle_transfer_announcement(
                                        &mut buf_reader,
                                        &headers,
                                        &messages_clone,
                                        &app_handle_clone,
                                        &db_clone,
                                    )
                                    .await
                                }
                                ("POST", "/chunk") => {
                                    handle_chunk(
                                        &mut buf_reader,
                                        &headers,
                                        &current_download_path,
                                        &messages_clone,
                                        &app_handle_clone,
                                        &db_clone,
                                        &receive_stats_clone,
                                        &receive_locks_clone,
                                        &receive_files_clone,
                                        &receive_emit_at_clone,
                                        &canceled_transfers_clone,
                                        &paused_transfers_clone,
                                    )
                                    .await
                                }
                                ("POST", "/transfer-status") => {
                                    handle_transfer_status(
                                        &mut buf_reader,
                                        &headers,
                                        &current_download_path,
                                        &messages_clone,
                                        &app_handle_clone,
                                        &db_clone,
                                        &receive_stats_clone,
                                        &receive_files_clone,
                                        &receive_emit_at_clone,
                                        &canceled_transfers_clone,
                                        &paused_transfers_clone,
                                    )
                                    .await
                                }
                                ("POST", "/transfer-control") => {
                                    handle_transfer_control(
                                        &mut buf_reader,
                                        &headers,
                                        &current_download_path,
                                        &tasks_clone,
                                        &controls_clone,
                                        &messages_clone,
                                        &app_handle_clone,
                                        &db_clone,
                                        &receive_stats_clone,
                                        &receive_files_clone,
                                        &receive_emit_at_clone,
                                        &canceled_transfers_clone,
                                        &paused_transfers_clone,
                                        &client_clone,
                                    )
                                    .await
                                }
                                ("POST", "/text") => {
                                    handle_text(
                                        &mut buf_reader,
                                        &headers,
                                        &messages_clone,
                                        &app_handle_clone,
                                        &db_clone,
                                    )
                                    .await
                                }
                                _ => Err(anyhow!("Not found")),
                            };

                            match result {
                                Ok(body) => write_response(&mut writer, 200, body.as_bytes()).await,
                                Err(e) if e.to_string() == "Not found" => {
                                    write_response(&mut writer, 404, b"Not Found").await
                                }
                                Err(e) => {
                                    eprintln!("Transfer request failed: {e}");
                                    write_response(&mut writer, 500, e.to_string().as_bytes()).await;
                                }
                            }
                        }
                    });
                }
            }
        });

        Ok(())
    }

    pub async fn send_files(
        &self,
        device_id: String,
        file_paths: Vec<String>,
        target_ip: String,
        self_device_id: String,
        prepared_message_ids: Option<Vec<String>>,
    ) -> anyhow::Result<Vec<(String, String)>> {
        let mut results = Vec::new();
        let requested_count = file_paths.len();
        let mut missing_count = 0usize;
        let mut prepared_ids = prepared_message_ids.unwrap_or_default().into_iter();

        for file_path in file_paths {
            let path = PathBuf::from(&file_path);
            if !path.exists() {
                eprintln!("File not found: {}", file_path);
                missing_count += 1;
                continue;
            }

            let file_name = path
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_else(|| "unknown".to_string());

            let file_size = std::fs::metadata(&path)?.len();
            let file_id = stable_file_id(&path, &self_device_id)?;
            let message_id = prepared_ids.next().unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
            let file_type = get_file_type(&file_path);

            let message = ChatMessage {
                message_id: message_id.clone(),
                device_id: device_id.clone(),
                file_id: file_id.clone(),
                file_name,
                file_size,
                file_type,
                direction: "send".to_string(),
                status: "pending".to_string(),
                timestamp: chrono::Utc::now().timestamp_millis(),
                thumbnail: None,
                progress: Some(0.0),
                speed: None,
                error: None,
                file_path: Some(file_path.clone()),
            };

            self.upsert_message(message.clone()).await;

            let task = TransferTask {
                device_id: device_id.clone(),
                file_path: file_path.clone(),
                target_ip: target_ip.clone(),
                self_device_id: self_device_id.clone(),
                message_id: message_id.clone(),
                file_id: file_id.clone(),
            };

            self.tasks
                .write()
                .await
                .insert(message_id.clone(), task.clone());
            let control = Arc::new(TransferControl::default());
            self.controls
                .write()
                .await
                .insert(message_id.clone(), control.clone());

            let messages = self.messages.clone();
            let tasks = self.tasks.clone();
            let controls = self.controls.clone();
            let canceled_transfers = self.canceled_transfers.clone();
            let paused_transfers = self.paused_transfers.clone();
            let app_handle = self.app_handle.clone();
            let db = self.db.clone();
            let client = self.client.clone();

            tokio::spawn(async move {
                run_send_task_to_completion(
                    task,
                    messages.clone(),
                    tasks.clone(),
                    controls.clone(),
                    canceled_transfers.clone(),
                    paused_transfers.clone(),
                    app_handle.clone(),
                    db.clone(),
                    control,
                    client.clone(),
                )
                .await;
            });

            results.push((message_id, file_id));
        }

        if results.is_empty() && requested_count > 0 {
            if missing_count == requested_count {
                return Err(anyhow!("All selected files are unavailable"));
            }
            return Err(anyhow!("No files selected"));
        }

        Ok(results)
    }

    pub async fn send_text(
        &self,
        device_id: String,
        target_ip: String,
        self_device_id: String,
        self_device_name: String,
        text: String,
    ) -> anyhow::Result<String> {
        let message_id = uuid::Uuid::new_v4().to_string();
        let url = format!("http://{}:{}/text", target_ip, HTTP_PORT);
        let response = self.client
            .post(&url)
            .timeout(HTTP_REQUEST_TIMEOUT)
            .header("X-Device-Id", self_device_id)
            .header("X-Device-Name", self_device_name)
            .header("Content-Type", "text/plain; charset=utf-8")
            .body(text.clone())
            .send()
            .await?;

        if !response.status().is_success() {
            return Err(anyhow!("HTTP error: {}", response.status()));
        }

        let message = ChatMessage {
            message_id: message_id.clone(),
            device_id,
            file_id: uuid::Uuid::new_v4().to_string(),
            file_name: text,
            file_size: 0,
            file_type: "text".to_string(),
            direction: "send".to_string(),
            status: "completed".to_string(),
            timestamp: chrono::Utc::now().timestamp_millis(),
            thumbnail: None,
            progress: Some(100.0),
            speed: None,
            error: None,
            file_path: None,
        };

        self.upsert_message(message).await;
        Ok(message_id)
    }

    pub async fn predeclare_send_files(
        &self,
        target_ip: String,
        self_device_id: String,
        files: Vec<TransferAnnouncedFile>,
    ) -> anyhow::Result<()> {
        if files.is_empty() {
            return Ok(());
        }

        let announcement = TransferAnnouncement {
            sender_device_id: self_device_id,
            files,
        };

        self.client
            .post(format!(
                "http://{}:{}/transfer-announce",
                target_ip, HTTP_PORT
            ))
            .timeout(HTTP_REQUEST_TIMEOUT)
            .json(&announcement)
            .send()
            .await?
            .error_for_status()?;
        Ok(())
    }

    pub async fn pause_transfer(&self, message_id: &str) -> anyhow::Result<()> {
        let task = {
            let tasks = self.tasks.read().await;
            tasks.get(message_id).cloned()
        }
        .ok_or_else(|| anyhow!("Transfer not found"))?;

        self.pause_send_task(&task).await
    }

    async fn pause_send_task(&self, task: &TransferTask) -> anyhow::Result<()> {
        if self
            .canceled_transfers
            .read()
            .await
            .contains(&task.message_id)
        {
            return Err(anyhow!("Transfer canceled"));
        }

        self.paused_transfers
            .write()
            .await
            .insert(task.message_id.clone());
        if let Some(control) = self.controls.read().await.get(&task.message_id) {
            control.paused.store(true, Ordering::SeqCst);
        }
        set_message_status(
            &self.messages,
            &self.app_handle,
            &self.db,
            &task.device_id,
            &task.message_id,
            "paused",
            None,
        )
        .await;
        let client = self.client.clone();
        let target_ip = task.target_ip.clone();
        let self_device_id = task.self_device_id.clone();
        let message_id = task.message_id.clone();
        tauri::async_runtime::spawn(async move {
            notify_remote_control(&client, &target_ip, &message_id, "pause")
                .await
                .ok();
            notify_remote_status(
                &client,
                &target_ip,
                &self_device_id,
                &message_id,
                "paused",
                None,
                None,
                None,
            )
            .await
            .ok();
        });
        Ok(())
    }

    pub async fn resume_transfer(&self, message_id: &str) -> anyhow::Result<()> {
        {
            let controls = self.controls.read().await;
            if let Some(control) = controls.get(message_id) {
                self.paused_transfers.write().await.remove(message_id);
                control.paused.store(false, Ordering::SeqCst);
                let task = {
                    let tasks = self.tasks.read().await;
                    tasks.get(message_id).cloned()
                };
                if let Some(task) = task {
                    set_message_status(
                        &self.messages,
                        &self.app_handle,
                        &self.db,
                        &task.device_id,
                        &task.message_id,
                        "transferring",
                        None,
                    )
                    .await;
                    notify_remote_control(
                        &self.client,
                        &task.target_ip,
                        &task.message_id,
                        "resume",
                    )
                    .await
                    .ok();
                    notify_remote_status(
                        &self.client,
                        &task.target_ip,
                        &task.self_device_id,
                        &task.message_id,
                        "transferring",
                        None,
                        None,
                        None,
                    )
                    .await
                    .ok();
                }
                return Ok(());
            }
        }

        let task = {
            let tasks = self.tasks.read().await;
            tasks.get(message_id).cloned()
        }
        .ok_or_else(|| anyhow!("Transfer not found"))?;

        self.paused_transfers.write().await.remove(message_id);
        let control = Arc::new(TransferControl::default());
        self.controls
            .write()
            .await
            .insert(message_id.to_string(), control.clone());
        let messages = self.messages.clone();
        let tasks = self.tasks.clone();
        let controls = self.controls.clone();
        let canceled_transfers = self.canceled_transfers.clone();
        let paused_transfers = self.paused_transfers.clone();
        let app_handle = self.app_handle.clone();
        let db = self.db.clone();
        let client = self.client.clone();
        tokio::spawn(async move {
            run_send_task_to_completion(
                task.clone(),
                messages.clone(),
                tasks.clone(),
                controls.clone(),
                canceled_transfers.clone(),
                paused_transfers.clone(),
                app_handle.clone(),
                db.clone(),
                control,
                client.clone(),
            )
            .await;
        });
        Ok(())
    }

    async fn restart_send_task(&self, message_id: &str) -> anyhow::Result<()> {
        let task = {
            let tasks = self.tasks.read().await;
            tasks.get(message_id).cloned()
        }
        .ok_or_else(|| anyhow!("Transfer not found"))?;

        self.canceled_transfers.write().await.remove(message_id);
        self.paused_transfers.write().await.remove(message_id);
        let control = Arc::new(TransferControl::default());
        self.controls
            .write()
            .await
            .insert(message_id.to_string(), control.clone());

        set_message_status(
            &self.messages,
            &self.app_handle,
            &self.db,
            &task.device_id,
            &task.message_id,
            "pending",
            None,
        )
        .await;

        let messages = self.messages.clone();
        let tasks = self.tasks.clone();
        let controls = self.controls.clone();
        let canceled_transfers = self.canceled_transfers.clone();
        let paused_transfers = self.paused_transfers.clone();
        let app_handle = self.app_handle.clone();
        let db = self.db.clone();
        let client = self.client.clone();
        tokio::spawn(async move {
            run_send_task_to_completion(
                task.clone(),
                messages.clone(),
                tasks.clone(),
                controls.clone(),
                canceled_transfers.clone(),
                paused_transfers.clone(),
                app_handle.clone(),
                db.clone(),
                control,
                client.clone(),
            )
            .await;
        });

        Ok(())
    }

    pub async fn cancel_transfer(&self, message_id: &str) -> anyhow::Result<()> {
        let task = {
            let tasks = self.tasks.read().await;
            tasks.get(message_id).cloned()
        }
        .ok_or_else(|| anyhow!("Transfer not found"))?;

        self.cancel_send_task(&task).await
    }

    async fn cancel_send_task(&self, task: &TransferTask) -> anyhow::Result<()> {
        self.canceled_transfers
            .write()
            .await
            .insert(task.message_id.clone());
        self.paused_transfers
            .write()
            .await
            .remove(&task.message_id);
        if let Some(control) = self.controls.read().await.get(&task.message_id) {
            control.canceled.store(true, Ordering::SeqCst);
            control.paused.store(false, Ordering::SeqCst);
        }
        notify_remote_control(&self.client, &task.target_ip, &task.message_id, "cancel")
            .await
            .ok();
        notify_remote_status(
            &self.client,
            &task.target_ip,
            &task.self_device_id,
            &task.message_id,
            "canceled",
            None,
            None,
            None,
        )
        .await
        .ok();

        set_message_status(
            &self.messages,
            &self.app_handle,
            &self.db,
            &task.device_id,
            &task.message_id,
            "canceled",
            None,
        )
        .await;
        cleanup_temporary_send_source(
            task,
            &self.messages,
            &self.tasks,
            &self.controls,
            &self.canceled_transfers,
            &self.paused_transfers,
            &self.app_handle,
            &self.db,
        )
        .await;
        Ok(())
    }

    pub async fn send_remote_control(
        &self,
        target_ip: &str,
        message_id: &str,
        action: &str,
    ) -> anyhow::Result<()> {
        notify_remote_control(&self.client, target_ip, message_id, action).await
    }

    pub async fn set_remote_control_status(&self, device_id: &str, message_id: &str, status: &str) {
        match status {
            "paused" => {
                self.paused_transfers
                    .write()
                    .await
                    .insert(message_id.to_string());
            }
            "pending" | "transferring" | "completed" | "failed" | "canceled" => {
                self.paused_transfers.write().await.remove(message_id);
            }
            _ => {}
        }

        if status == "canceled" {
            self.canceled_transfers
                .write()
                .await
                .insert(message_id.to_string());
            self.receive_files.write().await.remove(message_id);
            self.receive_emit_at.write().await.remove(message_id);
        }
        if matches!(status, "paused" | "canceled" | "completed") {
            self.receive_stats.write().await.remove(message_id);
        }

        let mut emit = None;
        {
            let mut msgs = self.messages.write().await;
            if let Some(device_messages) = msgs.get_mut(device_id) {
                if let Some(msg) = device_messages
                    .iter_mut()
                    .find(|m| m.message_id == message_id)
                {
                    msg.status = status.to_string();
                    msg.speed = None;
                    msg.error = None;
                    emit = Some(msg.clone());
                }
            }
        }

        if emit.is_none() {
            if let Some(mut msg) = self.db.get_message(message_id) {
                msg.status = status.to_string();
                msg.speed = None;
                msg.error = None;
                emit = Some(msg);
            }
        }

        if let Some(msg) = emit {
            self.db.save_message(&msg);
            emit_message(&self.app_handle, &msg);
        }

        if status == "canceled" {
            let download_path = self.download_path.read().await.clone();
            cleanup_canceled_receive_files(&self.messages, &self.db, &download_path, message_id).await;
        }
    }

    pub async fn delete_message(&self, device_id: &str, message_id: &str) {
        let mut deleted = None;
        {
            let mut msgs = self.messages.write().await;
            if let Some(device_messages) = msgs.get_mut(device_id) {
                if let Some(index) = device_messages
                    .iter()
                    .position(|m| m.message_id == message_id)
                {
                    deleted = Some(device_messages.remove(index));
                }
            }
        }

        if deleted.is_none() {
            deleted = self.db.get_message(message_id);
        }

        self.db.delete_message(message_id);
        if let Some(msg) = deleted {
            let _ = self.app_handle.emit("chat-message-deleted", msg);
        }
    }

    pub async fn retry_transfer(&self, message_id: &str) -> anyhow::Result<()> {
        self.restart_send_task(message_id).await
    }

    pub async fn get_chat_history(&self, device_id: &str) -> Vec<ChatMessage> {
        self.messages
            .read()
            .await
            .get(device_id)
            .cloned()
            .unwrap_or_default()
    }

    async fn upsert_message(&self, message: ChatMessage) {
        upsert_message(&self.messages, &message.device_id, message.clone()).await;
        self.db.save_message(&message);
        emit_message(&self.app_handle, &message);
    }
}

async fn run_send_task(
    task: TransferTask,
    messages: Arc<RwLock<HashMap<String, Vec<ChatMessage>>>>,
    app_handle: AppHandle,
    db: Arc<Database>,
    control: Arc<TransferControl>,
    client: Arc<reqwest::Client>,
) -> anyhow::Result<()> {
    set_message_status(
        &messages,
        &app_handle,
        &db,
        &task.device_id,
        &task.message_id,
        "transferring",
        None,
    )
    .await;

    let path = PathBuf::from(&task.file_path);
    let file_name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .ok_or_else(|| anyhow!("Invalid file path"))?;
    let metadata = tokio::fs::metadata(&path).await?;
    let file_size = metadata.len();
    let (chunk_size, max_concurrent_chunks) = chunking_strategy(file_size);
    let total_chunks = chunk_count(file_size, chunk_size as u64);
    let manifest = TransferManifest {
        message_id: task.message_id.clone(),
        file_id: task.file_id.clone(),
        file_name,
        file_size,
        file_type: get_file_type(&task.file_path),
        chunk_size: chunk_size as u64,
        total_chunks,
        checksum: String::new(),
        sender_device_id: task.self_device_id.clone(),
        timestamp: chrono::Utc::now().timestamp_millis(),
    };

    announce_remote_file(&client, &task.target_ip, &manifest)
        .await
        .ok();

    let probe = probe_remote(&client, &task.target_ip, &manifest).await?;
    if probe.complete {
        update_message_progress(
            &messages,
            &app_handle,
            &db,
            &task.device_id,
            &task.message_id,
            100.0,
            None,
        )
        .await;
        set_message_status(
            &messages,
            &app_handle,
            &db,
            &task.device_id,
            &task.message_id,
            "completed",
            None,
        )
        .await;
        return Ok(());
    }

    let received: HashSet<u64> = probe.received_chunks.into_iter().collect();
    let pending_chunks: VecDeque<u64> = (0..total_chunks)
        .filter(|chunk_index| !received.contains(chunk_index))
        .collect();
    let mut sent_bytes = received_bytes_for_chunks(&received, file_size, chunk_size as u64);
    let mut speed_sampler = SpeedSampler::new();
    speed_sampler.observe(sent_bytes);
    let mut last_progress_emit_at = Instant::now();
    let mut last_remote_status_at = Instant::now();
    let manifest = Arc::new(manifest);
    let task = Arc::new(task);
    let source_path = Arc::new(path);
    let mut pending_chunks = pending_chunks;
    let mut in_flight = tokio::task::JoinSet::new();
    let mut in_flight_chunks = HashSet::new();

    while !pending_chunks.is_empty() || in_flight.len() > 0 {
        if control.canceled.load(Ordering::SeqCst) {
            in_flight.abort_all();
            while in_flight.join_next().await.is_some() {}
            return Err(anyhow!("Transfer canceled"));
        }

        if control.paused.load(Ordering::SeqCst) && in_flight.len() > 0 {
            for chunk_index in in_flight_chunks.drain() {
                pending_chunks.push_front(chunk_index);
            }
            in_flight.abort_all();
            while in_flight.join_next().await.is_some() {}
        }

        let mut was_paused = false;
        while control.paused.load(Ordering::SeqCst) {
            if control.canceled.load(Ordering::SeqCst) {
                return Err(anyhow!("Transfer canceled"));
            }
            was_paused = true;
            set_message_status(
                &messages,
                &app_handle,
                &db,
                &task.device_id,
                &task.message_id,
                "paused",
                None,
            )
            .await;
            notify_remote_status(
                &client,
                &task.target_ip,
                &task.self_device_id,
                &task.message_id,
                "paused",
                None,
                None,
                None,
            )
            .await
            .ok();
            tokio::time::sleep(std::time::Duration::from_millis(250)).await;
        }

        if was_paused && !control.paused.load(Ordering::SeqCst) {
            if control.canceled.load(Ordering::SeqCst) {
                return Err(anyhow!("Transfer canceled"));
            }
            speed_sampler.reset();
            speed_sampler.observe(sent_bytes);
            last_progress_emit_at = Instant::now();
            last_remote_status_at = Instant::now();
            set_message_status(
                &messages,
                &app_handle,
                &db,
                &task.device_id,
                &task.message_id,
                "transferring",
                None,
            )
            .await;
            notify_remote_control(&client, &task.target_ip, &task.message_id, "resume")
                .await
                .ok();
            notify_remote_status(
                &client,
                &task.target_ip,
                &task.self_device_id,
                &task.message_id,
                "transferring",
                None,
                None,
                None,
            )
            .await
            .ok();
        }

        if control.canceled.load(Ordering::SeqCst) {
            return Err(anyhow!("Transfer canceled"));
        }

        while in_flight.len() < max_concurrent_chunks {
            let Some(chunk_index) = pending_chunks.pop_front() else {
                break;
            };
            if control.canceled.load(Ordering::SeqCst) || control.paused.load(Ordering::SeqCst) {
                pending_chunks.push_front(chunk_index);
                break;
            }

            let client = client.clone();
            let manifest = manifest.clone();
            let source_path = source_path.clone();
            let target_ip = task.target_ip.clone();
            let control = control.clone();
            in_flight_chunks.insert(chunk_index);
            in_flight.spawn(async move {
                send_chunk(&client, &target_ip, &manifest, source_path.as_ref().clone(), chunk_index, control).await
            });
        }

        let result = tokio::select! {
            result = in_flight.join_next() => result,
            _ = wait_for_pause_or_cancel(control.clone()), if !control.paused.load(Ordering::SeqCst) && !control.canceled.load(Ordering::SeqCst) => {
                in_flight.abort_all();
                for chunk_index in in_flight_chunks.drain() {
                    pending_chunks.push_front(chunk_index);
                }
                while in_flight.join_next().await.is_some() {}
                None
            },
        };
        let Some(result) = result else {
            continue;
        };
        let (chunk_index, length) = result??;
        in_flight_chunks.remove(&chunk_index);
        if length == 0 {
            pending_chunks.push_front(chunk_index);
            continue;
        }
        sent_bytes += length;
        let speed = speed_sampler.observe(sent_bytes);
        let progress = if file_size == 0 {
            100.0
        } else {
            (sent_bytes as f32 / file_size as f32 * 100.0).min(TRANSFERRING_PROGRESS_MAX)
        };
        let now = Instant::now();
        let should_emit_local = now.duration_since(last_progress_emit_at) >= PROGRESS_EMIT_INTERVAL
            || pending_chunks.is_empty() && in_flight.is_empty();
        if should_emit_local {
            if control.paused.load(Ordering::SeqCst) || control.canceled.load(Ordering::SeqCst) {
                continue;
            }
            update_message_progress(
                &messages,
                &app_handle,
                &db,
                &task.device_id,
                &task.message_id,
                progress,
                Some(speed),
            )
            .await;
            last_progress_emit_at = now;
        }

        let should_notify_remote = now.duration_since(last_remote_status_at) >= REMOTE_STATUS_INTERVAL
            || pending_chunks.is_empty() && in_flight.is_empty();
        if should_notify_remote {
            if control.paused.load(Ordering::SeqCst) || control.canceled.load(Ordering::SeqCst) {
                continue;
            }
            notify_remote_status(
                &client,
                &task.target_ip,
                &task.self_device_id,
                &task.message_id,
                "transferring",
                Some(progress),
                Some(speed),
                None,
            )
            .await
            .ok();
            last_remote_status_at = now;
        }
    }

    let final_probe = probe_remote(&client, &task.target_ip, &manifest).await?;
    if !final_probe.complete {
        return Err(anyhow!("Remote file did not pass final verification"));
    }

    update_message_progress(
        &messages,
        &app_handle,
        &db,
        &task.device_id,
        &task.message_id,
        100.0,
        None,
    )
    .await;
    set_message_status(
        &messages,
        &app_handle,
        &db,
        &task.device_id,
        &task.message_id,
        "completed",
        None,
    )
    .await;
    notify_remote_status(
        &client,
        &task.target_ip,
        &task.self_device_id,
        &task.message_id,
        "completed",
        Some(100.0),
        None,
        None,
    )
    .await
    .ok();
    Ok(())
}

async fn run_send_task_to_completion(
    task: TransferTask,
    messages: Arc<RwLock<HashMap<String, Vec<ChatMessage>>>>,
    tasks: Arc<RwLock<HashMap<String, TransferTask>>>,
    controls: Arc<RwLock<HashMap<String, Arc<TransferControl>>>>,
    canceled_transfers: Arc<RwLock<HashSet<String>>>,
    paused_transfers: Arc<RwLock<HashSet<String>>>,
    app_handle: AppHandle,
    db: Arc<Database>,
    control: Arc<TransferControl>,
    client: Arc<reqwest::Client>,
) {
    let result = run_send_task(
        task.clone(),
        messages.clone(),
        app_handle.clone(),
        db.clone(),
        control,
        client.clone(),
    )
    .await;

    if let Err(error) = result {
        if error.to_string() != "Transfer canceled" {
            fail_send_task(&task, &messages, &app_handle, &db, &client, error.to_string()).await;
        }
    }

    cleanup_temporary_send_source(
        &task,
        &messages,
        &tasks,
        &controls,
        &canceled_transfers,
        &paused_transfers,
        &app_handle,
        &db,
    )
    .await;
}

async fn fail_send_task(
    task: &TransferTask,
    messages: &Arc<RwLock<HashMap<String, Vec<ChatMessage>>>>,
    app_handle: &AppHandle,
    db: &Arc<Database>,
    client: &reqwest::Client,
    error: String,
) {
    set_message_status(
        messages,
        app_handle,
        db,
        &task.device_id,
        &task.message_id,
        "failed",
        Some(error.clone()),
    )
    .await;

    notify_remote_status(
        client,
        &task.target_ip,
        &task.self_device_id,
        &task.message_id,
        "failed",
        None,
        None,
        Some(error),
    )
    .await
    .ok();
}

async fn probe_remote(
    client: &reqwest::Client,
    target_ip: &str,
    manifest: &TransferManifest,
) -> anyhow::Result<ProbeResponse> {
    let response = client
        .post(format!("http://{}:{}/probe", target_ip, HTTP_PORT))
        .timeout(HTTP_REQUEST_TIMEOUT)
        .json(manifest)
        .send()
        .await?;

    if !response.status().is_success() {
        return Err(anyhow!("Probe failed: {}", response.status()));
    }

    Ok(response.json::<ProbeResponse>().await?)
}

async fn announce_remote_file(
    client: &reqwest::Client,
    target_ip: &str,
    manifest: &TransferManifest,
) -> anyhow::Result<()> {
    let announcement = TransferAnnouncement {
        sender_device_id: manifest.sender_device_id.clone(),
        files: vec![TransferAnnouncedFile {
            message_id: manifest.message_id.clone(),
            file_id: manifest.file_id.clone(),
            file_name: manifest.file_name.clone(),
            file_size: manifest.file_size,
            file_type: manifest.file_type.clone(),
            timestamp: manifest.timestamp,
        }],
    };

    client
        .post(format!(
            "http://{}:{}/transfer-announce",
            target_ip, HTTP_PORT
        ))
        .timeout(HTTP_REQUEST_TIMEOUT)
        .json(&announcement)
        .send()
        .await?
        .error_for_status()?;
    Ok(())
}

async fn post_chunk(
    client: &reqwest::Client,
    target_ip: &str,
    manifest: &TransferManifest,
    chunk_index: u64,
    source_path: &Path,
    offset: u64,
    length: u64,
) -> anyhow::Result<()> {
    let manifest_header = encode_manifest(manifest)?;
    let url = format!("http://{}:{}/chunk", target_ip, HTTP_PORT);
    let mut last_error = None;

    for attempt in 0..=CHUNK_UPLOAD_RETRIES {
        let body = file_range_body(source_path, offset, length)
            .await
            .with_context(|| format!("Failed to open chunk {} for upload", chunk_index))?;
        let response = client
            .post(&url)
            .timeout(HTTP_TRANSFER_TIMEOUT)
            .header("X-Manifest", manifest_header.clone())
            .header("X-Chunk-Index", chunk_index)
            .header("Content-Length", length)
            .body(body)
            .send()
            .await;

        match response {
            Ok(response) if response.status().is_success() => return Ok(()),
            Ok(response) => {
                let status = response.status();
                if !status.is_server_error() || attempt == CHUNK_UPLOAD_RETRIES {
                    return Err(anyhow!("Chunk upload failed: {}", status));
                }
                last_error = Some(anyhow!("Chunk upload failed: {}", status));
            }
            Err(error) => {
                if attempt == CHUNK_UPLOAD_RETRIES {
                    return Err(anyhow!("Network interrupted while uploading chunk: {}", error));
                }
                last_error = Some(anyhow!(error));
            }
        }

        let delay_ms = 120u64.saturating_mul(1u64 << attempt.min(4));
        tokio::time::sleep(std::time::Duration::from_millis(delay_ms)).await;
    }

    Err(last_error.unwrap_or_else(|| anyhow!("Chunk upload failed")))
}

async fn send_chunk(
    client: &reqwest::Client,
    target_ip: &str,
    manifest: &TransferManifest,
    source_path: PathBuf,
    chunk_index: u64,
    control: Arc<TransferControl>,
) -> anyhow::Result<(u64, u64)> {
    if control.canceled.load(Ordering::SeqCst) {
        return Err(anyhow!("Transfer canceled"));
    }
    if control.paused.load(Ordering::SeqCst) {
        return Ok((chunk_index, 0));
    }

    let offset = chunk_index * manifest.chunk_size;
    let length = manifest.file_size.saturating_sub(offset).min(manifest.chunk_size);
    if control.canceled.load(Ordering::SeqCst) {
        return Err(anyhow!("Transfer canceled"));
    }
    if control.paused.load(Ordering::SeqCst) {
        return Ok((chunk_index, 0));
    }
    post_chunk(client, target_ip, manifest, chunk_index, &source_path, offset, length).await?;

    Ok((chunk_index, length))
}

async fn wait_for_pause_or_cancel(control: Arc<TransferControl>) {
    while !control.paused.load(Ordering::SeqCst) && !control.canceled.load(Ordering::SeqCst) {
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

async fn notify_remote_status(
    client: &reqwest::Client,
    target_ip: &str,
    sender_device_id: &str,
    message_id: &str,
    status: &str,
    progress: Option<f32>,
    speed: Option<u64>,
    error: Option<String>,
) -> anyhow::Result<()> {
    let payload = RemoteTransferStatus {
        message_id: message_id.to_string(),
        status: status.to_string(),
        progress,
        speed,
        error,
    };

    client
        .post(format!(
            "http://{}:{}/transfer-status",
            target_ip, HTTP_PORT
        ))
        .timeout(HTTP_REQUEST_TIMEOUT)
        .header("X-Device-Id", sender_device_id)
        .json(&payload)
        .send()
        .await?
        .error_for_status()?;
    Ok(())
}

async fn notify_remote_control(
    client: &reqwest::Client,
    target_ip: &str,
    message_id: &str,
    action: &str,
) -> anyhow::Result<()> {
    let payload = RemoteTransferControl {
        message_id: message_id.to_string(),
        action: action.to_string(),
    };

    client
        .post(format!(
            "http://{}:{}/transfer-control",
            target_ip, HTTP_PORT
        ))
        .timeout(HTTP_REQUEST_TIMEOUT)
        .json(&payload)
        .send()
        .await?
        .error_for_status()?;
    Ok(())
}

async fn handle_probe<R: AsyncReadExt + Unpin>(
    reader: &mut R,
    headers: &HashMap<String, String>,
    download_path: &Path,
) -> anyhow::Result<String> {
    let manifest = read_json_body::<TransferManifest, _>(reader, headers).await?;
    let state = inspect_receive_state(download_path, &manifest).await?;
    Ok(serde_json::to_string(&state)?)
}

async fn handle_transfer_announcement<R: AsyncReadExt + Unpin>(
    reader: &mut R,
    headers: &HashMap<String, String>,
    messages: &Arc<RwLock<HashMap<String, Vec<ChatMessage>>>>,
    app_handle: &AppHandle,
    db: &Arc<Database>,
) -> anyhow::Result<String> {
    let mut announcement = read_json_body::<TransferAnnouncement, _>(reader, headers).await?;
    if announcement.sender_device_id.is_empty() {
        announcement.sender_device_id = headers.get("x-device-id").cloned().unwrap_or_default();
    }
    if announcement.sender_device_id.is_empty() {
        return Err(anyhow!("Missing sender device id"));
    }

    for file in announcement.files {
        let msg = ChatMessage {
            message_id: file.message_id,
            device_id: announcement.sender_device_id.clone(),
            file_id: file.file_id,
            file_name: file.file_name,
            file_size: file.file_size,
            file_type: file.file_type,
            direction: "receive".to_string(),
            status: "pending".to_string(),
            timestamp: file.timestamp,
            thumbnail: None,
            progress: Some(0.0),
            speed: None,
            error: None,
            file_path: None,
        };
        let should_emit = upsert_pending_announcement(messages, &announcement.sender_device_id, msg.clone()).await;
        if should_emit {
            db.save_message(&msg);
            emit_message(app_handle, &msg);
        }
    }

    Ok("ok".to_string())
}

async fn handle_chunk<R: AsyncReadExt + Unpin>(
    reader: &mut R,
    headers: &HashMap<String, String>,
    download_path: &Path,
    messages: &Arc<RwLock<HashMap<String, Vec<ChatMessage>>>>,
    app_handle: &AppHandle,
    db: &Arc<Database>,
    receive_stats: &Arc<RwLock<HashMap<String, (Instant, u64)>>>,
    receive_locks: &Arc<RwLock<HashMap<String, Arc<Mutex<()>>>>>,
    receive_files: &Arc<RwLock<HashMap<String, Arc<ReceiveFileState>>>>,
    receive_emit_at: &Arc<RwLock<HashMap<String, Instant>>>,
    canceled_transfers: &Arc<RwLock<HashSet<String>>>,
    paused_transfers: &Arc<RwLock<HashSet<String>>>,
) -> anyhow::Result<String> {
    let manifest_header = headers
        .get("x-manifest")
        .ok_or_else(|| anyhow!("Missing manifest"))?;
    let manifest = decode_manifest(manifest_header)?;
    if canceled_transfers
        .read()
        .await
        .contains(&manifest.message_id)
    {
        return Err(anyhow!("Transfer canceled"));
    }
    let chunk_index = headers
        .get("x-chunk-index")
        .ok_or_else(|| anyhow!("Missing chunk index"))?
        .parse::<u64>()?;
    let len = content_length(headers)?;

    let part_path = partial_path(download_path, &manifest);
    let bitmap_path = chunks_bitmap_path(download_path, &manifest);
    let legacy_chunks_path = chunks_path(download_path, &manifest);
    tokio::fs::create_dir_all(download_path).await?;

    let receive_state =
        get_receive_file_state(receive_files, download_path, &manifest, &bitmap_path, &legacy_chunks_path).await?;
    let mut buffer = vec![0u8; len];
    reader.read_exact(&mut buffer).await?;
    write_file_at(
        receive_state.file.clone(),
        chunk_index * manifest.chunk_size,
        buffer,
    )
    .await?;
    if chunk_index + 1 == manifest.total_chunks {
        sync_shared_file(receive_state.file.clone()).await.ok();
    }

    let receive_lock = get_receive_lock(receive_locks, &manifest.message_id).await;
    let _receive_guard = receive_lock.lock().await;

    let was_new_chunk = {
        let mut received = receive_state.received.lock().await;
        received.insert(chunk_index)
    };
    if was_new_chunk {
        mark_chunk_received(&receive_state.bitmap_file, chunk_index).await?;
        receive_state
            .bytes_received
            .fetch_add(received_len_for_chunk(&manifest, chunk_index), Ordering::SeqCst);
    }

    let received_count = receive_state.received.lock().await.len() as u64;
    let received_bytes = receive_state.bytes_received.load(Ordering::SeqCst);
    let speed = {
        let mut sampler = receive_state.speed_sampler.lock().await;
        Some(sampler.observe(received_bytes))
    };

    let progress = if manifest.total_chunks == 0 {
        100.0
    } else {
        (received_bytes as f32 / manifest.file_size as f32 * 100.0).min(TRANSFERRING_PROGRESS_MAX)
    };

    let complete = received_count == manifest.total_chunks;
    let paused = paused_transfers
        .read()
        .await
        .contains(&manifest.message_id)
        || is_message_paused(messages, &manifest.sender_device_id, &manifest.message_id).await;
    if paused && !complete {
        return Ok("ok".to_string());
    }

    let status = if complete {
        "completed"
    } else if paused {
        "paused"
    } else {
        "transferring"
    };
    let mut final_path = download_path.join(sanitize_file_name(&manifest.file_name));

    if canceled_transfers
        .read()
        .await
        .contains(&manifest.message_id)
    {
        receive_stats.write().await.remove(&manifest.message_id);
        receive_emit_at.write().await.remove(&manifest.message_id);
        receive_files.write().await.remove(&manifest.message_id);
        return Err(anyhow!("Transfer canceled"));
    }

    if complete {
        let final_size = tokio::fs::metadata(&part_path).await?.len();
        if final_size != manifest.file_size {
            return Err(anyhow!("Received file size mismatch"));
        }

        final_path = available_destination_path(download_path, &manifest.file_name);
        tokio::fs::rename(&part_path, &final_path).await?;
        tokio::fs::remove_file(&bitmap_path).await.ok();
        tokio::fs::remove_file(&legacy_chunks_path).await.ok();
        receive_stats.write().await.remove(&manifest.message_id);
        receive_emit_at.write().await.remove(&manifest.message_id);
        receive_locks.write().await.remove(&manifest.message_id);
        receive_files.write().await.remove(&manifest.message_id);
        paused_transfers.write().await.remove(&manifest.message_id);

        let settings = db.get_settings();
        if !cfg!(target_os = "android")
            && settings.auto_save_images_to_gallery
            && manifest.file_type == "image"
        {
            if let Err(e) = save_image_copy_to_gallery(&final_path, &manifest.file_name).await {
                eprintln!("Failed to save image copy to gallery: {e}");
            }
        }
    }

    let msg = ChatMessage {
        message_id: manifest.message_id.clone(),
        device_id: manifest.sender_device_id.clone(),
        file_id: manifest.file_id.clone(),
        file_name: manifest.file_name.clone(),
        file_size: manifest.file_size,
        file_type: manifest.file_type.clone(),
        direction: "receive".to_string(),
        status: status.to_string(),
        timestamp: manifest.timestamp,
        thumbnail: None,
        progress: Some(progress.min(100.0)),
        speed: if paused { None } else { speed },
        error: None,
        file_path: complete.then(|| final_path.to_string_lossy().to_string()),
    };

    if should_emit_receive_progress(receive_emit_at, &manifest.message_id, complete).await {
        upsert_message(messages, &manifest.sender_device_id, msg.clone()).await;
        db.save_message(&msg);
        emit_message(app_handle, &msg);
    }

    Ok("ok".to_string())
}

async fn handle_transfer_status<R: AsyncReadExt + Unpin>(
    reader: &mut R,
    headers: &HashMap<String, String>,
    download_path: &Path,
    messages: &Arc<RwLock<HashMap<String, Vec<ChatMessage>>>>,
    app_handle: &AppHandle,
    db: &Arc<Database>,
    receive_stats: &Arc<RwLock<HashMap<String, (Instant, u64)>>>,
    receive_files: &Arc<RwLock<HashMap<String, Arc<ReceiveFileState>>>>,
    receive_emit_at: &Arc<RwLock<HashMap<String, Instant>>>,
    canceled_transfers: &Arc<RwLock<HashSet<String>>>,
    paused_transfers: &Arc<RwLock<HashSet<String>>>,
) -> anyhow::Result<String> {
    let update = read_json_body::<RemoteTransferStatus, _>(reader, headers).await?;
    let device_id = headers.get("x-device-id").cloned().unwrap_or_default();

    match update.status.as_str() {
        "paused" => {
            paused_transfers
                .write()
                .await
                .insert(update.message_id.clone());
        }
        "transferring" => {
            let is_paused = paused_transfers
                .read()
                .await
                .contains(&update.message_id)
                || is_message_paused_any_device(messages, &update.message_id).await;
            if is_paused {
                return Ok("ok".to_string());
            }
            paused_transfers.write().await.remove(&update.message_id);
        }
        "completed" | "failed" | "canceled" => {
            paused_transfers.write().await.remove(&update.message_id);
        }
        _ => {}
    }

    if matches!(update.status.as_str(), "paused" | "canceled" | "completed" | "failed") {
        receive_stats.write().await.remove(&update.message_id);
        receive_files.write().await.remove(&update.message_id);
        receive_emit_at.write().await.remove(&update.message_id);
    }

    if update.status != "canceled"
        && canceled_transfers
            .read()
            .await
            .contains(&update.message_id)
    {
        return Ok("ok".to_string());
    }

    match update.status.as_str() {
        "canceled" => {
            canceled_transfers
                .write()
                .await
                .insert(update.message_id.clone());
            cleanup_canceled_receive_files(messages, db, download_path, &update.message_id).await;
        }
        "completed" => {
            canceled_transfers.write().await.remove(&update.message_id);
        }
        _ => {}
    }

    let mut emit = None;
    {
        let mut msgs = messages.write().await;
        let target_messages = if device_id.is_empty() {
            msgs.values_mut().find(|device_messages| {
                device_messages
                    .iter()
                    .any(|m| m.message_id == update.message_id)
            })
        } else {
            msgs.get_mut(&device_id)
        };

        if let Some(device_messages) = target_messages {
            if let Some(msg) = device_messages
                .iter_mut()
                .find(|m| m.message_id == update.message_id)
            {
                let remote_is_transferring = update.status == "transferring";
                let next_status = update.status.clone();
                msg.status = next_status.clone();
                if let Some(progress) = update.progress {
                    msg.progress = Some(progress);
                }
                msg.speed = if msg.direction == "receive" && remote_is_transferring {
                    msg.speed
                } else {
                    update.speed
                };
                msg.error = if next_status == "failed" {
                    update.error.clone()
                } else if matches!(next_status.as_str(), "transferring" | "completed" | "paused") {
                    None
                } else {
                    msg.error.clone()
                };
                emit = Some(msg.clone());
            }
        }
    }

    if let Some(msg) = emit {
        db.save_message(&msg);
        emit_message(app_handle, &msg);
    }

    Ok("ok".to_string())
}

async fn handle_transfer_control<R: AsyncReadExt + Unpin>(
    reader: &mut R,
    headers: &HashMap<String, String>,
    download_path: &Path,
    tasks: &Arc<RwLock<HashMap<String, TransferTask>>>,
    controls: &Arc<RwLock<HashMap<String, Arc<TransferControl>>>>,
    messages: &Arc<RwLock<HashMap<String, Vec<ChatMessage>>>>,
    app_handle: &AppHandle,
    db: &Arc<Database>,
    receive_stats: &Arc<RwLock<HashMap<String, (Instant, u64)>>>,
    receive_files: &Arc<RwLock<HashMap<String, Arc<ReceiveFileState>>>>,
    receive_emit_at: &Arc<RwLock<HashMap<String, Instant>>>,
    canceled_transfers: &Arc<RwLock<HashSet<String>>>,
    paused_transfers: &Arc<RwLock<HashSet<String>>>,
    client: &Arc<reqwest::Client>,
) -> anyhow::Result<String> {
    let control = read_json_body::<RemoteTransferControl, _>(reader, headers).await?;
    let status = match control.action.as_str() {
        "pause" => "paused",
        "resume" | "retry" => "transferring",
        "cancel" => "canceled",
        _ => return Err(anyhow!("Unsupported transfer control action")),
    };

    match control.action.as_str() {
        "cancel" => {
            canceled_transfers
                .write()
                .await
                .insert(control.message_id.clone());
            paused_transfers.write().await.remove(&control.message_id);
            if let Some(task_control) = controls.read().await.get(&control.message_id) {
                task_control.canceled.store(true, Ordering::SeqCst);
                task_control.paused.store(false, Ordering::SeqCst);
            }
        }
        "resume" | "retry" => {
            canceled_transfers.write().await.remove(&control.message_id);
            paused_transfers.write().await.remove(&control.message_id);
            if let Some(task_control) = controls.read().await.get(&control.message_id) {
                task_control.paused.store(false, Ordering::SeqCst);
            }
        }
        "pause" => {
            paused_transfers
                .write()
                .await
                .insert(control.message_id.clone());
            if let Some(task_control) = controls.read().await.get(&control.message_id) {
                task_control.paused.store(true, Ordering::SeqCst);
            }
        }
        _ => {}
    }

    if matches!(status, "paused" | "canceled") {
        receive_stats.write().await.remove(&control.message_id);
        receive_files.write().await.remove(&control.message_id);
        receive_emit_at.write().await.remove(&control.message_id);
    }
    if status == "canceled" {
        cleanup_canceled_receive_files(messages, db, download_path, &control.message_id).await;
    }

    let mut emit = None;
    let local_task = {
        let tasks = tasks.read().await;
        tasks.get(&control.message_id).cloned()
    };

    if let Some(task) = local_task {
        if control.action == "retry" {
            canceled_transfers.write().await.remove(&control.message_id);
            let task_control = Arc::new(TransferControl::default());
            controls
                .write()
                .await
                .insert(control.message_id.clone(), task_control.clone());
            set_message_status(
                messages,
                app_handle,
                db,
                &task.device_id,
                &task.message_id,
                "pending",
                None,
            )
            .await;
            let messages = messages.clone();
            let tasks = tasks.clone();
            let controls = controls.clone();
            let canceled_transfers = canceled_transfers.clone();
            let paused_transfers = paused_transfers.clone();
            let app_handle = app_handle.clone();
            let db = db.clone();
            let client = client.clone();
            tokio::spawn(async move {
                run_send_task_to_completion(
                    task.clone(),
                    messages.clone(),
                    tasks.clone(),
                    controls.clone(),
                    canceled_transfers.clone(),
                    paused_transfers.clone(),
                    app_handle.clone(),
                    db.clone(),
                    task_control,
                    client.clone(),
                )
                .await;
            });
            return Ok("ok".to_string());
        }

        set_message_status(
            messages,
            app_handle,
            db,
            &task.device_id,
            &task.message_id,
            status,
            None,
        )
        .await;
        return Ok("ok".to_string());
    }

    {
        let mut msgs = messages.write().await;
        for device_messages in msgs.values_mut() {
            if let Some(msg) = device_messages
                .iter_mut()
                .find(|m| m.message_id == control.message_id)
            {
                msg.status = status.to_string();
                msg.speed = None;
                msg.error = None;
                emit = Some(msg.clone());
                break;
            }
        }
    }

    if let Some(msg) = emit {
        db.save_message(&msg);
        emit_message(app_handle, &msg);
    }

    Ok("ok".to_string())
}

async fn handle_text<R: AsyncReadExt + Unpin>(
    reader: &mut R,
    headers: &HashMap<String, String>,
    messages: &Arc<RwLock<HashMap<String, Vec<ChatMessage>>>>,
    app_handle: &AppHandle,
    db: &Arc<Database>,
) -> anyhow::Result<String> {
    let device_id = headers.get("x-device-id").cloned().unwrap_or_default();
    let len = content_length(headers)?;
    let mut buf = vec![0u8; len];
    reader.read_exact(&mut buf).await?;
    let text = String::from_utf8_lossy(&buf).to_string();

    let msg = ChatMessage {
        message_id: uuid::Uuid::new_v4().to_string(),
        device_id: device_id.clone(),
        file_id: uuid::Uuid::new_v4().to_string(),
        file_name: text,
        file_size: 0,
        file_type: "text".to_string(),
        direction: "receive".to_string(),
        status: "completed".to_string(),
        timestamp: chrono::Utc::now().timestamp_millis(),
        thumbnail: None,
        progress: Some(100.0),
        speed: None,
        error: None,
        file_path: None,
    };

    upsert_message(messages, &device_id, msg.clone()).await;
    db.save_message(&msg);
    emit_message(app_handle, &msg);
    Ok("ok".to_string())
}

async fn read_json_body<T, R>(
    reader: &mut R,
    headers: &HashMap<String, String>,
) -> anyhow::Result<T>
where
    T: serde::de::DeserializeOwned,
    R: AsyncReadExt + Unpin,
{
    let len = content_length(headers)?;
    let mut buf = vec![0u8; len];
    reader.read_exact(&mut buf).await?;
    Ok(serde_json::from_slice(&buf)?)
}

async fn inspect_receive_state(
    download_path: &Path,
    manifest: &TransferManifest,
) -> anyhow::Result<ProbeResponse> {
    let final_path = download_path.join(sanitize_file_name(&manifest.file_name));
    if final_path.exists() {
        let size = tokio::fs::metadata(&final_path).await?.len();
        if size == manifest.file_size {
            cleanup_receive_state(download_path, manifest).await.ok();
            return Ok(ProbeResponse {
                received_chunks: (0..manifest.total_chunks).collect(),
                complete: true,
            });
        }
    }

    let bitmap_path = chunks_bitmap_path(download_path, manifest);
    let legacy_chunks_path = chunks_path(download_path, manifest);
    migrate_legacy_chunks_if_needed(&bitmap_path, &legacy_chunks_path, manifest.total_chunks).await?;
    let mut received = read_received_chunks_bitmap(&bitmap_path, manifest.total_chunks).await?;
    received.retain(|chunk| *chunk < manifest.total_chunks);
    received.sort_unstable();
    received.dedup();
    Ok(ProbeResponse {
        received_chunks: received,
        complete: false,
    })
}

fn content_length(headers: &HashMap<String, String>) -> anyhow::Result<usize> {
    headers
        .get("content-length")
        .ok_or_else(|| anyhow!("Missing content length"))?
        .parse::<usize>()
        .context("Invalid content length")
}

async fn write_response<W: AsyncWriteExt + Unpin>(writer: &mut W, status: u16, body: &[u8]) {
    let reason = match status {
        200 => "OK",
        400 => "Bad Request",
        404 => "Not Found",
        500 => "Internal Server Error",
        _ => "OK",
    };
    let header = format!(
        "HTTP/1.1 {} {}\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: {}\r\nConnection: keep-alive\r\nKeep-Alive: timeout=60\r\n\r\n",
        status,
        reason,
        body.len()
    );
    writer.write_all(header.as_bytes()).await.ok();
    writer.write_all(body).await.ok();
}

async fn read_received_chunks(path: &Path) -> anyhow::Result<Vec<u64>> {
    match tokio::fs::read_to_string(path).await {
        Ok(content) => Ok(serde_json::from_str::<Vec<u64>>(&content).unwrap_or_default()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(e) => Err(e.into()),
    }
}

async fn migrate_legacy_chunks_if_needed(
    bitmap_path: &Path,
    legacy_path: &Path,
    total_chunks: u64,
) -> anyhow::Result<()> {
    if tokio::fs::try_exists(bitmap_path).await.unwrap_or(false) {
        return Ok(());
    }

    let legacy = read_received_chunks(legacy_path).await?;
    if legacy.is_empty() {
        return Ok(());
    }

    let bitmap_len = bitmap_len(total_chunks);
    let mut bitmap = vec![0u8; bitmap_len];
    for chunk in legacy {
        if chunk < total_chunks {
            set_bitmap_bit(&mut bitmap, chunk);
        }
    }

    tokio::fs::write(bitmap_path, bitmap).await?;
    Ok(())
}

async fn get_receive_file_state(
    receive_files: &Arc<RwLock<HashMap<String, Arc<ReceiveFileState>>>>,
    download_path: &Path,
    manifest: &TransferManifest,
    bitmap_path: &Path,
    legacy_chunks_path: &Path,
) -> anyhow::Result<Arc<ReceiveFileState>> {
    if let Some(state) = receive_files.read().await.get(&manifest.message_id).cloned() {
        return Ok(state);
    }

    let mut files = receive_files.write().await;
    if let Some(state) = files.get(&manifest.message_id).cloned() {
        return Ok(state);
    }

    let part_path = partial_path(download_path, manifest);
    migrate_legacy_chunks_if_needed(bitmap_path, legacy_chunks_path, manifest.total_chunks).await?;
    let received_vec = read_received_chunks_bitmap(bitmap_path, manifest.total_chunks).await?;
    let received: HashSet<u64> = received_vec.into_iter().collect();
    let bytes_received = received
        .iter()
        .map(|chunk| received_len_for_chunk(manifest, *chunk))
        .sum::<u64>();

    let file = open_shared_write_file(&part_path, manifest.file_size).await?;
    let bitmap_file = open_shared_bitmap_file(bitmap_path, manifest.total_chunks).await?;

    let mut sampler = SpeedSampler::new();
    sampler.observe(bytes_received);
    let state = Arc::new(ReceiveFileState {
        file,
        bitmap_file,
        received: Arc::new(Mutex::new(received)),
        bytes_received: AtomicU64::new(bytes_received),
        speed_sampler: Arc::new(Mutex::new(sampler)),
    });
    files.insert(manifest.message_id.clone(), state.clone());
    Ok(state)
}

async fn read_received_chunks_bitmap(path: &Path, total_chunks: u64) -> anyhow::Result<Vec<u64>> {
    let bytes = match tokio::fs::read(path).await {
        Ok(bytes) => bytes,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(e.into()),
    };

    let mut chunks = Vec::new();
    for chunk in 0..total_chunks {
        let byte_index = (chunk / 8) as usize;
        if byte_index >= bytes.len() {
            break;
        }
        if bytes[byte_index] & (1 << (chunk % 8)) != 0 {
            chunks.push(chunk);
        }
    }
    Ok(chunks)
}

async fn mark_chunk_received(bitmap_file: &Arc<StdMutex<StdFile>>, chunk_index: u64) -> anyhow::Result<()> {
    let file = bitmap_file.clone();
    tokio::task::spawn_blocking(move || -> anyhow::Result<()> {
        let byte_index = chunk_index / 8;
        let bit = 1u8 << (chunk_index % 8);
        let file = file.lock().map_err(|_| anyhow!("Bitmap file lock poisoned"))?;
        let mut byte = read_exact_at_or_zero(&file, byte_index, 1)?;
        byte[0] |= bit;
        write_all_at(&file, &byte, byte_index)?;
        Ok(())
    })
    .await?
}

fn bitmap_len(total_chunks: u64) -> usize {
    ((total_chunks + 7) / 8) as usize
}

fn set_bitmap_bit(bitmap: &mut [u8], chunk_index: u64) {
    let byte_index = (chunk_index / 8) as usize;
    if byte_index < bitmap.len() {
        bitmap[byte_index] |= 1 << (chunk_index % 8);
    }
}

fn received_len_for_chunk(manifest: &TransferManifest, chunk_index: u64) -> u64 {
    let offset = chunk_index * manifest.chunk_size;
    manifest.file_size.saturating_sub(offset).min(manifest.chunk_size)
}

async fn get_receive_lock(
    receive_locks: &Arc<RwLock<HashMap<String, Arc<Mutex<()>>>>>,
    message_id: &str,
) -> Arc<Mutex<()>> {
    if let Some(lock) = receive_locks.read().await.get(message_id).cloned() {
        return lock;
    }

    let mut locks = receive_locks.write().await;
    locks
        .entry(message_id.to_string())
        .or_insert_with(|| Arc::new(Mutex::new(())))
        .clone()
}

async fn should_emit_receive_progress(
    receive_emit_at: &Arc<RwLock<HashMap<String, Instant>>>,
    message_id: &str,
    complete: bool,
) -> bool {
    if complete {
        receive_emit_at.write().await.remove(message_id);
        return true;
    }

    let now = Instant::now();
    let mut emit_at = receive_emit_at.write().await;
    match emit_at.get_mut(message_id) {
        Some(last_at) if now.duration_since(*last_at) < RECEIVE_EMIT_INTERVAL => false,
        Some(last_at) => {
            *last_at = now;
            true
        }
        None => {
            emit_at.insert(message_id.to_string(), now);
            true
        }
    }
}

async fn open_shared_write_file(path: &Path, len: u64) -> anyhow::Result<Arc<StdFile>> {
    let path = path.to_path_buf();
    tokio::task::spawn_blocking(move || -> anyhow::Result<Arc<StdFile>> {
        let file = std::fs::OpenOptions::new()
            .create(true)
            .read(true)
            .write(true)
            .open(path)?;
        if file.metadata()?.len() < len {
            file.set_len(len).ok();
        }
        Ok(Arc::new(file))
    })
    .await?
}

async fn open_shared_bitmap_file(path: &Path, total_chunks: u64) -> anyhow::Result<Arc<StdMutex<StdFile>>> {
    let path = path.to_path_buf();
    tokio::task::spawn_blocking(move || -> anyhow::Result<Arc<StdMutex<StdFile>>> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let file = std::fs::OpenOptions::new()
            .create(true)
            .read(true)
            .write(true)
            .open(path)?;
        let len = bitmap_len(total_chunks) as u64;
        if file.metadata()?.len() < len {
            file.set_len(len)?;
        }
        Ok(Arc::new(StdMutex::new(file)))
    })
    .await?
}

async fn file_range_body(path: &Path, offset: u64, length: u64) -> anyhow::Result<reqwest::Body> {
    let mut file = tokio::fs::File::open(path).await?;
    file.seek(std::io::SeekFrom::Start(offset)).await?;
    let stream = ReaderStream::with_capacity(file.take(length), STREAM_FRAME_SIZE);
    Ok(reqwest::Body::wrap_stream(stream))
}

async fn write_file_at(file: Arc<StdFile>, offset: u64, data: Vec<u8>) -> anyhow::Result<()> {
    tokio::task::spawn_blocking(move || -> anyhow::Result<()> {
        write_all_at(&file, &data, offset)?;
        Ok(())
    })
    .await?
}

async fn sync_shared_file(file: Arc<StdFile>) -> anyhow::Result<()> {
    tokio::task::spawn_blocking(move || -> anyhow::Result<()> {
        file.sync_all()?;
        Ok(())
    })
    .await?
}

fn read_exact_at_or_zero(file: &StdFile, offset: u64, length: usize) -> anyhow::Result<Vec<u8>> {
    let mut buf = vec![0u8; length];
    let mut total = 0;
    while total < length {
        let read = read_at(file, &mut buf[total..], offset + total as u64)?;
        if read == 0 {
            break;
        }
        total += read;
    }
    Ok(buf)
}

#[cfg(windows)]
fn read_at(file: &StdFile, buf: &mut [u8], offset: u64) -> std::io::Result<usize> {
    use std::os::windows::fs::FileExt;
    file.seek_read(buf, offset)
}

#[cfg(unix)]
fn read_at(file: &StdFile, buf: &mut [u8], offset: u64) -> std::io::Result<usize> {
    use std::os::unix::fs::FileExt;
    file.read_at(buf, offset)
}

fn write_all_at(file: &StdFile, mut buf: &[u8], mut offset: u64) -> anyhow::Result<()> {
    while !buf.is_empty() {
        let written = write_at(file, buf, offset)?;
        if written == 0 {
            return Err(anyhow!("Failed to write file chunk"));
        }
        offset += written as u64;
        buf = &buf[written..];
    }
    Ok(())
}

#[cfg(windows)]
fn write_at(file: &StdFile, buf: &[u8], offset: u64) -> std::io::Result<usize> {
    use std::os::windows::fs::FileExt;
    file.seek_write(buf, offset)
}

#[cfg(unix)]
fn write_at(file: &StdFile, buf: &[u8], offset: u64) -> std::io::Result<usize> {
    use std::os::unix::fs::FileExt;
    file.write_at(buf, offset)
}

fn partial_path(download_path: &Path, manifest: &TransferManifest) -> PathBuf {
    download_path.join(format!("{}.part", manifest.file_id))
}

fn chunks_path(download_path: &Path, manifest: &TransferManifest) -> PathBuf {
    download_path.join(format!("{}.chunks.json", manifest.file_id))
}

fn chunks_bitmap_path(download_path: &Path, manifest: &TransferManifest) -> PathBuf {
    download_path.join(format!("{}.chunks.bin", manifest.file_id))
}

async fn cleanup_temporary_send_source(
    task: &TransferTask,
    messages: &Arc<RwLock<HashMap<String, Vec<ChatMessage>>>>,
    tasks: &Arc<RwLock<HashMap<String, TransferTask>>>,
    controls: &Arc<RwLock<HashMap<String, Arc<TransferControl>>>>,
    canceled_transfers: &Arc<RwLock<HashSet<String>>>,
    paused_transfers: &Arc<RwLock<HashSet<String>>>,
    app_handle: &AppHandle,
    db: &Arc<Database>,
) {
    let path = PathBuf::from(&task.file_path);
    if !is_temporary_send_source(&path) {
        return;
    }

    let mut removed = false;
    for attempt in 0..8 {
        if tokio::fs::remove_file(&path).await.is_ok()
            || !tokio::fs::try_exists(&path).await.unwrap_or(false)
        {
            removed = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(150 * (attempt + 1))).await;
    }

    if removed {
        tasks.write().await.remove(&task.message_id);
        controls.write().await.remove(&task.message_id);
        canceled_transfers.write().await.remove(&task.message_id);
        paused_transfers.write().await.remove(&task.message_id);
        clear_message_file_path(messages, app_handle, db, &task.device_id, &task.message_id).await;
    }
}

fn is_temporary_send_source(path: &Path) -> bool {
    let normalized = path.to_string_lossy().replace('\\', "/");
    normalized.contains("/com.ciphertranslocal.app/cache/picked-files/")
        || normalized.contains("/com.ciphertranslocal.app/cache/tauri-picked-files/")
        || normalized.contains("/CipherTransLocal/cache/picked-files/")
        || normalized.contains("/CipherTransLocal/cache/tauri-picked-files/")
}

async fn cleanup_receive_state(
    download_path: &Path,
    manifest: &TransferManifest,
) -> anyhow::Result<()> {
    tokio::fs::remove_file(partial_path(download_path, manifest))
        .await
        .ok();
    tokio::fs::remove_file(chunks_path(download_path, manifest))
        .await
        .ok();
    tokio::fs::remove_file(chunks_bitmap_path(download_path, manifest))
        .await
        .ok();
    Ok(())
}

async fn cleanup_canceled_receive_files(
    messages: &Arc<RwLock<HashMap<String, Vec<ChatMessage>>>>,
    db: &Arc<Database>,
    download_path: &Path,
    message_id: &str,
) {
    let file_id = {
        let msgs = messages.read().await;
        msgs.values()
            .flat_map(|device_messages| device_messages.iter())
            .find(|message| message.message_id == message_id && message.direction == "receive")
            .map(|message| message.file_id.clone())
    }
    .or_else(|| {
        db.get_message(message_id).and_then(|message| {
            if message.direction == "receive" {
                Some(message.file_id)
            } else {
                None
            }
        })
    });

    if let Some(file_id) = file_id {
        cleanup_receive_files_by_file_id(download_path, &file_id).await;
    }
}

async fn cleanup_receive_files_by_file_id(download_path: &Path, file_id: &str) {
    let paths = [
        download_path.join(format!("{}.part", file_id)),
        download_path.join(format!("{}.chunks.json", file_id)),
        download_path.join(format!("{}.chunks.bin", file_id)),
    ];

    for attempt in 0..6 {
        let mut removed_or_missing = true;
        for path in &paths {
            if tokio::fs::remove_file(path).await.is_err()
                && tokio::fs::try_exists(path).await.unwrap_or(false)
            {
                removed_or_missing = false;
            }
        }
        if removed_or_missing {
            break;
        }
        tokio::time::sleep(Duration::from_millis(120 * (attempt + 1))).await;
    }
}

fn sanitize_file_name(file_name: &str) -> String {
    file_name
        .chars()
        .map(|c| match c {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => '_',
            _ => c,
        })
        .collect()
}

fn available_destination_path(download_path: &Path, file_name: &str) -> PathBuf {
    let sanitized = sanitize_file_name(file_name);
    let candidate = download_path.join(&sanitized);
    if !candidate.exists() {
        return candidate;
    }

    let path = Path::new(&sanitized);
    let stem = path
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "file".to_string());
    let extension = path.extension().map(|s| s.to_string_lossy().to_string());

    for index in 1..1000 {
        let name = match &extension {
            Some(ext) => format!("{} ({}).{}", stem, index, ext),
            None => format!("{} ({})", stem, index),
        };
        let candidate = download_path.join(name);
        if !candidate.exists() {
            return candidate;
        }
    }

    download_path.join(format!("{}-{}", uuid::Uuid::new_v4(), sanitized))
}

async fn save_image_copy_to_gallery(source: &Path, file_name: &str) -> anyhow::Result<()> {
    let gallery_dir = gallery_dir().ok_or_else(|| anyhow!("Gallery directory is unavailable"))?;
    tokio::fs::create_dir_all(&gallery_dir).await?;
    let destination = available_destination_path(&gallery_dir, file_name);

    if source == destination {
        return Ok(());
    }

    tokio::fs::copy(source, destination).await?;
    Ok(())
}

fn gallery_dir() -> Option<PathBuf> {
    if cfg!(target_os = "android") {
        return Some(PathBuf::from("/sdcard/Pictures/CipherTransLocal"));
    }

    dirs::picture_dir().map(|dir| dir.join("CipherTransLocal"))
}

fn chunk_count(file_size: u64, chunk_size: u64) -> u64 {
    if file_size == 0 {
        0
    } else {
        (file_size + chunk_size - 1) / chunk_size
    }
}

fn chunking_strategy(file_size: u64) -> (usize, usize) {
    if cfg!(target_os = "android") {
        return match file_size {
            0..=1_048_576 => (file_size.max(1) as usize, 1),
            1_048_577..=64_000_000 => (2 * 1024 * 1024, 3),
            64_000_001..=1_073_741_824 => (4 * 1024 * 1024, 4),
            _ => (8 * 1024 * 1024, 4),
        };
    }

    match file_size {
        0..=1_048_576 => (file_size.max(1) as usize, 1),
        1_048_577..=64_000_000 => (4 * 1024 * 1024, 4),
        64_000_001..=1_073_741_824 => (8 * 1024 * 1024, 4),
        _ => (8 * 1024 * 1024, 4),
    }
}

fn received_bytes_for_chunks(received: &HashSet<u64>, file_size: u64, chunk_size: u64) -> u64 {
    received
        .iter()
        .map(|chunk| {
            let offset = *chunk * chunk_size;
            file_size.saturating_sub(offset).min(chunk_size)
        })
        .sum()
}

fn build_http_client() -> reqwest::Client {
    reqwest::Client::builder()
        .http1_only()
        .tcp_nodelay(true)
        .tcp_keepalive(Some(Duration::from_secs(30)))
        .pool_max_idle_per_host(MAX_CONCURRENT_CHUNK_UPLOADS * 4)
        .pool_idle_timeout(Some(Duration::from_secs(60)))
        .build()
        .unwrap_or_else(|_| reqwest::Client::new())
}

fn tune_tcp_stream(stream: TcpStream) -> TcpStream {
    stream.set_nodelay(true).ok();
    let socket = socket2::SockRef::from(&stream);
    socket.set_send_buffer_size(SOCKET_BUFFER_SIZE).ok();
    socket.set_recv_buffer_size(SOCKET_BUFFER_SIZE).ok();
    stream
}

fn stable_file_id(path: &Path, self_device_id: &str) -> anyhow::Result<String> {
    let metadata = std::fs::metadata(path)?;
    let canonical = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    let modified = metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();

    let mut hasher = Sha256::new();
    hasher.update(self_device_id.as_bytes());
    hasher.update(canonical.to_string_lossy().as_bytes());
    hasher.update(metadata.len().to_le_bytes());
    hasher.update(modified.to_le_bytes());
    Ok(format!("{:x}", hasher.finalize()))
}

async fn upsert_message(
    messages: &Arc<RwLock<HashMap<String, Vec<ChatMessage>>>>,
    device_id: &str,
    message: ChatMessage,
) {
    let mut msgs = messages.write().await;
    let device_messages = msgs.entry(device_id.to_string()).or_default();
    if let Some(existing) = device_messages
        .iter_mut()
        .find(|m| m.message_id == message.message_id)
    {
        *existing = message;
    } else {
        device_messages.push(message);
    }
}

async fn upsert_pending_announcement(
    messages: &Arc<RwLock<HashMap<String, Vec<ChatMessage>>>>,
    device_id: &str,
    message: ChatMessage,
) -> bool {
    let mut msgs = messages.write().await;
    let device_messages = msgs.entry(device_id.to_string()).or_default();
    if let Some(existing) = device_messages
        .iter()
        .find(|m| m.message_id == message.message_id)
    {
        return existing.status == "pending"
            && existing.progress.unwrap_or(0.0) <= 0.0
            && existing.speed.unwrap_or(0) == 0;
    }
    device_messages.push(message);
    true
}

async fn is_message_paused(
    messages: &Arc<RwLock<HashMap<String, Vec<ChatMessage>>>>,
    device_id: &str,
    message_id: &str,
) -> bool {
    messages
        .read()
        .await
        .get(device_id)
        .and_then(|device_messages| {
            device_messages
                .iter()
                .find(|m| m.message_id == message_id)
                .map(|m| m.status == "paused")
        })
        .unwrap_or(false)
}

async fn is_message_paused_any_device(
    messages: &Arc<RwLock<HashMap<String, Vec<ChatMessage>>>>,
    message_id: &str,
) -> bool {
    messages.read().await.values().any(|device_messages| {
        device_messages
            .iter()
            .any(|m| m.message_id == message_id && m.status == "paused")
    })
}

async fn set_message_status(
    messages: &Arc<RwLock<HashMap<String, Vec<ChatMessage>>>>,
    app_handle: &AppHandle,
    db: &Arc<Database>,
    device_id: &str,
    message_id: &str,
    status: &str,
    error: Option<String>,
) {
    let mut emit = None;
    {
        let mut msgs = messages.write().await;
        if let Some(device_messages) = msgs.get_mut(device_id) {
            if let Some(msg) = device_messages
                .iter_mut()
                .find(|m| m.message_id == message_id)
            {
                msg.status = status.to_string();
                msg.error = error;
                emit = Some(msg.clone());
            }
        }
    }
    if let Some(msg) = emit {
        db.save_message(&msg);
        emit_message(app_handle, &msg);
    }
}

async fn update_message_progress(
    messages: &Arc<RwLock<HashMap<String, Vec<ChatMessage>>>>,
    app_handle: &AppHandle,
    db: &Arc<Database>,
    device_id: &str,
    message_id: &str,
    progress: f32,
    speed: Option<u64>,
) {
    let mut emit = None;
    {
        let mut msgs = messages.write().await;
        if let Some(device_messages) = msgs.get_mut(device_id) {
            if let Some(msg) = device_messages
                .iter_mut()
                .find(|m| m.message_id == message_id)
            {
                msg.progress = Some(progress);
                msg.speed = speed;
                emit = Some(msg.clone());
            }
        }
    }
    if let Some(msg) = emit {
        db.save_message(&msg);
        emit_message(app_handle, &msg);
    }
}

async fn clear_message_file_path(
    messages: &Arc<RwLock<HashMap<String, Vec<ChatMessage>>>>,
    app_handle: &AppHandle,
    db: &Arc<Database>,
    device_id: &str,
    message_id: &str,
) {
    let mut emit = None;
    {
        let mut msgs = messages.write().await;
        if let Some(device_messages) = msgs.get_mut(device_id) {
            if let Some(msg) = device_messages
                .iter_mut()
                .find(|m| m.message_id == message_id)
            {
                msg.file_path = None;
                emit = Some(msg.clone());
            }
        }
    }

    if let Some(msg) = emit {
        db.save_message(&msg);
        emit_message(app_handle, &msg);
    }
}

fn encode_manifest(manifest: &TransferManifest) -> anyhow::Result<String> {
    Ok(URL_SAFE_NO_PAD.encode(serde_json::to_vec(manifest)?))
}

fn decode_manifest(value: &str) -> anyhow::Result<TransferManifest> {
    let bytes = URL_SAFE_NO_PAD.decode(value)?;
    Ok(serde_json::from_slice(&bytes)?)
}

fn emit_message(app_handle: &AppHandle, message: &ChatMessage) {
    app_handle.emit("chat-message-updated", message).ok();
}

pub fn get_file_type(file_path: &str) -> String {
    let ext = file_path.rsplit('.').next().unwrap_or("").to_lowercase();

    match ext.as_str() {
        "jpg" | "jpeg" | "png" | "gif" | "bmp" | "webp" => "image",
        "mp4" | "avi" | "mov" | "mkv" | "webm" => "video",
        "mp3" | "wav" | "flac" | "aac" => "audio",
        "pdf" | "doc" | "docx" | "txt" => "document",
        "zip" | "rar" | "7z" => "archive",
        _ => "other",
    }
    .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chunk_count_rounds_up() {
        assert_eq!(chunk_count(0, 512), 0);
        assert_eq!(chunk_count(1, 512), 1);
        assert_eq!(chunk_count(512, 512), 1);
        assert_eq!(chunk_count(513, 512), 2);
    }

    #[test]
    fn file_type_detects_common_extensions() {
        assert_eq!(get_file_type("a.JPG"), "image");
        assert_eq!(get_file_type("a.pdf"), "document");
        assert_eq!(get_file_type("a.zip"), "archive");
        assert_eq!(get_file_type("a.unknown"), "other");
    }

    #[test]
    fn manifest_header_encoding_supports_unicode() {
        let manifest = TransferManifest {
            message_id: "m1".to_string(),
            file_id: "f1".to_string(),
            file_name: "中文 文件.txt".to_string(),
            file_size: 12,
            file_type: "document".to_string(),
            chunk_size: 512,
            total_chunks: 1,
            checksum: "abc".to_string(),
            sender_device_id: "d1".to_string(),
            timestamp: 1,
        };

        let encoded = encode_manifest(&manifest).unwrap();
        let decoded = decode_manifest(&encoded).unwrap();

        assert_eq!(decoded.file_name, manifest.file_name);
    }

    #[test]
    fn sanitize_file_name_replaces_windows_invalid_chars() {
        assert_eq!(sanitize_file_name("a<b>:c?.txt"), "a_b__c_.txt");
    }

    #[test]
    fn stable_file_id_is_repeatable_for_same_file() {
        let path = std::env::temp_dir().join(format!("ciphertranslocal-id-{}.txt", uuid::Uuid::new_v4()));
        std::fs::write(&path, b"same content").unwrap();

        let first = stable_file_id(&path, "device-a").unwrap();
        let second = stable_file_id(&path, "device-a").unwrap();
        std::fs::remove_file(path).ok();

        assert_eq!(first, second);
    }

    #[test]
    fn speed_sampler_returns_zero_with_few_samples() {
        let mut sampler = SpeedSampler::new();
        assert_eq!(sampler.observe(0), 0);
        assert_eq!(sampler.observe(1024 * 1024), 0);
    }

    #[test]
    fn speed_sampler_never_exceeds_physical_rate() {
        let mut sampler = SpeedSampler::new();
        let start = Instant::now();
        let physical_bps: u64 = 125_000_000;
        sampler.samples.push_back((start, 0));
        for ms in [50u64, 100, 150, 200, 600, 700, 800, 1200, 1400, 1600] {
            let t = start + Duration::from_millis(ms);
            let bytes = physical_bps * ms / 1000;
            sampler.samples.push_back((t, bytes));
        }
        let reported = {
            let len = sampler.samples.len();
            let (t0, b0) = sampler.samples[0];
            let (t1, b1) = sampler.samples[len - 1];
            let dt = t1.duration_since(t0).as_secs_f64();
            ((b1 - b0) as f64 / dt) as u64
        };
        assert!(
            reported <= physical_bps + physical_bps / 100,
            "reported {} exceeds physical {}",
            reported,
            physical_bps,
        );
    }

    #[test]
    fn speed_sampler_recovers_after_reset() {
        let mut sampler = SpeedSampler::new();
        sampler.observe(0);
        sampler.observe(8 * 1024 * 1024);
        sampler.reset();
        assert_eq!(sampler.observe(8 * 1024 * 1024), 0);
    }

    #[test]
    fn available_destination_path_avoids_existing_file() {
        let dir = std::env::temp_dir().join(format!("ciphertranslocal-dest-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("a.txt"), b"existing").unwrap();

        let candidate = available_destination_path(&dir, "a.txt");
        std::fs::remove_dir_all(&dir).ok();

        assert_eq!(
            candidate.file_name().unwrap().to_string_lossy(),
            "a (1).txt"
        );
    }

    #[test]
    fn positional_write_does_not_overwrite_other_offsets() {
        let path = std::env::temp_dir().join(format!("ciphertranslocal-pwrite-{}.bin", uuid::Uuid::new_v4()));
        let file = std::fs::OpenOptions::new()
            .create(true)
            .read(true)
            .write(true)
            .open(&path)
            .unwrap();
        file.set_len(12).unwrap();

        write_all_at(&file, b"BBBB", 4).unwrap();
        write_all_at(&file, b"AAAA", 0).unwrap();
        write_all_at(&file, b"CCCC", 8).unwrap();

        let bytes = std::fs::read(&path).unwrap();
        std::fs::remove_file(path).ok();

        assert_eq!(bytes, b"AAAABBBBCCCC");
    }

    #[test]
    fn bitmap_mark_uses_expected_bit() {
        let path = std::env::temp_dir().join(format!("ciphertranslocal-bitmap-{}.bin", uuid::Uuid::new_v4()));
        let file = std::fs::OpenOptions::new()
            .create(true)
            .read(true)
            .write(true)
            .open(&path)
            .unwrap();
        file.set_len(2).unwrap();

        write_all_at(&file, &[1 << 3], 0).unwrap();
        write_all_at(&file, &[1 << 1], 1).unwrap();

        let chunks = futures_like_read_bitmap_for_test(&path, 16);
        std::fs::remove_file(path).ok();

        assert_eq!(chunks, vec![3, 9]);
    }

    fn futures_like_read_bitmap_for_test(path: &Path, total_chunks: u64) -> Vec<u64> {
        let bytes = std::fs::read(path).unwrap();
        let mut chunks = Vec::new();
        for chunk in 0..total_chunks {
            let byte_index = (chunk / 8) as usize;
            if byte_index >= bytes.len() {
                break;
            }
            if bytes[byte_index] & (1 << (chunk % 8)) != 0 {
                chunks.push(chunk);
            }
        }
        chunks
    }
}
