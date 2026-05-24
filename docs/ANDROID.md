# MultiTrans Android 适配说明

更新时间：2026-05-08

## 当前状态

项目代码已经做了 Android 共用适配：

- Rust 已安装 Android targets：`aarch64-linux-android`、`armv7-linux-androideabi`、`i686-linux-android`、`x86_64-linux-android`。
- 设备发现会在 Android 上广播 `device_type = "android"`。
- 后端设备名读取去掉了阻塞式 runtime 调用，更适合移动端运行。
- 前后端主构建仍可通过 `npm run build` 和 `cargo test` 验证。

当前机器已配置 SDK：

- `ANDROID_HOME = D:\Android\Sdk`
- `ANDROID_SDK_ROOT = D:\Android\Sdk`
- `NDK_HOME = D:\Android\Sdk\ndk\28.2.13676358`
- `ANDROID_NDK_HOME = D:\Android\Sdk\ndk\28.2.13676358`

Android 工程已生成：

```text
src-tauri/gen/android/
```

已补 Android 权限：

- `INTERNET`
- `ACCESS_NETWORK_STATE`
- `ACCESS_WIFI_STATE`
- `CHANGE_WIFI_MULTICAST_STATE`
- `POST_NOTIFICATIONS`

已调整：

- Release 默认允许 cleartext traffic，保证当前局域网 HTTP 传输可用。后续实现传输加密后应收紧。
- `reqwest` 改为 `rustls-tls`，避免 Android 交叉编译依赖 OpenSSL。
- Rust app 入口已改为 Tauri mobile entry point 标准结构。
- Gradle 仓库已增加 Aliyun Google Maven / Maven Central 镜像，规避当前机器访问 `dl.google.com` 时的 TLS 握手失败。
- Android 启动期下载目录增加应用私有目录兜底，避免公共 Downloads 在 scoped storage 下不可写导致启动 panic。
- Android 本机 IP 获取失败时使用 `0.0.0.0` 继续启动，避免无网络/权限状态下直接退出。
- 重新生成 debug APK 前清理 `jniLibs` 残留，只保留当前 `aarch64` 目标的 `arm64-v8a` 动态库。
- 已使用本地 keystore 对 release APK 完成 zipalign 和 v2/v3 签名；该 keystore 仅适合本机测试签名，不应作为正式上架密钥。
- Android 启动兜底增强：UDP 发现端口占用时回退到临时端口，HTTP 传输端口绑定失败时只停用传输服务，不再让主界面直接闪退。
- 移除 `MainActivity` 的 `enableEdgeToEdge()` 调用，降低 Android 新版本窗口初始化兼容风险。
- 修复 release 包闪退：release minify 会处理 Tauri/Wry 的 Kotlin 方法，导致 Rust/tao 通过 JNI 调用 `WryActivity.getId()` 时抛出 `JavaException`；已增加 `proguard-multitrans.pro` 保留 JNI 需要的方法。
- Android 接收下载目录固定使用应用私有目录 `/data/user/0/com.multitrans.app/downloads`，避免默认路径解析为 `/`。
- 已通过 ADB 在 RMX5010 / Android 16 真机验证：安装最新 signed release APK 后启动 8 秒进程仍在，`logcat -b crash` 无新增崩溃，日志输出 `MultiTrans initialized successfully`。

当前 Android 构建状态：

- Rust Android `aarch64` 动态库可以成功编译。
- APK 已成功构建。

当前产物：

```text
D:\ZeroProject\MultiTrans\src-tauri\gen\android\app\build\outputs\apk\universal\release\app-universal-release-unsigned.apk
D:\ZeroProject\MultiTrans\src-tauri\gen\android\app\build\outputs\apk\universal\release\app-universal-release-signed.apk
D:\ZeroProject\MultiTrans\src-tauri\gen\android\app\build\outputs\apk\universal\debug\app-universal-debug.apk
```

最新签名 release APK：

```text
D:\ZeroProject\MultiTrans\src-tauri\gen\android\app\build\outputs\apk\universal\release\app-universal-release-signed.apk
大小约 19.87 MB
生成时间：2026-05-08 11:19:10
```

构建命令：

```bash
npm run tauri -- android build --target aarch64 --apk
npm run tauri -- android build --target aarch64 --debug --apk
```

release APK 本地签名流程：

```powershell
D:\Android\Sdk\build-tools\36.1.0\zipalign.exe -p -f 4 app-universal-release-unsigned.apk app-universal-release-aligned.apk
D:\Android\Sdk\build-tools\36.1.0\apksigner.bat sign --ks src-tauri\gen\android\multitrans-release.jks --ks-key-alias multitrans-release --out app-universal-release-signed.apk app-universal-release-aligned.apk
D:\Android\Sdk\build-tools\36.1.0\apksigner.bat verify --verbose --print-certs app-universal-release-signed.apk
```

## 必装环境

安装 Android Studio，并在 SDK Manager 中安装：

- Android SDK Platform
- Android SDK Platform-Tools
- Android SDK Build-Tools
- Android SDK Command-line Tools
- Android NDK

建议环境变量：

```powershell
$env:ANDROID_HOME = "$env:LOCALAPPDATA\Android\Sdk"
$env:ANDROID_SDK_ROOT = "$env:ANDROID_HOME"
$env:NDK_HOME = "$env:ANDROID_HOME\ndk\<installed-ndk-version>"
$env:Path += ";$env:ANDROID_HOME\platform-tools;$env:ANDROID_HOME\cmdline-tools\latest\bin"
```

长期配置应写入 Windows 用户环境变量，而不是只在当前 PowerShell 会话中设置。

## 环境检查

项目提供了检查脚本：

```powershell
.\scripts\check-android-env.ps1
```

检查项：

- `ANDROID_HOME`
- `ANDROID_SDK_ROOT`
- `NDK_HOME`
- `adb`
- `sdkmanager`
- Android Rust targets
- Tauri CLI 版本

## 初始化 Android 工程

SDK 配好后执行：

```bash
npm run tauri -- android init
```

成功后应生成：

```text
src-tauri/gen/android/
```

之后需要重点检查：

- `src-tauri/gen/android/app/src/main/AndroidManifest.xml`
- Android package/applicationId 是否匹配 `com.multitrans.app`
- 网络权限是否包含 `INTERNET`、`ACCESS_NETWORK_STATE`、`ACCESS_WIFI_STATE`、`CHANGE_WIFI_MULTICAST_STATE`
- Android 13+ 如需通知，再补 `POST_NOTIFICATIONS`
- 文件读写策略是否符合目标 Android 版本的 scoped storage

## 开发运行

连接真机并打开 USB 调试：

```bash
adb devices
npm run tauri -- android dev
```

构建 APK：

```bash
npm run tauri -- android build
```

产物位置通常在：

```text
src-tauri/gen/android/app/build/outputs/apk/
```

## Android 端重点风险

### 1. UDP 广播和组播锁

Android 上 UDP 广播/组播可能受 Wi-Fi MulticastLock、系统省电策略和厂商限制影响。初始化 Android 工程后，需要验证：

- Windows 能发现 Android。
- Android 能发现 Windows。
- 锁屏后发现状态是否失效。

必要时需要在 Android 原生层申请 Wi-Fi multicast lock。

### 2. 文件访问权限

当前桌面端使用 Tauri dialog 返回本地路径。Android 上 scoped storage 可能返回 URI 或受限路径，后续需要确认 Tauri dialog 在 Android 的返回值行为。

需要验证：

- Android 选择文件后 Rust 端是否能读取。
- 接收文件能否写入 Downloads 或应用私有目录。
- 用户是否能从系统文件管理器看到接收文件。

### 3. 后台传输

大文件传输过程中，Android 锁屏、切后台或系统省电可能中断任务。后续如果要可靠后台传输，需要设计前台服务或通知保活策略。

## 推荐推进顺序

1. 安装 Android Studio/SDK/NDK，跑通 `scripts/check-android-env.ps1`。
2. 执行 `npm run tauri -- android init`。
3. 补 Android Manifest 权限。
4. 真机运行 `npm run tauri -- android dev`。
5. 验证设备发现。
6. 验证文本发送。
7. 验证小文件发送。
8. 验证大文件分块续传。
9. 再处理 scoped storage、MulticastLock、后台传输。
