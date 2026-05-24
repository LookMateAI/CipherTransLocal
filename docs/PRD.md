# MultiTrans - 多端局域网传输软件 PRD 技术文档

## 1. 项目概述

### 1.1 产品定位
MultiTrans 是一款跨平台局域网文件传输工具，主打简洁高效的传输体验。通过类似聊天的界面设计，让文件传输如同对话般自然流畅。

### 1.2 核心价值
- **零配置**：自动发现局域网设备，无需手动配置 IP
- **断点续传**：网络中断后可自动恢复传输，避免重复传输
- **简洁交互**：聊天式界面，直观展示传输历史
- **跨平台**：支持 Windows 和 Android 双平台
- **安全可靠**：端到端加密，保护传输隐私

### 1.3 目标用户
- 需要在电脑和手机间频繁传输文件的用户
- 对传输工具有简洁美观要求的用户
- 需要传输大文件且网络不稳定的用户

---

## 2. 功能需求

### 2.1 设备发现与管理

#### 2.1.1 自动发现
- 使用 UDP 广播/multicast 自动发现局域网内的在线设备
- 设备上线时自动推送通知
- 显示设备名称、IP 地址、设备类型图标
- 实时更新设备在线状态（在线/离线）

#### 2.1.2 设备记忆
- 自动保存历史连接过的设备
- 显示设备别名（用户可自定义）
- 记录最后在线时间
- 支持设备分组（如：工作设备、个人设备）
- 支持快速收藏/置顶常用设备

### 2.2 文件传输

#### 2.2.1 基础传输
- 支持单文件和多文件传输
- 支持文件夹传输（自动打包）
- 支持拖拽上传/点击选择
- 实时显示传输进度、速度、剩余时间
- 支持暂停/恢复/取消传输

#### 2.2.2 断点续传
- 文件分块传输（默认 512KB 每块）
- 记录已传输块信息
- 传输中断后自动重试（最多 3 次）
- 支持手动续传
- 断点信息持久化存储
- 传输完整性校验（MD5/SHA256）

#### 2.2.3 传输队列
- 支持多个文件排队传输
- 支持调整传输优先级
- 并发传输控制（默认 3 个并发）

### 2.3 聊天式界面

#### 2.3.1 界面布局
- 左侧：设备列表（在线/离线分组）
- 右侧：聊天式传输记录
- 底部：文件选择/拖拽区域

#### 2.3.2 消息展示
- 发送的文件显示在右侧
- 接收的文件显示在左侧
- 显示文件名、大小、传输状态
- 文件预览缩略图（图片、视频）
- 时间戳显示
- 传输状态图标（成功/失败/传输中）

#### 2.3.3 文件操作
- 点击文件打开/预览
- 右键菜单：打开、打开所在文件夹、重新传输、删除
- 拖拽文件到聊天窗口直接发送

### 2.4 其他功能

#### 2.4.1 历史记录
- 按设备分组显示历史传输
- 支持搜索历史文件
- 支持清理历史记录

#### 2.4.2 设置
- 设备别名设置
- 下载路径设置
- 传输速度限制
- 开机自启动（Windows）
- 通知设置
- 主题切换（亮色/暗色）

---

## 3. 技术架构

### 3.1 技术栈

#### 3.1.1 前端
- **框架**：Tauri 2.0
- **UI 框架**：React 18+ / Vue 3（推荐 React）
- **样式方案**：TailwindCSS + Shadcn/UI
- **状态管理**：Zustand / Jotai
- **构建工具**：Vite

#### 3.1.2 后端（Rust）
- **网络通信**：Tokio（异步运行时）
- **UDP 广播**：tokio::net::UdpSocket
- **TCP 传输**：tokio::net::TcpListener/TcpStream
- **序列化**：serde + serde_json
- **数据库**：SQLite (rusqlite / sqlx)
- **文件操作**：tokio::fs
- **加密**：ring / sodiumoxide

#### 3.1.3 移动端
- **Android**：Tauri Mobile（基于 Kotlin/JNI）
- **跨平台通信**：通过 Tauri Commands 实现前后端通信

### 3.2 系统架构图

```
┌─────────────────────────────────────────────────┐
│                   UI Layer                       │
│  ┌──────────────────────────────────────────┐  │
│  │  React/Vue Components                     │  │
│  │  - DeviceList                              │  │
│  │  - ChatWindow                              │  │
│  │  - FileItem                                │  │
│  └──────────────────────────────────────────┘  │
└─────────────────────────────────────────────────┘
                       ↕ Tauri Commands
┌─────────────────────────────────────────────────┐
│              Rust Backend Layer                  │
│  ┌──────────────────────────────────────────┐  │
│  │  Device Discovery Service                 │  │
│  │  - UDP Broadcast (port 7890)              │  │
│  │  - Device Registry                        │  │
│  └──────────────────────────────────────────┘  │
│  ┌──────────────────────────────────────────┐  │
│  │  File Transfer Service                    │  │
│  │  - TCP Server (port 7891)                │  │
│  │  - Chunk Manager                          │  │
│  │  - Progress Tracker                       │  │
│  └──────────────────────────────────────────┘  │
│  ┌──────────────────────────────────────────┐  │
│  │  Data Layer                               │  │
│  │  - SQLite DB                              │  │
│  │  - File Storage                           │  │
│  └──────────────────────────────────────────┘  │
└─────────────────────────────────────────────────┘
                       ↕
         Network (LAN - UDP/TCP)
```

---

## 4. 核心模块设计

### 4.1 设备发现模块

#### 4.1.1 发现协议
```rust
// UDP 广播消息格式
{
    "type": "device_announce",
    "device_id": "uuid",
    "device_name": "My MacBook",
    "device_type": "windows" | "android",
    "ip": "192.168.1.100",
    "port": 7891,
    "timestamp": 1234567890
}
```

#### 4.1.2 发现流程
1. 应用启动时，监听 UDP 7890 端口
2. 每隔 5 秒广播一次设备信息
3. 接收到其他设备广播后，更新设备列表
4. 设备超过 15 秒未响应，标记为离线

#### 4.1.3 数据结构
```rust
struct Device {
    device_id: String,
    device_name: String,
    device_type: DeviceType,
    ip: String,
    port: u16,
    last_seen: DateTime<Utc>,
    is_online: bool,
    alias: Option<String>,
    is_favorite: bool,
}

enum DeviceType {
    Windows,
    Android,
}
```

### 4.2 文件传输模块

#### 4.2.1 传输协议
```
┌─────────────────────────────────────────┐
│           TCP Connection                │
├─────────────────────────────────────────┤
│  Handshake                              │
│  - Device ID                            │
│  - Encryption Key (RSA)                 │
├─────────────────────────────────────────┤
│  File Metadata                          │
│  - File ID                              │
│  - File Name                            │
│  - File Size                            │
│  - Total Chunks                         │
│  - Checksum                             │
├─────────────────────────────────────────┤
│  Chunk Transfer                         │
│  - Chunk Index                          │
│  - Chunk Data (512KB)                   │
│  - Chunk Checksum                       │
├─────────────────────────────────────────┤
│  Acknowledgment                         │
│  - Received Chunks                      │
│  - Resume from chunk N                  │
└─────────────────────────────────────────┘
```

#### 4.2.2 断点续传实现
```rust
struct FileTransfer {
    file_id: String,
    file_name: String,
    file_size: u64,
    chunk_size: u64,
    total_chunks: u64,
    received_chunks: Vec<bool>, // BitMap
    checksum: String,
    status: TransferStatus,
}

struct TransferProgress {
    file_id: String,
    completed_chunks: u64,
    total_chunks: u64,
    bytes_transferred: u64,
    speed: u64, // bytes/s
    eta: u64,   // seconds
}

// 持久化存储
struct TransferState {
    file_id: String,
    file_path: String,
    received_chunks: Vec<u64>, // 已接收的块索引
    timestamp: i64,
}
```

#### 4.2.3 续传流程
1. 发送方请求传输文件，携带文件 ID 和元数据
2. 接收方检查本地是否有未完成的传输记录
3. 如果有，返回已接收的块索引列表
4. 发送方从未接收的块开始传输
5. 每传输完成一块，接收方更新持久化记录
6. 传输完成后，删除断点记录

### 4.3 聊天界面模块

#### 4.3.1 消息模型
```rust
struct ChatMessage {
    message_id: String,
    device_id: String,
    file_id: String,
    file_name: String,
    file_size: u64,
    file_type: FileType,
    direction: MessageDirection, // Send/Receive
    status: MessageStatus,
    timestamp: DateTime<Utc>,
    thumbnail: Option<String>, // Base64
}

enum MessageStatus {
    Pending,
    Transferring { progress: f32 },
    Completed,
    Failed { error: String },
    Paused,
}

enum FileType {
    Image,
    Video,
    Audio,
    Document,
    Archive,
    Other,
}
```

#### 4.3.2 消息存储
```sql
CREATE TABLE chat_messages (
    message_id TEXT PRIMARY KEY,
    device_id TEXT NOT NULL,
    file_id TEXT NOT NULL,
    file_name TEXT NOT NULL,
    file_size INTEGER NOT NULL,
    file_type TEXT NOT NULL,
    direction TEXT NOT NULL,
    status TEXT NOT NULL,
    timestamp INTEGER NOT NULL,
    thumbnail BLOB,
    file_path TEXT,
    created_at INTEGER DEFAULT (strftime('%s', 'now'))
);

CREATE INDEX idx_device_time ON chat_messages(device_id, timestamp);
```

---

## 5. 数据库设计

### 5.1 设备表
```sql
CREATE TABLE devices (
    device_id TEXT PRIMARY KEY,
    device_name TEXT NOT NULL,
    device_type TEXT NOT NULL,
    ip TEXT NOT NULL,
    port INTEGER NOT NULL,
    last_seen INTEGER NOT NULL,
    alias TEXT,
    is_favorite INTEGER DEFAULT 0,
    created_at INTEGER DEFAULT (strftime('%s', 'now'))
);
```

### 5.2 传输记录表
```sql
CREATE TABLE transfer_records (
    transfer_id TEXT PRIMARY KEY,
    file_id TEXT NOT NULL,
    file_name TEXT NOT NULL,
    file_size INTEGER NOT NULL,
    file_path TEXT NOT NULL,
    device_id TEXT NOT NULL,
    direction TEXT NOT NULL,
    status TEXT NOT NULL,
    progress REAL DEFAULT 0,
    started_at INTEGER,
    completed_at INTEGER,
    created_at INTEGER DEFAULT (strftime('%s', 'now'))
);
```

### 5.3 断点续传表
```sql
CREATE TABLE resume_points (
    file_id TEXT PRIMARY KEY,
    file_path TEXT NOT NULL,
    total_chunks INTEGER NOT NULL,
    received_chunks TEXT NOT NULL, -- JSON array
    updated_at INTEGER DEFAULT (strftime('%s', 'now'))
);
```

---

## 6. API 接口设计（Tauri Commands）

### 6.1 设备管理
```rust
#[tauri::command]
async fn get_devices() -> Result<Vec<Device>, String>;

#[tauri::command]
async fn update_device_alias(device_id: String, alias: String) -> Result<(), String>;

#[tauri::command]
async fn toggle_favorite(device_id: String) -> Result<(), String>;

#[tauri::command]
async fn delete_device(device_id: String) -> Result<(), String>;
```

### 6.2 文件传输
```rust
#[tauri::command]
async fn send_files(device_id: String, file_paths: Vec<String>) -> Result<String, String>;

#[tauri::command]
async fn cancel_transfer(transfer_id: String) -> Result<(), String>;

#[tauri::command]
async fn pause_transfer(transfer_id: String) -> Result<(), String>;

#[tauri::command]
async fn resume_transfer(transfer_id: String) -> Result<(), String>;

#[tauri::command]
async fn retry_transfer(transfer_id: String) -> Result<(), String>;
```

### 6.3 历史记录
```rust
#[tauri::command]
async fn get_chat_history(device_id: String) -> Result<Vec<ChatMessage>, String>;

#[tauri::command]
async fn search_history(query: String) -> Result<Vec<ChatMessage>, String>;

#[tauri::command]
async fn delete_history(message_id: String) -> Result<(), String>;

#[tauri::command]
async fn clear_history(device_id: String) -> Result<(), String>;
```

### 6.4 设置
```rust
#[tauri::command]
async fn get_settings() -> Result<Settings, String>;

#[tauri::command]
async fn update_settings(settings: Settings) -> Result<(), String>;

#[tauri::command]
async fn set_device_name(name: String) -> Result<(), String>;
```

---

## 7. 安全性设计

### 7.1 传输加密
- 使用 RSA-2048 进行初始密钥交换
- 使用 AES-256-GCM 进行数据传输加密
- 每次连接生成新的会话密钥

### 7.2 设备认证
- 首次连接时生成设备证书
- 设备间交换证书并存储
- 后续连接验证证书指纹
- 支持"信任设备"机制

### 7.3 文件校验
- 传输前计算文件 Hash（SHA-256）
- 每个块计算 CRC32 校验
- 传输完成后验证整体 Hash

---

## 8. 性能优化

### 8.1 传输优化
- 零拷贝技术减少内存拷贝
- 异步 I/O 提高并发性能
- 动态调整缓冲区大小
- 多连接并发传输（可选）

### 8.2 内存优化
- 流式传输，避免大文件全加载到内存
- 缩略图压缩存储
- 定期清理过期数据

### 8.3 性能指标
- 单连接传输速度：> 100 MB/s（局域网环境）
- 设备发现时间：< 5 秒
- 内存占用：< 100 MB（空闲状态）
- CPU 占用：< 5%（空闲状态）

---

## 9. 项目结构

```
MultiTrans/
├── src-tauri/              # Rust 后端
│   ├── src/
│   │   ├── main.rs         # 入口
│   │   ├── commands/       # Tauri Commands
│   │   ├── discovery/      # 设备发现
│   │   ├── transfer/       # 文件传输
│   │   ├── db/             # 数据库
│   │   ├── crypto/         # 加密
│   │   └── models/         # 数据模型
│   ├── Cargo.toml
│   └── tauri.conf.json
├── src/                    # 前端
│   ├── components/         # React 组件
│   │   ├── DeviceList/
│   │   ├── ChatWindow/
│   │   ├── FileItem/
│   │   └── Settings/
│   ├── hooks/              # 自定义 Hooks
│   ├── stores/             # 状态管理
│   ├── utils/              # 工具函数
│   ├── App.tsx
│   └── main.tsx
├── docs/                   # 文档
│   ├── PRD.md             # 本文档
│   └── API.md             # API 文档
└── package.json
```

---

## 10. 开发计划

### Phase 1: 基础架构（2 周）
- [ ] 项目初始化（Tauri + React）
- [ ] 数据库设计与实现
- [ ] 基础 UI 框架搭建
- [ ] 设备发现模块（UDP 广播）

### Phase 2: 核心功能（3 周）
- [ ] 文件传输模块（TCP）
- [ ] 断点续传实现
- [ ] 聊天界面实现
- [ ] 文件操作功能

### Phase 3: 优化与完善（2 周）
- [ ] 传输加密
- [ ] 性能优化
- [ ] 错误处理与重试机制
- [ ] 设置功能

### Phase 4: Android 适配（2 周）
- [ ] Tauri Mobile 配置
- [ ] Android UI 适配
- [ ] 权限处理
- [ ] 后台传输

### Phase 5: 测试与发布（1 周）
- [ ] 单元测试
- [ ] 集成测试
- [ ] Windows 安装包
- [ ] Android APK
- [ ] 文档完善

---

## 11. 技术风险与应对

### 11.1 跨平台兼容性
**风险**：Windows 和 Android 系统差异大
**应对**：
- 使用 Tauri 的跨平台能力
- 平台特定代码封装为独立模块
- 充分测试各平台功能

### 11.2 网络稳定性
**风险**：局域网网络不稳定
**应对**：
- 实现完善的断点续传
- 自动重连机制
- 传输超时检测

### 11.3 大文件传输
**风险**：超大文件内存占用高
**应对**：
- 流式传输
- 分块处理
- 内存使用监控

### 11.4 安全性
**风险**：局域网传输可能被监听
**应对**：
- 端到端加密
- 设备认证
- 安全审计

---

## 12. 后续规划

### 12.1 短期规划（v1.1）
- 支持文本/剪贴板传输
- 支持图片压缩传输
- 传输速度限制功能
- 批量设备管理

### 12.2 中期规划（v1.5）
- 支持 iOS 平台
- 支持 macOS 平台
- 支持文件夹同步
- 支持 P2P 直连（跨网络）

### 12.3 长期规划（v2.0）
- 支持云端中转
- 支持多设备群组
- 支持插件系统
- 支持命令行模式

---

## 13. 参考资料

### 13.1 技术文档
- [Tauri 2.0 官方文档](https://beta.tauri.app/)
- [Tokio 异步运行时](https://tokio.rs/)
- [React 官方文档](https://react.dev/)

### 13.2 类似产品
- LocalSend：开源局域网传输工具
- Snapdrop：基于 Web 的局域网传输
- AirDrop：Apple 生态传输方案

---

**文档版本**：v1.0  
**创建日期**：2025-01-XX  
**最后更新**：2025-01-XX  
**维护者**：开发团队