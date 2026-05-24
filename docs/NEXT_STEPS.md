# MultiTrans 后续优化与补充计划

更新时间：2026-05-06

## 2026-05-06 执行状态

本轮已经完成以下工程项：

- 固定本机 `device_id`：设备 ID 写入 settings，重启后复用。
- 数据库迁移基础：新增 `schema_migrations`，不再通过删表处理结构变化。
- SQL 参数化：设备、设置、消息读写和搜索改为绑定参数。
- 分块传输：发送端按 512KB chunk 发送，接收端写入 `.part` 文件并记录已收 chunk。
- 断点续传基础：发送前 `/probe` 接收端状态，跳过已接收 chunk。
- 完整性校验：每个 chunk 使用 SHA-256 校验，完成后校验整文件 SHA-256。
- 实时进度事件：后端通过 `chat-message-updated` 推送消息状态，前端监听后即时更新。
- 文本传输入口：聊天窗口支持输入文本并发送。
- 拖拽发送入口：聊天窗口 HTML5 文件拖拽会尝试读取 Tauri 文件路径并发送。
- 传输控制命令：新增暂停、继续、取消、重试命令和前端按钮。
- 测试：新增数据库稳定 device_id、SQL 特殊字符、chunk 计算、文件类型识别测试。

已验证：

```bash
npm run build
cargo test
```

## 2026-05-06 继续推进

本轮继续补齐了上一次实现后的运行时风险：

- 接收端消息持久化：接收文件和接收文本时直接写入 SQLite，不再只依赖内存消息合并。
- 发送状态持久化：发送端进度、完成、失败、暂停、取消状态更新时同步写入 SQLite。
- 中文文件名兼容：chunk 请求中的 manifest 改为 URL-safe Base64 header，避免中文/空格文件名破坏 HTTP header。
- 拖拽兼容增强：前端同时监听 Tauri 原生 `tauri://drag-drop`，补足 HTML5 `dataTransfer.files.path` 不稳定的问题。
- 接收端残留清理：最终文件已完整时清理 `.part` 和 `.chunks.json`；探测续传状态时修剪无效 chunk 索引。
- 测试补充：新增中文 manifest 编解码和 Windows 非法文件名清理测试。

追加验证：

```bash
npm run build
cargo test
```

## 2026-05-06 第三轮优化

本轮继续优化接近实机使用的细节：

- 稳定续传 ID：`file_id` 从随机 UUID 改为基于本机设备 ID、文件路径、大小、修改时间生成；同一文件重复发送可以命中接收端续传状态。
- 前端事件监听去重：Tauri 事件只注册一次，当前设备通过 `useRef` 读取，避免切换设备时重复监听或使用过期设备状态。
- 接收端重名处理：完成接收时如果目标文件名已存在，会自动生成 `name (1).ext` 形式，避免覆盖和 rename 失败。
- 历史页增强：文本消息使用消息图标，不显示 `0 B`；历史记录增加状态标签和错误信息。
- 文件项增强：文本消息使用独立图标。
- 测试补充：新增稳定 `file_id` 和重名目标路径测试。

追加验证：

```bash
npm run build
cargo test
```

## 2026-05-06 Android 启动

Android 端已经开始推进，当前完成：

- 配置 Android SDK/NDK 环境变量，SDK 位于 `D:\Android\Sdk`。
- 成功执行 `npm run tauri -- android init`，生成 `src-tauri/gen/android/`。
- 新增 [ANDROID.md](./ANDROID.md)，记录 Android SDK/NDK 环境、初始化、构建、真机测试和风险项。
- 新增 `scripts/check-android-env.ps1`，用于检查 `ANDROID_HOME`、`NDK_HOME`、`adb`、`sdkmanager`、Rust targets 和 Tauri CLI。
- Rust 设备类型识别适配 Android：Android 广播 `device_type = "android"`。
- 调整设备名读取，避免移动端 runtime 中使用阻塞式读取。
- 补 Android Manifest 网络/Wi-Fi/通知权限。
- `reqwest` 切换到 Rustls TLS，避免 Android 交叉编译 OpenSSL。
- Rust 入口调整为 Tauri mobile entry point。
- Gradle 仓库增加 Aliyun Google Maven / Maven Central 镜像，解决当前机器访问 `dl.google.com` 时的 TLS 握手失败。
- `npm run tauri -- android build --target aarch64 --apk` 已成功完成 APK 构建。

当前 APK 产物：

```text
D:\ZeroProject\MultiTrans\src-tauri\gen\android\app\build\outputs\apk\universal\release\app-universal-release-unsigned.apk
```

仍需后续实机验证：

- 两台设备之间的局域网发现和分块传输。
- Windows 文件拖拽在 HTML5 路径和 Tauri 原生事件两条路径下的实际表现。
- 大文件中断后再次发送是否能按预期续传。
- 接收端 `.part` 和 `.chunks.json` 异常残留清理策略。

## 当前状态判断

MultiTrans 当前已经具备可运行的桌面应用雏形：前端有设备列表、聊天式传输窗口、历史记录和设置页；后端有 UDP 设备发现、基础文件收发服务、SQLite 持久化和 Tauri Commands。

但当前实现仍属于 MVP 早期阶段，距离 PRD 中“可靠的大文件局域网传输工具”还有几类关键差距：传输可靠性、进度事件、持久化模型、设备身份稳定性、安全能力、跨端适配和测试覆盖。

## P0：先补可靠传输基础

### 1. 传输协议从整文件上传升级为分块协议

当前文件发送已经避免一次性读入内存，但接收端仍按一次 HTTP 请求写完整文件，尚未支持真正的分块、断点续传和块级校验。

建议补充：

- 定义明确的传输会话模型：`transfer_id`、`file_id`、`chunk_size`、`total_chunks`、`checksum`。
- 发送端按固定大小读取 chunk，并逐块发送。
- 接收端记录每个 chunk 是否完成。
- 支持查询接收端已完成 chunk 列表。
- 网络中断后从缺失 chunk 继续传。

验收标准：

- 传输 1GB 以上文件时内存稳定，不随文件大小线性增长。
- 中途关闭发送端或断网，再次发送同一文件时能从已完成部分继续。
- 接收完成后文件 hash 与源文件一致。

### 2. 增加文件完整性校验

PRD 中要求 SHA-256/MD5 和块校验，目前代码还没有真正校验。

建议补充：

- 传输开始前计算文件 SHA-256。
- 每个 chunk 计算 CRC32 或 SHA-256。
- 接收端写入 chunk 前校验块内容。
- 全部完成后校验整文件 SHA-256。
- 校验失败的 chunk 自动重传。

验收标准：

- 故意破坏一个 chunk 时，接收端能拒绝该 chunk 并请求重传。
- 完整文件校验失败时，聊天记录状态显示为 failed，并保留可重试入口。

### 3. 实时进度事件从轮询改为事件推送

当前前端通过定时 `get_chat_history` 刷新状态，延迟和资源消耗都不理想。

建议补充：

- Rust 后端通过 Tauri event 主动发送 `transfer_progress`。
- 前端监听事件并更新对应 message。
- 保留轮询作为兜底，不作为主路径。

验收标准：

- 传输过程中 UI 进度条实时平滑更新。
- 多文件同时传输时，每个文件状态独立更新。
- 传输完成、失败、取消都能即时反映到 UI。

## P1：完善数据和设备模型

### 4. 固定本机 device_id

当前 `DiscoveryService::new` 每次启动都会生成新的 UUID，导致同一设备重启后被识别成新设备。

建议补充：

- 首次启动生成本机 `device_id` 并保存到 SQLite/settings。
- 后续启动复用同一个 `device_id`。
- 设备名称可变，但 `device_id` 不变。

验收标准：

- 应用重启后，其他设备看到的是同一台设备。
- 历史记录能继续归属到同一设备。

### 5. 数据库迁移机制

当前数据库直接 `CREATE TABLE IF NOT EXISTS`，缺少 schema 版本管理。

建议补充：

- 增加 `schema_migrations` 表。
- 每次 schema 变更写一个迁移步骤。
- 禁止用删除表的方式处理 schema 变化。

验收标准：

- 老版本数据库升级后数据不丢失。
- 新字段可以自动补齐默认值。

### 6. SQL 参数化

当前部分数据库操作用字符串拼接 SQL，虽然有局部转义，但仍不够稳妥。

建议补充：

- 全部 SQL 写入和查询改为参数绑定。
- 搜索、设备别名、文件名等用户输入都不得直接拼接进 SQL。

验收标准：

- 文件名或设备名包含单引号、百分号、中文、emoji 时不报错。
- 搜索输入特殊字符不会破坏查询。

## P2：补齐产品交互

### 7. 拖拽发送真正接入后端

当前聊天窗口有拖拽 UI，但 `handleDrop` 只关闭 overlay，没有把文件路径传给发送逻辑。

建议补充：

- 使用 Tauri 文件拖放事件或前端可用的文件路径能力。
- 拖入文件后直接调用 `send_files`。
- 多文件拖入时生成传输队列。

验收标准：

- 将文件拖入聊天窗口后自动开始发送。
- 设备离线时拖拽会给出明确提示。

### 8. 传输控制按钮

PRD 中包含暂停、恢复、取消、重试，目前还没有完整实现。

建议补充：

- 后端增加 `pause_transfer`、`resume_transfer`、`cancel_transfer`、`retry_transfer`。
- 前端 FileItem 根据状态显示对应操作按钮。
- 取消时清理临时文件或保留可续传状态，需要策略明确。

验收标准：

- 传输中可以取消，状态变为 canceled 或 failed。
- 失败文件可以重试。
- 暂停后不会继续写入接收端文件。

### 9. 文本/剪贴板传输

后端已有 `send_text` 命令和 `/text` 接收入口，但前端没有文本输入。

建议补充：

- 聊天窗口底部增加文本输入。
- 支持发送普通文本。
- 后续可扩展为剪贴板同步。

验收标准：

- 设备在线时可以发送一条文本消息。
- 历史记录能区分文本消息和文件消息。

## P3：安全与跨端

### 10. 设备信任和配对

目前局域网内任意同协议设备都可能被发现和发送文件，缺少信任关系。

建议补充：

- 首次连接弹出确认。
- 保存受信任设备指纹。
- 未信任设备默认不可直接写入文件。

验收标准：

- 首次接收来自新设备的文件时需要用户确认。
- 拒绝后不会写入下载目录。

### 11. 传输加密

PRD 中规划端到端加密，目前尚未实现。

建议补充：

- 先实现局域网设备身份密钥。
- 再实现会话密钥协商。
- 文件 chunk 使用 AES-GCM 或 ChaCha20-Poly1305 加密。

验收标准：

- 抓包无法直接看到文件明文。
- 密钥协商失败时传输不会开始。

### 12. Android 适配

当前主要是 Windows 桌面形态，Android 需要单独处理权限和后台行为。

建议补充：

- Android 文件访问权限。
- 下载目录策略。
- 前台服务或后台传输策略。
- 移动端布局适配。

验收标准：

- Android 与 Windows 能互相发现。
- Android 能发送和接收文件。
- 大文件传输过程中锁屏策略明确。

## P4：工程质量

### 13. 测试覆盖

当前缺少自动化测试。

建议补充：

- Rust 单元测试：文件类型识别、数据库读写、设备合并。
- Rust 集成测试：本地启动两个传输服务，模拟发送文件。
- 前端测试：关键状态渲染和组件交互。

验收标准：

- `cargo test` 可覆盖核心后端逻辑。
- `npm run build` 和 `cargo check` 纳入每次提交前检查。

### 14. 错误处理和日志

当前部分错误只 `println!` 或 `eprintln!`，前端看不到足够上下文。

建议补充：

- 引入统一错误类型。
- 关键失败返回明确错误码。
- 后端日志区分 info/warn/error。
- 前端展示可理解的错误文案。

验收标准：

- 端口占用、设备离线、文件不存在、权限不足、磁盘不足都有明确提示。
- 日志可以帮助定位失败发生在发现、连接、发送、接收还是写盘阶段。

## 推荐执行顺序

1. 固定本机 `device_id`。
2. 补数据库迁移和 SQL 参数化。
3. 把传输协议升级为 chunk 模型。
4. 增加 chunk/整文件校验。
5. 用 Tauri event 推送实时进度。
6. 接入拖拽发送和重试按钮。
7. 增加基础测试。
8. 再考虑设备配对、加密和 Android。

这个顺序优先解决会影响数据归属、传输可靠性和后续扩展的底层问题，避免 UI 功能越堆越多后再重构核心协议。
