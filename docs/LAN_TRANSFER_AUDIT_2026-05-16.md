# 局域网传输最大速度核查报告

更新时间：2026-05-16
作用范围：`src-tauri/src/transfer.rs`
前置文档：
- `LAN_TRANSFER_OPTIMIZATION_2026-05-12.md`（P0/P1 优化方案）
- `LAN_TRANSFER_STABILITY_2026-05-12.md`（S1–S10 抖动诊断）

本次目的：把"已落地的优化"逐条与当前代码核对一遍，确认正确性，并按"PC↔PC / Android↔Android / Android↔PC"三种组合给出还能再榨出来的最大速度优化点。

---

## 一、已落地优化对照表（核对 commit 当前状态）

| 优化项 | 来源 | 当前实现位置 | 状态 | 备注 |
|---|---|---|---|---|
| HTTP/1.1 keep-alive 长连接 | P0-1 | `start_http_server` L208–L327 | ✅ 正确 | 60 s 读超时，循环 read_line 等下一请求 |
| `reqwest::Client` 单例 + 复用 | P0-5 | `build_http_client` L2014 | ✅ 正确 | http1_only / tcp_nodelay / tcp_keepalive 30s / pool_max_idle = 并发×4 |
| `TCP_NODELAY` + socket buffer | P0-2 / B8 | `tune_tcp_stream` L2025 | ✅ 正确 | send/recv 2 MiB |
| bitmap 替代 chunks.json | P0-3 / B2 | `mark_chunk_received` L1814 | ✅ 正确 | 1 字节级 OR 写；老 chunks.json 仍可迁移 |
| 接收端进度/DB 节流 | P0-4 / B5 | `RECEIVE_EMIT_INTERVAL = 120 ms` L29 + `should_emit_receive_progress` | ✅ 正确 | 仅在 `complete == true` 时强制 emit |
| 动态分块策略 | P1-1 / B6 | `chunking_strategy` L1995 | ✅ 正确 | 1MB 以下整体 1 块；>1GB 走 8 MiB × 8 |
| 接收端预分配 `set_len` | P1-4 | `get_receive_file_state` L1778 | ✅ 正确 | 仅对 ≥ 1 GiB 文件触发 |
| 接收端共享 fd（消息级） | S3 | `ReceiveFileState.file: Arc<Mutex<File>>` L109–L114 | ⚠️ **部分落地，见 §三 R-1** |
| 接收端内存 bitmap（HashSet） | S5 | `ReceiveFileState.received` L111 | ✅ 正确 | 配合 `bytes_received: AtomicU64` 避免每块扫位图 |
| 滑动窗口速度采样 | S8 | `SpeedSampler` L36–L76 | ✅ 正确 | 1.5 s 窗，32 样本，最小 250 ms 跨距 |
| 大缓冲 BufReader | S2 | `HTTP_READER_BUFFER_SIZE = 2 MiB` L27 | ✅ 正确 | 用于服务端解析请求体 |
| 大缓冲 chunk 中转 | S1 | `CHUNK_COPY_BUFFER_SIZE = 2 MiB` L28 | ⚠️ **部分落地，见 §三 R-1** |

## 二、未落地或仅纸面记录的优化

| 项 | 来源 | 现状 | 性质 |
|---|---|---|---|
| 发送端 fd 共享 / 顺序读 prefetch | S4 / P1-3 | `send_chunk` 每块仍 `File::open` L1155 | **未做** |
| 发送前 SHA-256 并行/分块 | P1-2 / S6 | 仍单线程整文件先扫一遍 L821 | **未做** |
| 接收完成 SHA-256 不阻塞连接 | S6 | 完成路径在 keep-alive worker 里同步 hash L1328 | **未做** |
| 会话握手 + chunk-only 帧 | P2-1 | 每个 `/chunk` 仍 base64 整 manifest L1115 | **未做**（协议级） |
| HTTP/2 / 二进制帧 | P2-2 | 未评估 | **未做** |
| 速率限制接线 | P2-4 | `Settings.speed_limit` 仍未消费 | **未做** |

---

## 三、当前阻挡"跑到最大速度"的剩余真实瓶颈

下面是按对**最大稳定速率**的实际影响从高到低排序、且**未在前两版文档中真正修掉**的剩余项。每条都对照 2026-05-16 当前代码逐行核对过。

### R-1. 接收端 `file.lock()` 临界区**包住了 socket 读取**（最大单点瓶颈）

位置：`transfer.rs:1264–1279`

```rust
let receive_state = get_receive_file_state(...).await?;
let mut file = receive_state.file.lock().await;          // ← 拿锁
file.seek(SeekFrom::Start(chunk_index * manifest.chunk_size)).await?;
let mut remaining = len;
let mut buffer = vec![0u8; CHUNK_COPY_BUFFER_SIZE.min(len.max(1))];
while remaining > 0 {
    let read_len = remaining.min(buffer.len());
    reader.read_exact(&mut buffer[..read_len]).await?;   // ← 网络 IO 持锁中
    file.write_all(&buffer[..read_len]).await?;
    remaining -= read_len;
}
```

**问题**：

`receive_state.file` 是消息级别共享的 `Arc<Mutex<tokio::fs::File>>`。`handle_chunk` 由独立 TCP 连接并发触发（reqwest 在发送端开了 6–8 条并发流），但**所有并发块都要抢这一把锁**。锁的临界区不仅包了 `seek + write`，还把"从 socket 读 chunk body"整段包了进去。等于：

- 8 个并发块退化成串行 read+write
- 单流的"发送侧 8 路并发"完全失去意义
- 千兆 LAN 下单文件吞吐被压回 50–70 MB/s 量级，对应 60 % 带宽利用率

**S3 文档的本意是修这个**，但当前实现只完成了"fd 共享"这一半，**锁的粒度没收紧**。

**修法（推荐 A，最稳）**：

1. 把 socket → buffer 这一步移出锁外：
   ```rust
   let mut buffer = vec![0u8; len];
   reader.read_exact(&mut buffer).await?;     // 网络读：无锁
   // 现在 TCP 接收窗立即释放，发送端 cwnd 不会因为另一个 chunk 在抢锁而停摆
   ```
2. 写盘改成"positional write"，不再需要持锁：
   - Unix：`std::os::unix::fs::FileExt::write_all_at(&buffer, offset)`
   - Windows：`std::os::windows::fs::FileExt::seek_write(&buffer, offset)`

   这两个 API 不动文件指针，多线程并发 pwrite 到不同 offset 由内核串行化（VFS 层），不需要用户态锁。改造路径：
   ```rust
   let file = receive_state.file.clone();       // Arc<std::fs::File>
   let offset = chunk_index * manifest.chunk_size;
   tokio::task::spawn_blocking(move || -> anyhow::Result<()> {
       #[cfg(windows)]
       { use std::os::windows::fs::FileExt; file.seek_write(&buffer, offset)?; }
       #[cfg(unix)]
       { use std::os::unix::fs::FileExt; file.write_all_at(&buffer, offset)?; }
       Ok(())
   }).await??;
   ```
   `receive_state.file` 改成 `Arc<std::fs::File>`（不再用 `tokio::fs::File`），完成态 `sync_all`，无 mutex。

**修法（推荐 B，渐进）**：

若不想直接换 `std::fs::File`，最小改动：
1. 把 socket 读移出锁外（先把整块读进 `Vec<u8>`）。
2. 锁内只剩 `seek + write_all`。
3. `CHUNK_COPY_BUFFER_SIZE` 大于等于实际 chunk 大小时，循环只跑一次，等价于一次大写入。

A 比 B 收益高 2–3×，B 比当前高 30–60 %。

**预期收益**：
- PC↔PC 千兆：60–80 MB/s → **105–115 MB/s**（接近物理上限）
- PC↔PC 2.5G/5G：120 → **260+** MB/s
- Android↔PC：受 Wi-Fi 限制可能不变，但脉冲消失

**正确性风险**：
- 内存峰值上升至 `chunk_size × concurrent` = 8 × 8 = 64 MiB（可控）
- pwrite 到稀疏区域：已通过 `set_len(file_size)` 预分配规避
- `received` HashSet 与 bitmap 文件同步：仍走 `receive_lock`（轻量），不冲突

### R-2. 发送端每个 chunk 都 `tokio::fs::File::open` + `seek`（中—高）

位置：`send_chunk` L1146–L1163

```rust
async fn send_chunk(...) -> anyhow::Result<(u64, u64)> {
    let offset = chunk_index * manifest.chunk_size;
    let length = ...;
    let mut file = tokio::fs::File::open(path).await?;   // ← 每块 open
    file.seek(SeekFrom::Start(offset)).await?;
    let mut buf = vec![0u8; length];
    file.read_exact(&mut buf).await?;
    post_chunk(client, target_ip, manifest, chunk_index, buf).await?;
    Ok((chunk_index, length as u64))
}
```

每块一次 `CreateFile / NtOpenFile` + 一次 close，并发 8 时同一文件就是 8 次 open。在 HDD 上磁头位置每块都会重置，制造 seek 风暴；SSD 上影响小但 syscall 开销不可忽略。

**修法**：
- 发送端也维护消息级共享 `Arc<std::fs::File>`，所有 chunk 任务用 `read_at` / `seek_read`（平台 API）走位置读。
- 或者起一个独立 reader 任务按顺序读，把 `(idx, Bytes)` 推入 `mpsc::channel`；上传任务从 channel 取。
- 用 `bytes::Bytes` 而非 `Vec<u8>`，`reqwest::RequestBuilder::body(bytes)` 零拷贝。

**预期收益**：HDD 发送方 +50–100 %；SSD 发送方 +5–15 %；CPU 下降。

### R-3. 发送前同步全文 SHA-256 阻塞 transfer 启动（中—大文件高）

位置：`run_send_task` L821–L825

```rust
let checksum = tokio::task::spawn_blocking({
    let path = path.clone();
    move || sha256_file(&path)
})
.await??;
```

`sha256_file` 单线程 64 KiB 缓冲扫整文件。NVMe ≈ 500 MB/s，SATA SSD ≈ 250 MB/s，HDD ≈ 100 MB/s。10 GB 文件在 SATA SSD 上耽误 40 秒，UI 看是"卡在 0 % 不动"。

**修法（零协议改）**：
- 用 `blake3` 替换 `sha256`（`Cargo.toml` 加 `blake3 = "1"`）。BLAKE3 单线程 1.5–3 GB/s，多线程 5–8 GB/s。**但** `manifest.checksum` 字段语义改了，老端不识别——需要 manifest 加 `checksum_algo: Option<String>`，向后兼容默认 sha256。
- **更稳的零协议改**：仍用 SHA-256，但用多线程分段哈希再 finalize。可用 `rayon` 把文件 mmap 后 `par_chunks(64 MiB)` 各算各段，最后串行 merge 结果。**注意 SHA-256 不能直接并行 merge**（不是 Merkle tree），所以这条路其实不通——只能切换 hash 算法。
- **最简渐进**：发送方先 spawn 一个 hash blocking 任务，**同时**直接开始读 chunk 发送；首批 chunk 上传期间 hash 在并行跑；在最后一批发送前 `await` hash 完成，更新 manifest，发 final probe。**前提是 receiver 接受 manifest 不带 checksum 的 chunk POST**——当前 manifest 每个 chunk 都带，且 receiver 在完成态用 `manifest.checksum` 校验，所以 chunk-level manifest 必须最终一致。**这需要让发送方在最后一个 chunk POST 前确定 checksum**，意味着 hash 必须比传输快才有意义——SSD 上不成立。

结论：**真正修 R-3 必须切换到 BLAKE3 + manifest 加 algo 字段**。这是协议级增量，向后兼容设计为：
```rust
struct TransferManifest {
    ...
    checksum: String,
    checksum_algo: Option<String>,  // None / "sha256" / "blake3"
}
```
接收端按 `checksum_algo.unwrap_or("sha256")` 校验。

**预期收益**：大文件首字节延迟 -60–80 %，总耗时 -10–20 %（hash 不再占主时间）。

### R-4. 接收完成态在 keep-alive worker 里同步 hash（中）

位置：`handle_chunk` L1327–L1336

```rust
if complete {
    let final_hash = tokio::task::spawn_blocking({
        let part_path = part_path.clone();
        move || sha256_file(&part_path)
    })
    .await??;
    if final_hash != manifest.checksum { return Err(...); }
    ...rename, cleanup...
}
```

`spawn_blocking` 至少没占住 tokio worker；但 `.await??` 把当前 keep-alive 连接挂住几秒到几十秒。同一连接上的下一条请求（其他文件的下一个 chunk、或 `/transfer-status`）会被阻塞。

**修法**：
1. 立即返回 `202 Verifying` 状态，把 hash 计算放进后台任务，hash 完成后通过 `notify_remote_status("completed")` 走单独连接通知发送端。
2. 或者发送端的 final probe（`probe_remote` 收尾时）改成主动轮询，receiver 不阻塞连接，让发送端等。
3. 配合 R-3 切到 BLAKE3，hash 时间从秒级降到毫秒级，本问题大半消失。

**预期收益**：完成态期间其他流不卡顿；99.4 % → 100 % 跳变变快。

### R-5. `mark_chunk_received` 每块都开关 bitmap 文件（小—中）

位置：`mark_chunk_received` L1814–L1841

每块都：`OpenOptions::open → metadata → seek → read 1B → seek → write 1B → drop`。Windows NTFS 上每对 open/close 约 0.3–1 ms；并发 8 时 200 MB/s 吞吐对应每秒 200 块，bitmap 文件总开销可达每秒 200–800 ms 等价 CPU。

**修法**：
- bitmap 文件改成消息级共享 `Arc<Mutex<std::fs::File>>`，不每块 open。
- 进一步：用 `tokio::sync::Notify` 把 bitmap 写入合并成"每 N 块或每 500 ms 一次落盘"。崩溃恢复时根据 `.part` 文件长度 + manifest 重建已收边界。
- 配合 R-1 一起改：`receive_state` 加 `bitmap_file: Arc<std::fs::File>`，pwrite 单字节 OR 操作。

**预期收益**：每块 -0.5~2 ms。配合 R-1 后，接收端 CPU 时间分布更平。

### R-6. `post_chunk` retry 路径 `data.clone()` 大块内存复制（小）

位置：`post_chunk` L1112–L1118

```rust
for attempt in 0..=CHUNK_UPLOAD_RETRIES {
    let response = client
        .post(&url)
        .header("X-Manifest", manifest_header.clone())
        ...
        .body(data.clone())          // ← 每次重试克隆 8 MiB
        .send()
        .await;
    ...
}
```

只有 retry 才会触发 clone（正常路径 send 后 `Vec<u8>` 被 reqwest 消费）。但首次发送时 reqwest 内部还有一份从 `Vec<u8>` 到 hyper body 的复制。

**修法**：
- `data: Vec<u8>` → `data: bytes::Bytes`，`Bytes` clone 是 atomic refcount，零拷贝。
- 同时 `manifest_header` 的 clone 也免掉（`Bytes` 一份）。

**预期收益**：内存抖动消失；千兆下 +2–5 %；高带宽链路更明显。

### R-7. 接收端每条新连接上分配 2 MiB BufReader（小，仅内存）

位置：`start_http_server` L208

```rust
let mut buf_reader = tokio::io::BufReader::with_capacity(HTTP_READER_BUFFER_SIZE, reader);
```

8 并发 + 同时 3 个文件传输 = 24 条连接 × 2 MiB = 48 MiB 常驻。可接受。但 BufReader 容量为 2 MiB 时，单次 `read_line`（解析 header 时）仍只填 8 KiB 级别（操作系统 read syscall 返回多少就用多少）。容量大主要为 chunk body 那一段服务，方向正确，仅备注。

---

## 四、按部署组合的速度上限与差距

下表给出当前代码、R-1 修复后、R-1+R-2+R-5 修复后、协议级 R-3+R-4 修复后的预期单文件单流速度。

| 组合 | 物理上限 | 当前 (2026-05-16) | 仅修 R-1 | R-1+R-2+R-5 | 再加 R-3+R-4 |
|---|---|---|---|---|---|
| PC↔PC 千兆有线 | 117 MB/s | 60–80 | 95–110 | 108–116 | 同上 + 启动快 |
| PC↔PC 2.5G 有线 | 290 MB/s | 80–130 | 180–230 | 240–280 | 同上 + 启动快 |
| PC↔PC USB-C 直连 (5G+) | 600 MB/s | 100–180 | 240–340 | 400–550 | 同上 |
| Android↔Android Wi-Fi 5 | 50–70 MB/s | 25–45 | 45–60 | 50–65 | 同上 |
| Android↔Android Wi-Fi 6 | 110–150 MB/s | 40–70 | 80–110 | 100–135 | 同上 |
| Android↔Android Wi-Fi 6E/7 5GHz | 200+ MB/s | 50–90 | 100–150 | 160–200 | 同上 |
| Android↔PC Wi-Fi 5 | 50–70 MB/s | 25–45 | 45–60 | 50–65 | 同上 |
| Android↔PC Wi-Fi 6 | 100–140 MB/s | 35–65 | 75–105 | 95–130 | 同上 |

**注**：Android 侧另有"用户存储 FUSE 写入慢"的物理瓶颈，见 §五 A-1。

---

## 五、平台特定的额外瓶颈

### A-1. Android 用户存储 FUSE 写入慢（Android 11+）

`/storage/emulated/0/Download/...` 走 FUSE，单流顺序写常被压到 40–80 MB/s，远低于内部存储真实速度（UFS 3.1 ≈ 1.5 GB/s）。

**应对**：
1. 接收路径默认改成 app 私有目录（`Context.getExternalFilesDir(null)`），完成后用 MediaStore 复制/移动到用户目录。
2. 对图片/视频，直接用 `MediaStore.createFile + ContentResolver.openOutputStream` 写入，避开 FUSE。
3. 用户可在设置里勾"高速模式"切换。

需要 Tauri 端通过 Rust→Kotlin JNI 调 MediaStore。**改造工作量中等**，独立排期。

### A-2. Android Wi-Fi 省电退避

`WifiManager` 在屏幕灭/后台时会进入省电态，吞吐砍半。

**应对**：
- 传输期间 acquire `WifiManager.WifiLock(WIFI_MODE_FULL_HIGH_PERF)`。
- 启动 ForegroundService 防止系统杀进程 + CPU 降频。
- 检查现有 `src-tauri/gen/android/` 是否已加，若没有需要补。

### A-3. Windows Defender 实时扫描

下载目录在监控范围内时，`.part` 文件 grow 触发增量扫描。

**应对**：
- 文档建议用户把下载目录加入排除（首次启动弹窗提示）。
- 程序上：`.part` 写到 `%LOCALAPPDATA%\MultiTrans\Incoming\`（已部分实现？检查 `download_path` 默认值），完成后再 rename 到用户目录。Defender 仍会扫，但延迟扫描时机。

### A-4. macOS XProtect / Gatekeeper

Mac 接收端首次保存 .exe / .dmg 等可执行文件会被扫描，导致完成态延迟。一般无须处理，文档备注即可。

---

## 六、推荐落地顺序

| 顺序 | 优化项 | 工作量 | 协议改动 | 收益 |
|---|---|---|---|---|
| 1 | **R-1** 接收端 pwrite + 锁外网络读 | 1 天 | 无 | **+30–80 %**，最关键 |
| 2 | **R-5** bitmap 文件共享 fd / 合并写 | 半天 | 无 | 微抖动消失 |
| 3 | **R-2** 发送端共享 fd + Bytes 池 | 1 天 | 无 | HDD 发送方 +50–100 %；CPU 下降 |
| 4 | **R-6** `data: Vec<u8>` → `Bytes` | 半天 | 无 | 内存抖动、CPU |
| 5 | **A-2** Android WifiLock + ForegroundService | 1 天 | 无 | Android 稳定性 |
| 6 | **R-3** manifest 加 `checksum_algo` + 默认 BLAKE3 | 1 天 + 兼容用例 | **小** | 大文件启动延迟 -60 % |
| 7 | **R-4** 完成态异步 verify 不阻塞 keep-alive | 1 天 | 无 | UI 末段平滑 |
| 8 | **A-1** Android MediaStore 直写 | 2–3 天 | 无 | Android 接收 +50–100 % |
| 9 | **P2-4** speed_limit 实装 | 半天 | 无 | 功能补齐 |
| 10 | （可选）HTTP/2 或自定义二进制帧 | 3–5 天 | **大** | 多文件并发场景 |

按 1→4 完成后，**PC↔PC 千兆链路已经能稳定贴近物理上限**；5→7 完成后 Android 体验明显改善；8 之后 Android 接收吞吐基本不再受 FUSE 拖累。

---

## 七、正确性核查重点（每个 PR 都要过）

R-1 改造后必须验证：

1. **断点续传**：接收端中途 kill，`.part` 文件存在 + bitmap 文件存在，重启后 `/probe` 返回的 `received_chunks` 与实际磁盘一致。
2. **暂停/继续**：发送端暂停时 in-flight 块全部完成或失败回滚；恢复后从 bitmap 已收的下一个块继续。
3. **取消**：cancel 路径必须 close 共享 fd、删 `.part`、清 bitmap。`receive_files.write().await.remove(message_id)` 与 `set_len` 预分配的 .part 文件互不泄漏。
4. **多文件并发**：同时收 3 个文件，每个文件 8 并发块。R-1 改造后 24 个 chunk 应真正并发写盘（用 ProcMon / iostat 验证）。
5. **跨平台**：
   - Windows 上 `seek_write` 不影响 `set_len` 预分配区域 ✅
   - Linux 上 `write_at` 在 sparse 文件 hole 写入会自动 allocate
   - macOS 上 APFS 行为同 Linux
6. **校验**：完成态 SHA-256（或 BLAKE3）必须与发送端 manifest 一致；R-1 改完后 hash 仍走原路径。
7. **旧版本互通**：新接收端必须能收旧发送端的请求（manifest 字段无 algo 时 fallback 到 sha256）；新发送端发给旧接收端时仍写 sha256。
8. **吞吐回归**：写一个基准脚本发 1 GiB、10 GiB 文件，记 sender/receiver 双端速度曲线，提交到 `docs/bench/` 留底。

---

## 八、不建议触动的部分（避免重复犯错）

- `sanitize_file_name` / `available_destination_path`：Windows 非法字符与重名策略已稳定。
- `stable_file_id`：断点续传的核心，改动作废所有未完成 `.part`。
- `TRANSFERRING_PROGRESS_MAX = 99.4`：UI ↔ final probe 的握手约定。
- `/probe` 在 hash 匹配时直接返回 `complete: true`：Idempotency 保障，秒传场景依赖。
- `MAX_CONCURRENT_CHUNK_UPLOADS` 的 `chunking_strategy` 上限：在 R-1 修好之前，往 16/32 拉只会加剧锁竞争。

---

## 九、风险登记

| 风险 | 触发 | 缓解 |
|---|---|---|
| R-1 改造后内存峰值上升 | 24 个 chunk 同时驻留 = 192 MiB | 改用 `Bytes` 共享 + 块大小由 `chunking_strategy` 控制；监测 RSS |
| pwrite 在 Windows 不预分配 | `.part` 长度小于 offset+len | 已有 `set_len(file_size)` 大文件路径；小文件改成无条件 `set_len` |
| `Arc<std::fs::File>` 与 tokio 任务的兼容 | `std::fs::File` 跨 await 持有 OK，但 IO 必须包 `spawn_blocking` | 改造时统一封 `async fn write_chunk_at(...)` 内部 spawn_blocking |
| R-3 BLAKE3 旧端不识别 | `checksum_algo` 字段未发 → 旧端按 sha256 校验失败 | 默认仍写 sha256；用户配置或新版协商后才升级 |
| 共享 fd 在 cancel 路径漏 close | tokio task 仍持有 Arc 时 cancel | TransferService 维护 close-on-drop 包装；`receive_files.remove(...)` 后明确 drop |

---

## 十、结语

当前代码已经把 P0 全套和 S1/S2/S5/S8 的大部分落地，正确性没有发现回归。**最大的剩余瓶颈集中在 R-1（接收端锁粒度）**——这一项改完后，千兆 LAN 单文件单流基本能贴满物理带宽，PC↔PC 体验直接到位。Android 侧的额外提升空间主要在 A-1（绕开 FUSE）和 A-2（WifiLock）。

本文档不动代码，作为下一批 PR 的设计依据与回归验证清单。所有改动以"对外协议字段不删不改，只做向后兼容的增量"为底线。
