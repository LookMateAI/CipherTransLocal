# 局域网传输速度抖动诊断（11→40 MB/s 跳变）

更新时间：2026-05-12
作用范围：`src-tauri/src/transfer.rs`
前置：`LAN_TRANSFER_OPTIMIZATION_2026-05-12.md` 中 P0/P1 改造已完成（keep-alive、Client 单例、`TCP_NODELAY`、bitmap、动态分块、接收端节流）。

---

## 一、现象

- 单条传输速度肉眼可见在 11 MB/s 和 40 MB/s 之间跳动
- 千兆 LAN 理论 117 MB/s，目前长期跑不满
- 速度并非平滑下降，而是脉冲式：一段快、一段慢、再一段快

## 二、第一版优化做完后仍然存在的瓶颈

下面是按"对吞吐稳定性的影响"从高到低排序的、**前一版方案没有覆盖到**的真实瓶颈，全部对照当前 `transfer.rs` 代码逐条核对过。

### S1. 接收端 256 KiB 拼接式读写【影响：极高，第一嫌疑】

位置：`handle_chunk` L1216–L1223

```rust
let mut buffer = vec![0u8; 256 * 1024];
while remaining > 0 {
    let read_len = remaining.min(buffer.len());
    reader.read_exact(&mut buffer[..read_len]).await?;
    file.write_all(&buffer[..read_len]).await?;
    remaining -= read_len;
}
```

**问题**：一个 8 MiB chunk 被切成 32 段，每段都做"读 socket → 写盘 → 等盘 → 再读 socket"。

- 写盘期间 socket 端不再消费，TCP 接收窗逐步逼近满，发送端 cwnd 收缩
- 读 socket 期间盘不再写，磁盘队列空闲
- 两边的"满管"时间严重不重叠，等价于把吞吐限制在 `min(网卡, 磁盘) / 2`

这是 11 MB/s 抖动的最大单一原因。

**修法**：

1. **改成"先全读，再批写"或"专门的写盘任务"**。最简单的版本：

   ```rust
   let mut body = vec![0u8; len];
   reader.read_exact(&mut body).await?;
   // 现在 socket 端释放，TCP 窗口立刻打开
   file.write_all(&body).await?;
   ```

   但这样吃 8 MiB × 并发 = 64 MiB 内存，且没有并行。

2. **更好：socket 读和磁盘写两条管线，中间一个 `mpsc::channel<Bytes>` 深度 4**。读完一段就丢进 channel，写任务异步消费。每个 chunk 一对短任务即可。

3. **再好一档：用 `tokio::io::copy_buf` + 大 buffer（1–4 MiB）`**。一行代码就能改：

   ```rust
   use tokio::io::AsyncReadExt;
   let mut limited = reader.take(len as u64);
   let mut buf = tokio::io::BufWriter::with_capacity(2 * 1024 * 1024, &mut file);
   tokio::io::copy(&mut limited, &mut buf).await?;
   buf.flush().await?;
   ```

   `copy` 内部会用 8 KiB 之类的小缓冲；要大缓冲就显式 `copy_buf` + `BufReader::with_capacity(2 MiB, reader)`。

**预期收益**：单流吞吐 +50–100 %，并且首要的"脉冲"消失。

### S2. `BufReader` 默认 8 KiB 容量【影响：高】

位置：`start_http_server` L148

```rust
let mut buf_reader = tokio::io::BufReader::new(reader);
```

Tokio `BufReader::new` 默认 8 KiB。一个 8 MiB chunk body 要 1024 次 syscall + 1024 次 memcpy。

**修法**：

```rust
let mut buf_reader = tokio::io::BufReader::with_capacity(256 * 1024, reader);
```

或者上 2 MiB（与 socket 接收缓冲对齐）。注意：header 解析阶段并不需要这么大，但浪费的内存可控（每连接固定一份）。

**预期收益**：CPU 占用下降 30–50 %，间接缓解 S1 的拖累。

### S3. 接收端每块都 `OpenOptions::open` + 隐式 close【影响：高，脉冲第二嫌疑】

位置：`handle_chunk` L1206–L1226

```rust
let mut file = tokio::fs::OpenOptions::new()
    .create(true)
    .write(true)
    .open(&part_path)
    .await?;
...
// file 在函数末尾 drop → close → 触发 OS 把脏页推入 write-back 队列
```

Windows 上 `CloseHandle` 会推进 NTFS 元数据更新，并把脏页加入懒写队列。8 个并发 chunk 任务同时 open / close 同一个 `.part`，在 NTFS cache 内部抢锁；当系统脏页超过阈值（约可用内存 10 %）后开始节流写，**这正好是"先快后慢"脉冲的来源**。

**修法**：

把 `.part` 文件句柄做成 message_id 级别的共享 `Arc<Mutex<tokio::fs::File>>` 或 `Arc<tokio::fs::File>` + 并发写位置由 `write_at`/`seek+write` 控制（需要在 Mutex 下做 seek-write 序列）。

更好的方案：拿到首个 chunk 时打开句柄并 `set_len(file_size)`（已经有），存进 `TransferService` 一个 `open_files: HashMap<message_id, Arc<Mutex<File>>>`，完成或取消时关闭。后续 chunk 直接用同一 fd 走 seek+write。

**预期收益**：脉冲消失大半；写吞吐稳定。
**注意**：句柄表必须在 cancel/fail/complete 三条路径都关掉，否则会泄漏。

### S4. 发送端每块都 `tokio::fs::File::open`【影响：中】

位置：`send_chunk` L1098

```rust
async fn send_chunk(...) -> anyhow::Result<(u64, u64)> {
    ...
    let mut file = tokio::fs::File::open(path).await?;
    file.seek(SeekFrom::Start(offset)).await?;
    let mut buf = vec![0u8; length];
    file.read_exact(&mut buf).await?;
    post_chunk(client, target_ip, manifest, chunk_index, buf).await?;
}
```

- 每块开关一次 fd（虽然读不脏化页缓存，但 syscall 与 ARC 开销叠加）
- 每块分配 8 MiB `Vec<u8>`（8 并发 = 64 MiB allocate/free 抖动）
- 同一文件 8 个并发 seek 在机械盘上是 seek 风暴；SSD 上影响小但仍非最优

**修法**：

1. fd 共享：发送端也按 message_id 维护一个 `Arc<Mutex<std::fs::File>>`（或 `tokio::fs::File`），所有 chunk 任务共享。`spawn_blocking` 里用同步 `seek_read`/`read_at` 平台相关 API（Linux `pread`、Windows `seek+ReadFile`，可借 `std::os::windows::fs::FileExt::seek_read`）；避免共享 fd 的 seek 串行化问题。

2. **缓冲池**：用 `bytes::BytesMut` + 池化（`bytes::Bytes` 是引用计数，分发到 reqwest 不再拷贝）。

3. 顺序读取 + 队列分发：起一个独立 reader 任务按顺序读，把 `(idx, Bytes)` 推进 channel；上传任务从 channel 取。这对机械盘是质变。

**预期收益**：HDD 发送方 +100 %、SSD 发送方 +10–20 %、内存抖动消失。

### S5. `receive_lock` 包了过多串行步骤【影响：中】

位置：`handle_chunk` L1228–L1267

```rust
let _receive_guard = receive_lock.lock().await;
migrate_legacy_chunks_if_needed(...).await?;
mark_chunk_received(&bitmap_path, ...).await?;
let received = read_received_chunks_bitmap(&bitmap_path, ...).await?;
let received_bytes = received.iter().map(...).sum::<u64>();
// 还有 receive_stats.write() 计算速度
```

8 个并发 chunk 写盘完成后全部到这里排队。每个排队 1–3 ms，最坏 8 × 3 = 24 ms 串行延迟，正好凑成一个能感知的吞吐抖动。

**修法**：

1. bitmap 状态搬进内存：`HashMap<message_id, BitVec>` + 一个轻量同步锁（`parking_lot::Mutex`），bit set 是 O(1) 不再读文件。
2. bitmap 文件仅在完成或暂停 / 取消 / 关闭时整盘 flush，进程崩溃后下次仍能从 .part + 文件大小 + 已知"完整 chunk 边界"恢复（断点续传逻辑保留）。
3. `received_bytes` 用 `AtomicU64` 累加器，不要每次扫整位图。
4. 完成态进入慢路径（hash + rename）才上锁，普通 chunk 路径走 lock-free 累加。

**预期收益**：高并发下的微抖动消失；接收端 CPU 下降。

### S6. 完成时同步 SHA-256 整文件阻塞 keep-alive 连接【影响：中】

位置：`handle_chunk` L1286–L1294

```rust
let final_hash = tokio::task::spawn_blocking({
    let part_path = part_path.clone();
    move || sha256_file(&part_path)
}).await??;
```

- 1 GB 文件 SATA SSD ~3 s、HDD ~10 s
- 这段时间里运行 `handle_chunk` 的那条 keep-alive 连接整个挂起，本连接上的下一个请求要等
- 进度条会出现一段"99.4 % 不动"再"100 %"的跳变

**修法**：

1. 让客户端等是合理的（最终校验必须等），但**不要阻塞连接**。在 last chunk 提前一点写一个响应（"writing"），然后异步算 hash，hash 完通过 `notify_remote_status("completed")` 走单独连接通知。但这会改语义。
2. **更现实**：完成时算 hash 在 `spawn_blocking` 里同时**用 `tokio::task::yield_now` 让出**，并把"hash 中"作为一个独立状态对前端可见（"verifying"），UX 上不再像卡顿。
3. **更激进**：分块哈希（每收到一块算一段 SHA-256），最终只合并；牺牲少量内存换 hash 时间 ≈ 0。需要协议加一个"chunk-level checksum"字段，留待下一版协议。
4. **并行 SHA-256**：用 `blake3` 替换 SHA-256（多线程友好，几乎是 SHA-256 的 5–10 倍速度）。但这会改 checksum 字段语义，老端不兼容。可在 manifest 加 `checksum_algo` 字段，默认 sha256，新端协商升级。

**预期收益**：UX 改善；总耗时减少 1–3 秒（大文件）。

### S7. `reqwest` 连接池可能在多 chunk 之间复用同一连接，导致串行【影响：中—需要验证】

`pool_max_idle_per_host(MAX_CONCURRENT_CHUNK_UPLOADS * 4) = 12`，理论够。但 reqwest 内部把"对同一 host 的并发请求"分配给空闲连接前，**会先尝试复用最久未使用的连接**。如果第一个 chunk 完成得早，它的连接回到池中，然后 reqwest 在派发下一批时，**优先用池里的而不是开新的**——只要池里有，开新连接的速度会被压制，最坏情况是"所有 chunk 串行用一两条连接"。

**验证方法**：在 Wireshark/tcpdump 抓包数 SYN 包数量。8 并发理应有 ≥ 8 条独立 TCP 流。

**修法**：

1. 在 sender 侧绕过连接池：手动管理一组持久 TCP socket，自己 framing。这是 P2 级改动。
2. 折中：发送时 spawn 任务之间不互等空闲连接，但保留 keep-alive。可考虑在 `Client` 上加 `.pool_max_idle_per_host(0)` —— 每次新连接，丢失复用但拿到稳定并发。**反例**：HTTPS 时握手昂贵，HTTP 上 SYN 仅 1 RTT，LAN 上约 0.2 ms，可接受。
3. 走 HTTP/2 多路复用：单连接多 stream，但 server 端要重写。**P2/P3**。

**预期收益**：稳定满并发；并发数才真正生效。

### S8. 进度统计窗口跳变导致 UI 上看到"忽快忽慢"【影响：低，但影响"看上去的稳定性"】

位置：`run_send_task` L905–L950

```rust
let elapsed = speed_window_at.elapsed().as_secs_f64().max(0.001);
let speed = (sent_bytes.saturating_sub(speed_window_bytes) as f64 / elapsed) as u64;
...
if elapsed >= 0.75 {
    speed_window_at = now;
    speed_window_bytes = sent_bytes;
}
```

窗口在 0.75 s 处重置。如果一个 chunk 恰好在 0.74 s 完成，速度算的是 0.74 s 内的字节数；下一块完成时窗口是 0.01 s 起的几十毫秒，**算出的瞬时速度会很高**；再下一块完成时窗口重置后只有 100 ms 又会算出低速。**这本身就会让 UI 抖**。

**修法**：

改成滑动窗口（移动平均），如保留最近 2 秒的 `(timestamp, bytes)` 序列，每次插入并丢弃 2 秒前的。或 EMA：

```rust
const EMA_ALPHA: f64 = 0.3;
let instant = (delta_bytes as f64) / delta_t;
self.speed_ema = EMA_ALPHA * instant + (1.0 - EMA_ALPHA) * self.speed_ema;
```

**预期收益**：UI 显示稳定，**实际吞吐不变**；但"看起来稳定"对用户感知一样重要。

### S9. Windows Defender / 杀软实时扫描【影响：高，但属于环境因素】

如果接收端的下载目录在 Defender 监控范围里（默认所有用户目录都在），每次 `.part` 文件 grow 都会触发增量扫描。对大文件，扫描会在每次 close 后排队，制造典型的"快慢交替"。

**应对**：

- 文档化建议：把下载目录加入 Defender 排除（用户操作）。
- 程序内：传输期间用 `*.mttmp` 隐藏后缀；完成 + 校验后才 rename 成最终名。Defender 仍会扫描，但部分场景能延迟扫描时机。
- 已经做了 rename 这一步（L1297 `tokio::fs::rename(&part_path, &final_path)`），但 `.part` 本身仍在被扫。改成放在子目录 `.partials/` 或 `%LOCALAPPDATA%\MultiTrans\Incoming\` 也许可以拐过部分策略。

### S10. 真实物理瓶颈：HDD / Wi-Fi【影响：决定性】

- 机械硬盘顺序写 ~80–150 MB/s、随机写 ~10–30 MB/s。8 个并发 seek + write 会触发频繁磁头移动，落在 20–40 MB/s 完全正常。
- Wi-Fi 5 单流半双工 ~40–80 MB/s 理论值，实际 30–50 MB/s。
- USB 网卡：500 Mbps 实测 ~50 MB/s。

**修法**：

不动代码，要打印物理通路。在 UI 里展示一行"当前限速：网卡 / 磁盘"诊断信息：
- 起一个简单的 disk benchmark（写 100 MiB 顺序，测出本机磁盘速度上限）。
- 同时上报对端 disk benchmark。
- 进度页显示理论上限和当前实际，让用户知道是磁盘瓶颈还是网络瓶颈。

如果 11 MB/s 是磁盘上限，那任何代码层的优化都不会再快。

## 三、推荐的下一步顺序（按性价比）

| 顺序 | 工作量 | 风险 | 预期 |
|---|---|---|---|
| 1. S1（接收端读写解耦或大缓冲 copy） | 半天 | 低 | +50–100 % 单流 |
| 2. S2（BufReader 容量调大） | 5 分钟 | 极低 | CPU -30 %、配合 S1 见效 |
| 3. S3（接收端 fd 共享） | 1 天 | 中（要保证 cancel/fail 清理） | 脉冲消失大半 |
| 4. S5（bitmap 内存化） | 1 天 | 低 | 微抖动消失 |
| 5. S4（发送端 fd 共享 + Bytes 池） | 1 天 | 中 | HDD 发送方 +100 % |
| 6. S8（速度统计 EMA） | 30 分钟 | 极低 | UI 稳定，与吞吐无关 |
| 7. S7（pool 行为验证 + 必要时禁用复用） | 半天 | 低 | 视抓包结果定 |
| 8. S6（hash 阶段不阻塞连接 / blake3） | 1 天 | 中（协议） | 末段不再卡顿 |
| 9. S9（下载子目录 + 文档建议加 AV 排除） | 半天 | 低 | 视环境而定 |
| 10. S10（磁盘 benchmark + UI 上报上限） | 1 天 | 低 | UX |

完成 S1+S2+S3+S5+S8 之后，千兆 LAN 单流应稳定在 105–115 MB/s，且 UI 显示平滑。

## 四、快速自测脚本

为了量化"到底卡在哪一段"，建议在 `transfer.rs` 上加 feature-gated trace（不进生产）：

```rust
#[cfg(feature = "trace-transfer")]
{
    let t0 = Instant::now();
    // read socket
    let t1 = Instant::now();
    // write disk
    let t2 = Instant::now();
    // bitmap update
    let t3 = Instant::now();
    eprintln!(
        "chunk={} read={}ms disk={}ms bitmap={}ms total={}ms",
        chunk_index,
        (t1 - t0).as_millis(),
        (t2 - t1).as_millis(),
        (t3 - t2).as_millis(),
        (t3 - t0).as_millis(),
    );
}
```

跑一次 1 GiB 文件，看 `read`/`disk`/`bitmap` 三段的分布。

- `read` 高且抖 → 网络 / S2 / 对端发送慢
- `disk` 高且抖 → S3 / S10 / AV
- `bitmap` 高 → S5

不动主代码也能开一个临时分支测，回归后删掉。

## 五、与第一版方案不冲突项

`LAN_TRANSFER_OPTIMIZATION_2026-05-12.md` 里的 P1-1（动态并发与块大小）已经落地为 `chunking_strategy`，当前 1 GiB 以上文件是 8 MiB × 8。**这个 8 在 SSD + 千兆下基本够**；继续调大并不会再涨，瓶颈在 S1/S3。

P1-2 的并行 SHA-256（rayon）仍值得做，配合 S6 一起，把"完成态"打磨好。

P2-4 的 speed_limit 实装与本次抖动无关，独立排期。

## 六、不建议改的部分

- 不要把 `MAX_CONCURRENT_CHUNK_UPLOADS` 继续往上拉到 16 / 32。在 S1/S3 未解决前，更高并发只会加剧脉冲和锁竞争，吞吐反而下降。
- 不要为了"稳"把 chunk_size 缩小回 1 MiB。小 chunk 让 HTTP header 开销和 syscall 频率上升，更糟。
- 不要为了校验稳一点而禁掉 keep-alive，那样会立刻丢掉 30 % 吞吐。

## 七、风险登记

| 风险 | 触发 | 缓解 |
|---|---|---|
| 接收端共享 fd 在 cancel 后未 close | cancel 路径漏 drop | TransferService 维护 `Drop` 实现，message 取消/失败/完成统一调 `close_open_file(message_id)` |
| 内存 bitmap 进程崩溃后丢失 | 强杀进程 | `.part` 文件长度 + manifest.total_chunks/chunk_size 可推算"理应已收"边界；启动时扫一遍重建 bitmap 文件 |
| 大缓冲（2–4 MiB BufReader/Writer）增加内存 | 多并发传输 | 每连接独立 BufReader 受 keep-alive 数量限制（通常 ≤ 16）；BufWriter 池化在 message 级 |
| 取消 SHA-256 in-flight | 用户取消时 spawn_blocking 还在跑 | 不强制取消，让它跑完丢弃结果即可；磁盘文件已 rename 失败时不影响断点续传 |
