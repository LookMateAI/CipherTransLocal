use crate::models::{default_device_name, ChatMessage, Device, Settings};
use sqlite::{Connection, State};
use std::path::PathBuf;
use std::sync::Mutex;

const CURRENT_SCHEMA_VERSION: i64 = 2;

pub struct Database {
    conn: Mutex<Connection>,
}

impl Database {
    pub fn new(db_path: PathBuf) -> Self {
        let conn = Connection::open(&db_path).expect("Failed to open database");
        let db = Self {
            conn: Mutex::new(conn),
        };
        db.migrate();
        db.init_default_settings();
        db
    }

    fn migrate(&self) {
        let conn = self.conn.lock().unwrap();

        conn.execute(
            "CREATE TABLE IF NOT EXISTS schema_migrations (
                version INTEGER PRIMARY KEY,
                applied_at INTEGER NOT NULL
            )",
        )
        .unwrap();

        conn.execute(
            "CREATE TABLE IF NOT EXISTS devices (
                device_id TEXT PRIMARY KEY,
                device_name TEXT NOT NULL,
                device_type TEXT NOT NULL,
                ip TEXT NOT NULL,
                port INTEGER NOT NULL,
                last_seen INTEGER NOT NULL,
                alias TEXT,
                is_favorite INTEGER DEFAULT 0
            )",
        )
        .unwrap();

        conn.execute(
            "CREATE TABLE IF NOT EXISTS settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            )",
        )
        .unwrap();

        conn.execute(
            "CREATE TABLE IF NOT EXISTS chat_messages (
                message_id TEXT PRIMARY KEY,
                device_id TEXT NOT NULL,
                file_id TEXT NOT NULL,
                file_name TEXT NOT NULL,
                file_size INTEGER NOT NULL,
                file_type TEXT NOT NULL,
                direction TEXT NOT NULL,
                status TEXT NOT NULL,
                timestamp INTEGER NOT NULL,
                progress REAL,
                speed INTEGER,
                error TEXT,
                file_path TEXT
            )",
        )
        .unwrap();

        conn.execute(
            "CREATE TABLE IF NOT EXISTS resume_points (
                file_id TEXT PRIMARY KEY,
                file_name TEXT NOT NULL,
                file_size INTEGER NOT NULL,
                chunk_size INTEGER NOT NULL,
                total_chunks INTEGER NOT NULL,
                checksum TEXT NOT NULL,
                received_chunks TEXT NOT NULL,
                updated_at INTEGER NOT NULL
            )",
        )
        .unwrap();

        add_column_if_missing(&conn, "chat_messages", "error", "TEXT");
        add_column_if_missing(&conn, "chat_messages", "file_path", "TEXT");

        conn.execute(
            "DELETE FROM devices
             WHERE rowid NOT IN (
               SELECT rowid FROM devices d
               WHERE last_seen = (
                 SELECT MAX(last_seen)
                 FROM devices
                 WHERE device_name = d.device_name
                   AND device_type = d.device_type
                   AND ip = d.ip
                   AND port = d.port
               )
             )",
        )
        .unwrap();

        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_device_time ON chat_messages(device_id, timestamp)",
        )
        .unwrap();

        let mut statement = conn
            .prepare("SELECT version FROM schema_migrations WHERE version = ?")
            .unwrap();
        statement.bind((1, CURRENT_SCHEMA_VERSION)).unwrap();
        if !matches!(statement.next(), Ok(State::Row)) {
            let mut insert = conn
                .prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)")
                .unwrap();
            insert.bind((1, CURRENT_SCHEMA_VERSION)).unwrap();
            insert.bind((2, chrono::Utc::now().timestamp())).unwrap();
            insert.next().unwrap();
        }
    }

    fn init_default_settings(&self) {
        let mut settings = self.get_settings();
        let mut changed = false;

        if settings.device_id.is_empty() {
            settings.device_id = uuid::Uuid::new_v4().to_string();
            changed = true;
        }

        if settings.device_name.trim().is_empty()
            || settings.device_name.eq_ignore_ascii_case("localhost")
        {
            settings.device_name = default_device_name();
            changed = true;
        }

        if changed || self.get_setting_value("device_id").is_none() {
            self.save_settings(&settings);
        }
    }

    pub fn get_settings(&self) -> Settings {
        let conn = self.conn.lock().unwrap();
        let mut settings = Settings::default();
        let mut statement = conn.prepare("SELECT key, value FROM settings").unwrap();

        while let Ok(State::Row) = statement.next() {
            let key = statement.read::<String, usize>(0).unwrap();
            let value = statement.read::<String, usize>(1).unwrap();

            match key.as_str() {
                "device_id" => settings.device_id = value,
                "device_name" => settings.device_name = value,
                "download_path" => settings.download_path = value,
                "speed_limit" => settings.speed_limit = value.parse().unwrap_or(0),
                "auto_start" => settings.auto_start = value == "true",
                "notification" => settings.notification = value == "true",
                "theme" => settings.theme = value,
                "android_storage_mode" => settings.android_storage_mode = value,
                "auto_save_images_to_gallery" => {
                    settings.auto_save_images_to_gallery = value == "true"
                }
                "android_custom_directory_uri" => settings.android_custom_directory_uri = value,
                "android_custom_directory_name" => settings.android_custom_directory_name = value,
                "android_keep_screen_awake" => settings.android_keep_screen_awake = value == "true",
                "android_haptics" => settings.android_haptics = value == "true",
                "android_wifi_only" => settings.android_wifi_only = value == "true",
                _ => {}
            }
        }

        settings
    }

    pub fn save_settings(&self, settings: &Settings) {
        self.set_setting_value("device_id", &settings.device_id);
        self.set_setting_value("device_name", &settings.device_name);
        self.set_setting_value("download_path", &settings.download_path);
        self.set_setting_value("speed_limit", &settings.speed_limit.to_string());
        self.set_setting_value(
            "auto_start",
            if settings.auto_start { "true" } else { "false" },
        );
        self.set_setting_value(
            "notification",
            if settings.notification {
                "true"
            } else {
                "false"
            },
        );
        self.set_setting_value("theme", &settings.theme);
        self.set_setting_value("android_storage_mode", &settings.android_storage_mode);
        self.set_setting_value(
            "auto_save_images_to_gallery",
            if settings.auto_save_images_to_gallery {
                "true"
            } else {
                "false"
            },
        );
        self.set_setting_value(
            "android_custom_directory_uri",
            &settings.android_custom_directory_uri,
        );
        self.set_setting_value(
            "android_custom_directory_name",
            &settings.android_custom_directory_name,
        );
        self.set_setting_value(
            "android_keep_screen_awake",
            if settings.android_keep_screen_awake {
                "true"
            } else {
                "false"
            },
        );
        self.set_setting_value(
            "android_haptics",
            if settings.android_haptics {
                "true"
            } else {
                "false"
            },
        );
        self.set_setting_value(
            "android_wifi_only",
            if settings.android_wifi_only {
                "true"
            } else {
                "false"
            },
        );
    }

    pub fn get_setting_value(&self, key: &str) -> Option<String> {
        let conn = self.conn.lock().unwrap();
        let mut statement = conn
            .prepare("SELECT value FROM settings WHERE key = ?")
            .unwrap();
        statement.bind((1, key)).unwrap();

        if let Ok(State::Row) = statement.next() {
            Some(statement.read::<String, usize>(0).unwrap())
        } else {
            None
        }
    }

    fn set_setting_value(&self, key: &str, value: &str) {
        let conn = self.conn.lock().unwrap();
        let mut statement = conn
            .prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)")
            .unwrap();
        statement.bind((1, key)).unwrap();
        statement.bind((2, value)).unwrap();
        statement.next().unwrap();
    }

    pub fn save_device(&self, device: &Device) {
        let conn = self.conn.lock().unwrap();
        let alias = device.alias.clone().unwrap_or_default();
        let is_favorite = if device.is_favorite { 1i64 } else { 0i64 };

        let mut statement = conn
            .prepare(
                "INSERT OR REPLACE INTO devices
                 (device_id, device_name, device_type, ip, port, last_seen, alias, is_favorite)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            )
            .unwrap();
        statement.bind((1, device.device_id.as_str())).unwrap();
        statement.bind((2, device.device_name.as_str())).unwrap();
        statement.bind((3, device.device_type.as_str())).unwrap();
        statement.bind((4, device.ip.as_str())).unwrap();
        statement.bind((5, device.port as i64)).unwrap();
        statement.bind((6, device.last_seen)).unwrap();
        statement.bind((7, alias.as_str())).unwrap();
        statement.bind((8, is_favorite)).unwrap();
        statement.next().unwrap();
    }

    pub fn get_saved_devices(&self) -> Vec<Device> {
        let conn = self.conn.lock().unwrap();
        let mut devices = Vec::new();
        let mut statement = conn
            .prepare(
                "SELECT device_id, device_name, device_type, ip, port, last_seen, alias, is_favorite
                 FROM devices",
            )
            .unwrap();

        while let Ok(State::Row) = statement.next() {
            let alias_str = statement.read::<String, usize>(6).unwrap();
            devices.push(Device {
                device_id: statement.read::<String, usize>(0).unwrap(),
                device_name: statement.read::<String, usize>(1).unwrap(),
                device_type: statement.read::<String, usize>(2).unwrap(),
                ip: statement.read::<String, usize>(3).unwrap(),
                port: statement.read::<i64, usize>(4).unwrap() as u16,
                last_seen: statement.read::<i64, usize>(5).unwrap(),
                is_online: false,
                alias: Some(alias_str).filter(|s| !s.is_empty()),
                is_favorite: statement.read::<i64, usize>(7).unwrap() == 1,
            });
        }

        devices
    }

    pub fn save_message(&self, message: &ChatMessage) {
        let conn = self.conn.lock().unwrap();
        let progress = message.progress.unwrap_or(0.0) as f64;
        let speed = message.speed.unwrap_or(0) as i64;
        let error = message.error.clone().unwrap_or_default();
        let file_path = message.file_path.clone().unwrap_or_default();

        let mut statement = conn
            .prepare(
                "INSERT OR REPLACE INTO chat_messages
                 (message_id, device_id, file_id, file_name, file_size, file_type, direction, status, timestamp, progress, speed, error, file_path)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            )
            .unwrap();
        statement.bind((1, message.message_id.as_str())).unwrap();
        statement.bind((2, message.device_id.as_str())).unwrap();
        statement.bind((3, message.file_id.as_str())).unwrap();
        statement.bind((4, message.file_name.as_str())).unwrap();
        statement.bind((5, message.file_size as i64)).unwrap();
        statement.bind((6, message.file_type.as_str())).unwrap();
        statement.bind((7, message.direction.as_str())).unwrap();
        statement.bind((8, message.status.as_str())).unwrap();
        statement.bind((9, message.timestamp)).unwrap();
        statement.bind((10, progress)).unwrap();
        statement.bind((11, speed)).unwrap();
        statement.bind((12, error.as_str())).unwrap();
        statement.bind((13, file_path.as_str())).unwrap();
        statement.next().unwrap();
    }

    pub fn get_messages(&self, device_id: &str) -> Vec<ChatMessage> {
        let conn = self.conn.lock().unwrap();
        let mut messages = Vec::new();
        let mut statement = conn
            .prepare(
                "SELECT message_id, device_id, file_id, file_name, file_size, file_type,
                        direction, status, timestamp, progress, speed, error, file_path
                 FROM chat_messages
                 WHERE device_id = ?
                 ORDER BY timestamp DESC
                 LIMIT 100",
            )
            .unwrap();
        statement.bind((1, device_id)).unwrap();
        read_messages(&mut statement, &mut messages);
        messages
    }

    pub fn get_message(&self, message_id: &str) -> Option<ChatMessage> {
        let conn = self.conn.lock().unwrap();
        let mut messages = Vec::new();
        let mut statement = conn
            .prepare(
                "SELECT message_id, device_id, file_id, file_name, file_size, file_type,
                        direction, status, timestamp, progress, speed, error, file_path
                 FROM chat_messages
                 WHERE message_id = ?
                 LIMIT 1",
            )
            .unwrap();
        statement.bind((1, message_id)).unwrap();
        read_messages(&mut statement, &mut messages);
        messages.into_iter().next()
    }

    pub fn get_all_messages(&self) -> Vec<ChatMessage> {
        let conn = self.conn.lock().unwrap();
        let mut messages = Vec::new();
        let mut statement = conn
            .prepare(
                "SELECT message_id, device_id, file_id, file_name, file_size, file_type,
                        direction, status, timestamp, progress, speed, error, file_path
                 FROM chat_messages
                 ORDER BY timestamp DESC
                 LIMIT 500",
            )
            .unwrap();
        read_messages(&mut statement, &mut messages);
        messages
    }

    pub fn clear_messages(&self, device_id: &str) {
        let conn = self.conn.lock().unwrap();
        let mut statement = conn
            .prepare("DELETE FROM chat_messages WHERE device_id = ?")
            .unwrap();
        statement.bind((1, device_id)).unwrap();
        statement.next().unwrap();
    }

    pub fn clear_all_messages(&self) {
        let conn = self.conn.lock().unwrap();
        let mut statement = conn.prepare("DELETE FROM chat_messages").unwrap();
        statement.next().unwrap();
    }

    pub fn delete_message(&self, message_id: &str) {
        let conn = self.conn.lock().unwrap();
        let mut statement = conn
            .prepare("DELETE FROM chat_messages WHERE message_id = ?")
            .unwrap();
        statement.bind((1, message_id)).unwrap();
        statement.next().unwrap();
    }

    pub fn delete_device(&self, device_id: &str) {
        let conn = self.conn.lock().unwrap();
        let mut delete_messages = conn
            .prepare("DELETE FROM chat_messages WHERE device_id = ?")
            .unwrap();
        delete_messages.bind((1, device_id)).unwrap();
        delete_messages.next().unwrap();

        let mut delete_device = conn
            .prepare("DELETE FROM devices WHERE device_id = ?")
            .unwrap();
        delete_device.bind((1, device_id)).unwrap();
        delete_device.next().unwrap();
    }

    pub fn search_messages(&self, query_text: &str) -> Vec<ChatMessage> {
        let conn = self.conn.lock().unwrap();
        let mut messages = Vec::new();
        let query = format!("%{}%", query_text);
        let mut statement = conn
            .prepare(
                "SELECT message_id, device_id, file_id, file_name, file_size, file_type,
                        direction, status, timestamp, progress, speed, error, file_path
                 FROM chat_messages
                 WHERE file_name LIKE ?
                 ORDER BY timestamp DESC
                 LIMIT 100",
            )
            .unwrap();
        statement.bind((1, query.as_str())).unwrap();
        read_messages(&mut statement, &mut messages);
        messages
    }
}

fn add_column_if_missing(conn: &Connection, table: &str, column: &str, column_type: &str) {
    let mut statement = conn
        .prepare(format!("PRAGMA table_info({})", table).as_str())
        .unwrap();
    let mut exists = false;

    while let Ok(State::Row) = statement.next() {
        let name = statement.read::<String, usize>(1).unwrap();
        if name == column {
            exists = true;
            break;
        }
    }

    if !exists {
        conn.execute(
            format!(
                "ALTER TABLE {} ADD COLUMN {} {}",
                table, column, column_type
            )
            .as_str(),
        )
        .unwrap();
    }
}

fn read_messages(statement: &mut sqlite::Statement, messages: &mut Vec<ChatMessage>) {
    while let Ok(State::Row) = statement.next() {
        let error = statement.read::<String, usize>(11).unwrap_or_default();
        let file_path = statement.read::<String, usize>(12).unwrap_or_default();
        messages.push(ChatMessage {
            message_id: statement.read::<String, usize>(0).unwrap(),
            device_id: statement.read::<String, usize>(1).unwrap(),
            file_id: statement.read::<String, usize>(2).unwrap(),
            file_name: statement.read::<String, usize>(3).unwrap(),
            file_size: statement.read::<i64, usize>(4).unwrap() as u64,
            file_type: statement.read::<String, usize>(5).unwrap(),
            direction: statement.read::<String, usize>(6).unwrap(),
            status: statement.read::<String, usize>(7).unwrap(),
            timestamp: statement.read::<i64, usize>(8).unwrap(),
            progress: Some(statement.read::<f64, usize>(9).unwrap_or(0.0) as f32),
            speed: Some(statement.read::<i64, usize>(10).unwrap_or(0) as u64),
            thumbnail: None,
            error: Some(error).filter(|s| !s.is_empty()),
            file_path: Some(file_path).filter(|s| !s.is_empty()),
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn settings_keep_stable_device_id() {
        let path =
            std::env::temp_dir().join(format!("ciphertranslocal-test-{}.db", uuid::Uuid::new_v4()));
        let db = Database::new(path.clone());
        let first = db.get_settings().device_id;
        drop(db);

        let db = Database::new(path.clone());
        let second = db.get_settings().device_id;
        std::fs::remove_file(path).ok();

        assert_eq!(first, second);
    }

    #[test]
    fn message_parameter_binding_handles_quotes() {
        let path =
            std::env::temp_dir().join(format!("ciphertranslocal-test-{}.db", uuid::Uuid::new_v4()));
        let db = Database::new(path.clone());
        let message = ChatMessage {
            message_id: "m1".to_string(),
            device_id: "d1".to_string(),
            file_id: "f1".to_string(),
            file_name: "it's ok.txt".to_string(),
            file_size: 10,
            file_type: "document".to_string(),
            direction: "send".to_string(),
            status: "completed".to_string(),
            timestamp: 1,
            thumbnail: None,
            progress: Some(100.0),
            speed: None,
            error: None,
            file_path: None,
        };

        db.save_message(&message);
        let results = db.search_messages("it's");
        std::fs::remove_file(path).ok();

        assert_eq!(results.len(), 1);
        assert_eq!(results[0].file_name, "it's ok.txt");
    }
}
