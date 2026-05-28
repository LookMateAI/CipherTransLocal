<p align="center">
  <img src="public/ciphertranslocal.svg" width="96" alt="CipherTransLocal Logo" />
</p>

<h1 align="center">CipherTransLocal</h1>

<p align="center">
  一款面向 Windows 和 Android 的局域网传输工具。不用登录账号，不用把文件传到云端，只要设备在同一个局域网里，就可以像聊天一样发送文字、图片和文件。
</p>

<p align="center">
  <a href="https://github.com/LookMateAI/CipherTransLocal/releases/latest">下载最新版</a>
  ·
  <a href="#主要卖点">主要卖点</a>
  ·
  <a href="#从源码运行">从源码运行</a>
</p>

当前版本：`v1.0.1`

## 下载安装

请到 [GitHub Releases](https://github.com/LookMateAI/CipherTransLocal/releases/latest) 下载适合你设备的安装包。

| 平台 | 推荐文件 | 说明 |
| --- | --- | --- |
| Windows | `CipherTransLocal_1.0.1_x64-setup.exe` | 推荐普通用户使用，双击安装即可 |
| Windows | `CipherTransLocal_1.0.1_x64_en-US.msi` | 适合需要 MSI 包的管理或部署场景 |
| Android | `CipherTransLocal_1.0.1_android_universal.apk` | 下载到手机后安装，首次使用需允许必要权限 |

## 它解决什么问题

很多时候，我们只是想把手机里的照片发到电脑，或者把电脑上的安装包、文档、压缩包传到手机。用数据线麻烦，用聊天软件会压缩图片，传大文件还可能慢、断、占云端空间。

CipherTransLocal 的目标很简单：让同一局域网里的设备可以直接互传。打开软件，看到设备，拖文件或选择文件发送。传输记录像聊天消息一样保留下来，之后也能回头找。

它更适合那些“不想折腾，只想把文件发过去”的场景：手机和电脑在同一个 Wi-Fi 下，打开应用，选择设备，直接发送。

## 主要卖点

- **局域网直连**：文件在设备之间点对点传输，不经过第三方云端中转。
- **电脑和手机互传**：支持 Windows 桌面端和 Android 端，适合日常跨设备传文件。
- **像聊天一样自然**：文字、图片、文件都在同一个会话里，传过什么一眼能看到。
- **自动发现设备**：同一网络下自动发现在线设备，减少手动输 IP 的麻烦。
- **大文件更稳**：分块传输、进度显示、暂停、继续、取消、重试，网络波动时更容易恢复。
- **后台连接优化**：Android 端使用前台服务和 Wi-Fi 保活策略，桌面端支持后台托盘运行，尽量减少退到后台就离线的问题。
- **接收位置可控**：Android 可保存到下载目录，也可以选择自定义可见目录，图片还能额外保存到系统相册。
- **更少打扰**：传输完成、失败和接收时有通知；删除设备和记录前会二次确认，降低误操作。

## 功能一览

| 功能 | 说明 |
| --- | --- |
| 自动设备发现 | 在同一局域网内发现 Windows / Android 设备，并显示在线状态 |
| 文本发送 | 支持像聊天一样发送短文本、剪贴板内容 |
| 图片发送 | 支持选择图片发送，Android 端可把接收图片保存到相册 |
| 文件发送 | 支持常见文件类型和大文件传输 |
| 传输进度 | 显示进度、速度、状态，便于判断是否卡住 |
| 传输控制 | 支持暂停、继续、取消、失败后重试 |
| 断点续传 | 文件按块写入，异常中断后可尽量复用已完成部分 |
| 历史记录 | 按设备保留聊天和传输历史，方便回看 |
| 设备管理 | 支持设备名称、历史设备、在线 / 离线状态展示 |
| 删除确认 | 删除设备或记录前弹出确认，避免误删 |
| 后台保活 | Android 前台服务、Wi-Fi 锁和桌面托盘后台运行 |
| 接收目录 | 桌面端可选下载目录，Android 端支持下载目录和自定义目录 |
| 外观设置 | 支持浅色 / 深色主题 |
| 版本展示 | 桌面端和 Android 端设置页都会显示当前版本号 |

## 适合这些场景

- 手机照片、视频发到电脑整理。
- 电脑上的 APK、PDF、压缩包发到手机。
- 不想通过微信、QQ、网盘中转私人文件。
- 临时给同一 Wi-Fi 下的另一台设备传文件。
- 局域网环境下传大文件，希望能看到进度并支持重试。

## 使用方式

1. 在电脑和 Android 手机上都打开 CipherTransLocal。
2. 确认两台设备连接到同一个 Wi-Fi 或同一个可互通的局域网。
3. 在设备列表里选择对方设备。
4. 发送文字、图片或文件。
5. 接收完成后，可以在历史记录里查看，也可以到设置的接收目录里找到文件。

如果设备没有出现，通常和网络环境有关。可以检查防火墙、路由器 AP 隔离、访客 Wi-Fi、VPN 或热点网络设置。

## Android 端说明

Android 系统会限制后台应用的网络活动。为了让传输过程更稳定，CipherTransLocal 会在需要时使用前台服务，并显示一个系统通知。这样做的目的不是打扰用户，而是告诉系统：当前正在进行局域网连接和文件传输，请不要轻易挂起。

建议在传输大文件时：

- 保持两台设备在同一个稳定 Wi-Fi 下。
- 不要频繁切换网络、VPN 或热点。
- 如果系统有省电白名单，可以把应用加入白名单。
- 大文件传输过程中尽量不要强行清理后台。

## 隐私与数据

CipherTransLocal 的设计原则是：能在本地完成的事情，就不交给云端。

- 文件通过局域网在设备之间传输。
- 不需要登录账号。
- 不依赖第三方云端服务器中转文件。
- 设备信息、设置和历史记录保存在本机。
- Android 端选择的文件会进入应用处理流程，传输结束后会尽量清理临时数据。

仍需注意：局域网本身不是绝对安全环境。请只在可信网络中使用，并避免接收来源不明的文件。

## 从源码运行

### 环境要求

- Node.js 18 或更高版本
- Rust stable toolchain
- Tauri 2 所需系统依赖
- Windows 构建需要 Microsoft C++ Build Tools
- Android 构建需要 Android Studio、JDK、Android SDK、NDK 和 adb

### 安装依赖

```bash
npm install
```

### 前端开发模式

```bash
npm run dev
```

### 桌面端开发模式

```bash
npm run tauri dev
```

### 构建桌面端

```bash
npm run tauri build
```

构建完成后，Windows 安装包通常会出现在：

```text
src-tauri/target/release/bundle/
```

### 构建 Android 端

```bash
npm run tauri android build --apk
```

Android 发布包需要使用自己的签名文件。签名文件、密钥和本地签名配置不要提交到仓库。

## 技术栈

- 前端：React、TypeScript、Vite、Tailwind CSS、Zustand
- 桌面端：Tauri 2
- 后端：Rust、Tokio、SQLite
- Android：Tauri Android、Kotlin、Android WebView

## 项目标识

- 应用名称：`CipherTransLocal`
- npm 包名：`ciphertranslocal`
- Rust crate：`ciphertranslocal`
- Android applicationId：`com.ciphertranslocal.app`
- Tauri identifier：`com.ciphertranslocal.app`

## 发布前提醒

如果准备推送到 GitHub，建议确认：

- 不提交 `node_modules/`、`dist/`、`src-tauri/target/`、Android `build/` 等构建目录。
- 不提交 Android 签名文件、密钥、证书和本地配置。
- 不提交包含个人信息的调试截图、日志或测试文件。
- 保留 `package-lock.json` 和 `src-tauri/Cargo.lock`，方便复现依赖版本。
- 补充合适的 `LICENSE` 文件，明确开源许可证。

## 许可证

当前仓库尚未指定许可证。正式开源前，建议根据你的发布目标选择 MIT、Apache-2.0、GPL 等许可证之一。
