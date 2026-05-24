# 局域网传输性能优化方案

更新时间：2026-05-12
作用范围：`src-tauri/src/transfer.rs`
约束：不破坏现有对外行为（命令、事件、消息状态机、断点续传、暂停/继续/取消/重试、SHA-256 完整性校验、与 Android/桌面端的双向兼容）。

---

## 一、目标

让单条 LAN 传输能逼近物理带宽（千兆 ≈ 110–118 MB/s，万兆 ≈ 1.0–1.1 GB/s），同时保证：

- 旧版本客户端继续可与新版本互传（HTTP 接口语义不变）。
- 暂停/继续/取消/断点续传逻辑不退化。
- SHA-256 校验仍为强保障。

## 二、当前实现摘要

文件：`src-tauri/src/transfer.rs`

| 项 | 当前实现 | 位置 |
|---|---|---|
| 传输协议 | 手写 HTTP/1.1，每请求读完即关闭 | `start_http_server` L101–L237 |
| 分块大小 | 固定 4 MiB | `CHUNK_SIZE` L20 |
| 并发块数 | 固定 4 | `MAX_CONCURRENT_CHUNK_UPLOADS` L21 |
| 发送端块读取 | 每块 `File::open` → `seek` → `read_exact` 到 `Vec<u8>` → `body(data)` | `send_chunk` L1030–L1047 |
| 接收端块写入 | 每块 `OpenOptions::open` → `seek` → 256 KiB 循环 read/write | `handle_chunk` L1144–L1159 |
| 接收端状态 | 每块写完后读 `*.chunks.json` → 追加 → 序列化 → 整文件回写 | L1164–L1169 |
| 完整性校验 | 发送前 hash 整文件 + 接收完 hash 整文件 | L721, L1221 |
| 进度上报 | 本地节流 180 ms，远端节流 450 ms；接收端无节流 | L877, L893, L1248 |
| Manifest 传递 | 每个 `/chunk` 请求在 `X-Manifest` 头里 base64 一次 | `encode_manifest` L1826 |
| 取消传播 | 内存集合 + 远端 `/transfer-control` | L1289 |

## 三、瓶颈定位与影响估算

按对 LAN 吞吐的实际拖累从高到低排序。

### B1. 每块新建 TCP 连接，无 keep-alive 【影响极高】

服务端只读一次请求行+头+一个 body 就退出，没有写 `Connection: keep-alive`，循环不重入。`reqwest` 的连接池只能复用"看起来还活着"的连接，但每个响应后服务端立刻关闭，等于：

- 每个 chunk 一次 TCP 三次握手 + 慢启动
- 千兆 LAN 上 RTT 约 0.2–0.5 ms，加上 OS socket 创建/释放，每块多出 1–3 ms
- 4 MiB / 块、并发 4，单条流约 30 块/秒，仅握手与拆链就消耗 3–9 %，未计 cwnd 重新爬升

千兆下实测一般卡在 60–80 MB/s 主要由此引起。

### B2. 接收端 `chunks.json` 每块整体回写 【影响高】

每收到一块都做：读全文件 → JSON 反序列化 → sort/dedup → 序列化 → 写全文件。Tokio 的 `fs::write` 在 Windows 上是阻塞调用包装到线程池，约 1–3 ms。对 4 MiB 块、千兆链路每块 35 ms 来说占 3–8 %；对小块或更快网络放大。

并且 chunks.json 越大（大文件块数多），每块开销随之增长，呈 O(N) 总开销。

### B3. 发送前整文件 SHA-256 阻塞 【影响中—与文件大小相关】

`run_send_task` 启动后先 `tokio::task::spawn_blocking(sha256_file)`，10 GB 文件 SATA SSD ≈ 20 s，NVMe ≈ 6–10 s。这段时间内一字节都还没发，UX 上是"卡住"。接收端完成后还要再 hash 一次。

### B4. 接收端单条消息全局 mutex 【影响中】

`receive_lock` 持有期间会做：读 chunks.json、写 chunks.json、若完成则再 hash 整文件、rename、清理 stats/locks、构造 ChatMessage。完成那一刻 hash 整文件可能耗几秒，期间同一传输的其他 in-flight 块全部排队。常规 chunk 路径每次也会锁。

### B5. 接收端每块都写库 + 发事件 【影响中】

发送端通过 `should_emit_local`（180 ms）节流过；接收端 `handle_chunk` 末尾**每块**都 `upsert_message → db.save_message → emit_message`。SQLite 单线程 `INSERT OR REPLACE` 大概 0.3–1 ms，加上 Tauri IPC 序列化，是不可忽视的开销，且会拖累前端事件循环。

### B6. 并发数与块大小未随场景调节 【影响中】

- 千兆：4 并发 × 4 MiB 块 ≈ 单流 ~16 MiB pipeline，足以填满带宽，但被 B1/B2 拉低。
- 万兆 / USB 网卡 / Wi-Fi 6E：4 并发显然不够。
- 极小文件（< 4 MiB）：分块没有意义，反而多一次 probe + control 往返。

### B7. 发送端 `Vec<u8>` 读满整块后再发 【影响低—中】

`send_chunk` 用 `read_exact` 把 4 MiB 读进 `Vec<u8>` 再交给 `reqwest.body(data)`。读盘和发网没有重叠；4 MiB 缓冲占内存可控但分配/释放频繁。

### B8. socket 选项未调 【影响低—中】

`tokio::net::TcpListener::bind` 之后没有设置：

- `TCP_NODELAY`：HTTP 头/控制小包会被 Nagle 攒到 40 ms。
- `SO_SNDBUF` / `SO_RCVBUF`：默认值在 Windows 上常为 64 KiB，限制 BDP。

### B9. 接收端 256 KiB 中转缓冲 【影响低】

`handle_chunk` 循环里用 256 KiB `Vec` 中转 read→write。可以直接 `tokio::io::copy` 限长拷贝 / 用 8 MiB 缓冲。

### B10. 每块都 base64 整个 manifest 放在 header 【影响低】

manifest 序列化 + base64 是 CPU 开销，且占带宽（一般 200–500 B/块）。可在握手阶段交付一次会话 ID，后续只带会话 ID + chunk_index。但这会改变协议，留到协议大版本升。

## 四、优化方案（按优先级）

### P0：不动协议、立刻见效

#### P0-1. 启用 HTTP keep-alive（针对 B1）

在 `start_http_server` 内层 `tokio::spawn` 改为循环处理同一连接上的多次请求：

- 读完一个请求 → 响应里加 `Connection: keep-alive` 和 `Keep-Alive: timeout=60`
- 不关闭 socket，继续 `read_line` 等下一次请求行
- 客户端断开 / 读到空行 / I/O Error → 退出循环

`reqwest::Client` 默认会复用连接，但需要在创建时复用同一个 `Client`（当前 `notify_remote_*` 里多处 `reqwest::Client::new()`，每次重建会丢掉 pool）。

新增 `ClientPool`：

- `TransferService` 持有一个 `reqwest::Client`（已经在 `run_send_task` 里复用了一次，需要扩展到 `notify_remote_status` 和 `notify_remote_control`，避免 fallback 路径还在 `new()`）。
- 配置 `Client::builder().pool_max_idle_per_host(MAX_CONCURRENT_CHUNK_UPLOADS * 2).tcp_keepalive(Duration::from_secs(30)).http1_only().build()`。

**预期收益**：千兆下单流吞吐 +25–50 %，万兆下更高。
**兼容性**：keep-alive 是 HTTP/1.1 默认行为，旧客户端只是把它当一次性连接用，不会失败。

#### P0-2. 设 `TCP_NODELAY` + 增大 socket 缓冲（B8）

`listener.accept().await` 拿到 socket 后立即：

```rust
socket.set_nodelay(true)?;
let sock = socket2::Socket::from(socket.into_std()?);
sock.set_send_buffer_size(2 * 1024 * 1024)?;
sock.set_recv_buffer_size(2 * 1024 * 1024)?;
let socket = tokio::net::TcpStream::from_std(sock.into())?;
```

发送端 reqwest 设置 `.tcp_nodelay(true)`。

**预期收益**：第一字节延迟下降 ~40 ms 量级（Nagle 关），高 BDP 链路（万兆/Wi-Fi 6E 大 RTT）吞吐 +10–30 %。
**风险**：略增 CPU（更多小包），LAN 不敏感。

#### P0-3. 用 bitmap 文件替换 `chunks.json`（B2）

新增 `chunks_bitmap_path()`：`<file_id>.chunks.bin`，长度 `ceil(total_chunks/8)`，每块一位。

- 第一次 probe 时如果只有旧 `.chunks.json` 存在，迁移成 bitmap（同时保留旧文件读取的回退逻辑一个版本）。
- 收到 chunk → `OpenOptions::read+write` 打开 bitmap，`seek` 到字节 `idx/8`，读 1 字节、或上 `1<<(idx%8)`、写回。改 1 字节而不是整文件回写。
- probe 响应仍返回 `Vec<u64>`：扫 bitmap 一次构造。
- 同 message_id 在内存里再加一个 `HashSet<u64>`，避免每块都磁盘扫一遍计算 received_bytes。

**预期收益**：每块 1–3 ms 落到 < 0.1 ms。大文件总传输时间显著下降；接收端 CPU 也降低。
**兼容性**：probe 响应字段不变；老客户端不感知。

#### P0-4. 进度/DB 写入节流到接收端（B5）

`handle_chunk` 完成态以外的中间块，沿用发送端的 180 ms 节流策略：

- 在 `TransferService` 里加 `receive_emit_at: RwLock<HashMap<String, Instant>>`
- 距上次 emit < 180 ms 且未完成 → 跳过 `upsert_message / db.save_message / emit_message`
- 完成态（`complete == true`）或状态变化（first chunk）必须 emit
- 暂停/取消/失败路径已经会清 stats，需要同时清这个 map

**预期收益**：接收端每秒 SQLite 写从 30+ 降到 ≤ 6。释放线程池给真正的 I/O。
**风险**：前端进度刷新感知差不多，肉眼无差异。

#### P0-5. `reqwest::Client` 全局单例（配合 P0-1）

把所有 `reqwest::Client::new()` 改成 `TransferService` 持有一个 `Arc<reqwest::Client>`，传入需要的函数。已散落在：

- `pause_send_task` L424
- `resume_send_task` L459
- `cancel_send_task` L575
- `fail_send_task` L976
- `notify_remote_control` L1090

`notify_remote_control` 是关联函数；改造时把 client 作为参数传入。

**预期收益**：与 P0-1 合并见效。

### P1：保留 API 语义，但调用模式有调整

#### P1-1. 动态并发与块大小（B6）

新增策略函数：

```rust
fn chunking_strategy(file_size: u64) -> (usize, usize) {
    match file_size {
        0..=1_048_576           => (1, file_size.max(1) as usize),  // 整体当一块
        ..=16_777_216           => (4, 2 * 1024 * 1024),            // 16M 以下，2M × 4
        ..=1_073_741_824        => (8, 4 * 1024 * 1024),            // 1G 以下，4M × 8
        _                       => (12, 8 * 1024 * 1024),           // 大文件 8M × 12
    }
}
```

manifest 已经带 `chunk_size`，接收端按 manifest 走，**不需要双方约定常量**。

**预期收益**：小文件少 N 次握手；大文件更深的 pipeline，万兆下 +30–60 %。
**风险**：旧接收端假设 4 MiB 块吗？检查：`handle_chunk` 完全基于 `manifest.chunk_size`，无硬编码。安全。

#### P1-2. 边发边算 SHA-256（B3）

把"先 hash 整文件再发"改成"hash 与发送并行"：

1. `run_send_task` 立刻 spawn 一个 `spawn_blocking` 增量哈希任务，把结果通过 `oneshot::channel<String>` 回送。
2. 第一次 probe 用占位 checksum 不可行（接收端拿 checksum 做最终校验）。改成两阶段：
   - 发送前发 `/probe` **不带 checksum**（manifest 加可选 `checksum: Option<String>`，向后兼容旧字段：旧端必带，新端可空）。这破坏兼容，**留待协议小版本升**。
   - 替代方案 A：仍先算完再发，但用 rayon / 多线程分段哈希。SHA-256 单线程在 NVMe 上 ~500 MB/s，10 GB 文件 20 s；多核分段后 2–4 s。
   - 替代方案 B（推荐）：保持 manifest 不变，但把 hash 计算与"sender 把首批 chunk 读进内存"并行，hash 跑在独立 blocking 任务，第一批 chunk 由独立 reader 任务读完即发，最终在最后一批发送前 `await` hash 完成。这样网络打底 + 磁盘并行，整体墙钟时间 ≈ max(hash, transfer)。

实施方案 B（不破坏协议）：

- `run_send_task` 入口：
  ```rust
  let hash_handle = tokio::task::spawn_blocking({
      let path = path.clone();
      move || sha256_file(&path)
  });
  ```
- 同时构造 manifest 不带 checksum，先发 `/probe-init`（可仍叫 `/probe`，接收端兼容空 checksum：probe 不做 final 校验，只查已收块）。
- 在 `final_probe` 之前 `await hash_handle` 拿到 checksum，更新 manifest，调用 `/finalize` 把 checksum 传过去。**这一步需要协议增量**。

**折中实施（零协议变更）**：仅对 ≥ 100 MiB 文件并行多线程 SHA-256（rayon `par_chunks` over mmap），缩短 hash 时间 3–5×；小文件不变。

**预期收益**：大文件首字节延迟 -60–80 %，总耗时小幅下降。
**兼容性**：折中方案完全兼容。

#### P1-3. 发送端读盘与发送解耦（B7）

`send_chunk` 改为：

- 用 `tokio::fs::File` 在 chunk 任务一开始 spawn 一个 reader 把文件按顺序 prefetch 到一个 `mpsc::channel<(u64, Bytes)>`，深度 = MAX_CONCURRENT_CHUNK_UPLOADS。
- 每个上传任务从 channel 里取（带 chunk_index）。
- 用 `bytes::Bytes` 而非 `Vec<u8>`，避免 reqwest 内部再拷贝；`Client::post(...).body(bytes)` 是零拷贝路径。

或者更简单：保留独立 reader，但 `File` 由 reader 持有不再每块重开。

**预期收益**：高速 NVMe + 千兆/万兆下 +5–15 %，主要收 syscall 数。
**兼容性**：完全内部改造。

#### P1-4. 接收端预分配 + 大缓冲（B9）

- 第一次写入前调 `file.set_len(manifest.file_size).await`：避免 NTFS 稀疏文件零填充导致的运行时 zero-fill 写放大。
- 把 256 KiB 中转 buffer 改成 `tokio::io::copy_buf` 限长版本，buffer 1–4 MiB。
- 写完不 flush（OS page cache 会刷），只在 complete 路径前 `file.sync_all()` 一次。

**预期收益**：Windows NTFS 上写大文件 +10–25 %。

#### P1-5. 锁粒度收紧（B4）

`receive_lock` 现在保护了"chunks 元数据更新 + 整文件 hash + rename + 清理"。把完成路径拆出来：

- chunk 元数据更新走 bitmap 文件，已经是单字节级原子或，可以用 `parking_lot::Mutex` 或对 bitmap 文件加 file-lock。
- final hash + rename 用一个独立的 `completion: Mutex<()>`，保证一次到位的同时不阻塞普通 chunk 路径。

**预期收益**：完成阶段时其他流不阻塞；并发多个文件同时收尾时收益明显。

### P2：需要小幅协议演进（向后兼容设计）

#### P2-1. 会话握手 + chunk-only 帧（B10）

新增 `POST /session` 接收 manifest，返回 `session_id`。后续 `POST /chunk` 头里只放 `X-Session-Id` 和 `X-Chunk-Index`。

- 旧端：仍允许直接 `POST /chunk` 带 `X-Manifest`（保留作为 fallback）。
- 新端：优先走 session，省 1.5 KiB/块 的头开销 + base64 反序列化 CPU。

#### P2-2. HTTP/2 或自定义二进制帧

`h2` crate 直接复用单 TCP 多路复用 chunk 上传，省连接数；但实现复杂、Tauri 体积上升。**建议先把 P0/P1 做完再评估**。

#### P2-3. 单连接多块流水线（不上 HTTP/2）

keep-alive 已有的基础上做"显式 pipeline"：客户端在同一连接上连续 POST 多个 chunk，不等响应；服务端按收到顺序响应。`reqwest` 本身不支持显式 pipeline，需自管 socket。**收益已被 P0-1 + 多并发连接覆盖大半，优先级低**。

#### P2-4. 速率限制（实现 `Settings.speed_limit`）

`models.rs` L40 有字段但 `transfer.rs` 没接。补一个 `Governor`：发送端在每块前 `governor.until_n_ready(length).await`。
**与吞吐无关，但用户已配置项不实现是个隐患**。

## 五、推荐落地顺序

1. **P0-1 + P0-5**：keep-alive + Client 单例。一次合并 PR，最小改动，立刻 +25–50 %。
2. **P0-2**：socket 选项。单文件改动，立竿见影。
3. **P0-3**：bitmap 替换 chunks.json，要写迁移代码，独立 PR。
4. **P0-4**：接收端节流。独立 PR。
5. **P1-1**：动态并发与块大小，独立 PR，含 e2e 验证。
6. **P1-4**：预分配 + 大缓冲，独立 PR。
7. **P1-3 / P1-5**：流水线读盘 + 锁粒度，合并一个 PR。
8. **P1-2**：哈希并行（折中方案，零协议改）。
9. **P2-1**：会话握手协议小升。
10. **P2-4**：speed_limit 实装。
11. （可选）**P2-2**：HTTP/2 评估。

P0 全部完成预计千兆链路单流可达 105–115 MB/s（理论上限 117–118 MB/s）。P1 完成后万兆链路单流可达 600–900 MB/s。

## 六、验证清单

每个 PR 至少跑：

- `cargo test`（含 `chunk_count_rounds_up`、`stable_file_id_is_repeatable_for_same_file` 等已有用例）。
- **新增**：
  - bitmap ↔ JSON 兼容用例：从旧 `chunks.json` 迁移到 bitmap 后续传断点续传是否正确。
  - keep-alive 下 5 连传文件、单连接 100 个 chunk POST 不掉。
  - 强行 kill 接收端 → 重启 → 续传从 bitmap 恢复，最终 SHA-256 一致。
  - 暂停/继续/取消在 P0-3 之后状态机不退化。
- **吞吐基准**：写一个简单的 Rust bench（或 Node 脚本）发 1 GiB 文件，记录 sender/receiver 端速度曲线，作为回归基准。
- **手测**：Windows ↔ Android（旧版本未更新的端是否仍能与新端互传）。

## 七、不建议触动的部分

- `sanitize_file_name`、`available_destination_path`：覆盖 Windows 非法字符与重名策略，正确且有测试。
- `stable_file_id` 算法：客户端断点续传依赖其稳定性，改动会作废所有未完成传输的 `.part`。
- `TRANSFERRING_PROGRESS_MAX = 99.4`：是 UI 与 final probe 之间的握手约定，不要按"看着不爽"为由调。
- `/probe` 在文件已存在且 hash 匹配时返回 `complete: true`：是 Idempotency 关键，不要绕开。

## 八、风险登记

| 风险 | 触发 | 缓解 |
|---|---|---|
| keep-alive 后 socket 泄漏 | 客户端突然断网 | 60 s read timeout + 显式关闭对端关闭的连接 |
| bitmap 迁移失败 | 旧 chunks.json 被截断 | 迁移失败回退到从零重传，已收块仍在 `.part`，sha256 final 校验保底 |
| 并发数提高内存压力 | 大文件 + 高并发 + 8 MiB 块 | 块大小 × 并发 ≤ 96 MiB，且用 `Bytes` 共享 |
| Windows 上 `set_len` 慢 | NTFS 大文件预分配 | 仅对 ≥ 1 GiB 文件预分配；小文件跳过 |
| 接收端节流后状态滞后 | 用户在 180 ms 内取消 | 取消路径走 `/transfer-control` 走单独通道，不依赖普通进度 emit，已隔离 |

---

**附：本文档不动代码，仅作为后续 PR 的设计依据。所有改动均以"对外协议字段不删不改，仅做向后兼容的增量"为底线。**
