<p align="center">
  <img src="public/ciphertranslocal.svg" width="96" alt="CipherTransLocal Logo" />
</p>

<h1 align="center">CipherTransLocal：局域网消息和文件直传工具</h1>

<p align="center">
  Windows 和 Android 之间互传文字、图片、文件。不用登录账号，不经过网盘，也不用把文件先发到微信、QQ 或其他聊天软件里。
</p>

<p align="center">
  A simple LAN file transfer tool for Windows and Android. It works like a local-network AirDrop alternative for sending messages, photos and files.
</p>

<p align="center">
  <a href="https://lookmateai.github.io/CipherTransLocal/">项目展示页</a>
  ·
  <a href="https://github.com/LookMateAI/CipherTransLocal/releases/latest">下载最新版</a>
  ·
  <a href="#适合谁用">适合谁用</a>
  ·
  <a href="#能做什么">能做什么</a>
  ·
  <a href="#从源码运行">从源码运行</a>
</p>

当前版本：`v1.0.1`

## 先下载哪个

到 [Releases 页面](https://github.com/LookMateAI/CipherTransLocal/releases/latest) 下载安装包。

| 你的设备 | 下载这个文件 |
| --- | --- |
| Windows 电脑，正常安装使用 | `CipherTransLocal_1.0.1_x64-setup.exe` |
| Windows 电脑，需要 MSI 包 | `CipherTransLocal_1.0.1_x64_en-US.msi` |
| Android 手机 | `CipherTransLocal_1.0.1_android_universal.apk` |

Android 安装 APK 时，系统可能会提示“允许安装未知来源应用”。这是因为文件不是从应用商店安装的，按系统提示授权即可。

## 为什么做它

有些文件只是想从手机发到电脑，或者从电脑发到手机。  
用数据线要找线、解锁、切模式；用微信或 QQ 会压缩图片，传大文件也不舒服；用网盘又多了一道上传和下载。

CipherTransLocal 想解决的是这个很普通的问题：两台设备就在同一个 Wi-Fi 下，为什么不能直接传？

打开软件，看到对方设备，点进去发送文字、图片或文件。传过的内容会像聊天记录一样留在会话里，之后想找也方便。

## 适合谁用

- 想把 Android 手机照片、视频、截图传到 Windows 电脑。
- 想把电脑上的 APK、PDF、压缩包、文档发到手机。
- 不想通过微信、QQ、网盘中转私人文件。
- 需要在局域网里传大文件，希望能看到进度和速度。
- 想找一个 Windows 和 Android 之间的 AirDrop 替代工具。
- 临时给同一个 Wi-Fi 下的另一台设备发文字、图片或文件。

## 能做什么

- 在同一个局域网里自动发现 Windows 和 Android 设备。
- 发送文字、图片和普通文件。
- 传大文件时显示进度、速度和状态。
- 传输中可以暂停、继续、取消，失败后也可以重试。
- 接收过的内容会保留历史记录，按设备归类。
- 删除设备或记录前会二次确认，减少误删。
- Windows 端可以在后台托盘运行。
- Android 端做了前台服务和 Wi-Fi 保活，传输时不容易因为退到后台就断掉。
- Android 接收文件可以放到下载目录，也可以选一个自己看得见的目录；图片也可以保存到相册。
- 设置页会显示当前版本，方便确认两端是不是同一版。

## 用起来是什么感觉

它不是一个复杂的同步工具，也不是网盘。  
更像是一个只负责“把这个东西发过去”的小工具。

手机里有几张照片要传给电脑，打开两端，选电脑，发送。  
电脑上有 APK、PDF、压缩包要传给手机，选手机，拖进去或选择文件。  
中途想知道有没有卡住，看进度条和速度就行。

## 使用前看一眼

两台设备需要在同一个 Wi-Fi 或同一个可互通的局域网里。  
如果设备列表里看不到对方，通常不是软件没启动，而是网络不让设备互相发现。

可以检查这些地方：

- 电脑防火墙是否拦截了局域网通信。
- 手机和电脑是不是连到了同一个 Wi-Fi。
- 路由器是否开启了访客网络或 AP 隔离。
- 是否打开了 VPN、代理、热点之类会改变网络出口的工具。

## Android 后台传输

Android 对后台应用比较严格。为了让传输稳定一些，CipherTransLocal 会在需要时显示一个前台服务通知。这个通知的作用是告诉系统：现在正在传文件，不要马上把网络连接挂起。

如果你经常传大文件，建议把它加入系统省电白名单。不同手机厂商的入口不太一样，一般在“电池”“应用启动管理”或“后台运行”里。

## 数据和隐私

文件是在局域网内直接传输的，不需要登录账号，也不需要先上传到第三方云端。

应用会在本机保存设置、设备信息和历史记录。Android 端选择文件时，会经过应用自己的处理流程；传输结束后，临时数据会尽量清理。

局域网不等于绝对安全。建议只在自己信任的网络里使用，也不要随便接收陌生设备发来的文件。

## 从源码运行

需要准备：

- Node.js 18 或更高版本
- Rust stable toolchain
- Tauri 2 需要的系统依赖
- Windows 构建需要 Microsoft C++ Build Tools
- Android 构建需要 Android Studio、JDK、Android SDK、NDK 和 adb

安装依赖：

```bash
npm install
```

启动前端开发服务：

```bash
npm run dev
```

启动桌面端开发模式：

```bash
npm run tauri dev
```

构建 Windows 桌面端：

```bash
npm run tauri build
```

构建 Android APK：

```bash
npm run tauri android build --apk
```

Android 正式发布时需要使用自己的签名文件。签名文件、密钥和本地签名配置不要提交到仓库。

## 技术栈

- React、TypeScript、Vite、Tailwind CSS
- Tauri 2
- Rust、Tokio、SQLite
- Tauri Android、Kotlin、Android WebView

## 开源前提醒

仓库已经忽略了常见构建产物、本地截图、Android 签名文件和密钥。  
如果你 fork 或重新发布，仍建议自己检查一遍，不要把私人签名文件、日志、测试截图一起提交。

当前仓库还没有指定许可证。正式开源前，建议补一个 `LICENSE` 文件。
