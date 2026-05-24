# MultiTrans 开发文档

## 项目概述

MultiTrans 是一款基于 Tauri 2.0 和 Rust 开发的跨平台局域网文件传输工具，支持 Windows 和 Android 平台。

## 技术栈

### 前端
- **框架**: Tauri 2.0
- **UI 库**: React 18 + TypeScript
- **样式**: TailwindCSS
- **状态管理**: Zustand
- **图标**: Lucide React
- **构建工具**: Vite

### 后端
- **语言**: Rust
- **异步运行时**: Tokio
- **数据库**: SQLite (rusqlite)
- **序列化**: serde + serde_json

## 项目结构

```
MultiTrans/
├── src/                      # 前端源代码
│   ├── components/           # React 组件
│   │   ├── DeviceList.tsx    # 设备列表组件
│   │   ├── ChatWindow.tsx    # 聊天窗口组件
│   │   └── FileItem.tsx      # 文件项组件
│   ├── stores/               # 状态管理
│   │   └── useStore.ts       # Zustand store
│   ├── types/                # TypeScript 类型定义
│   │   └── index.ts
│   ├── App.tsx               # 主应用组件
│   ├── main.tsx              # 入口文件
│   └── index.css             # 全局样式
├── src-tauri/                # Rust 后端源代码
│   ├── src/
│   │   ├── main.rs           # 主入口
│   │   ├── lib.rs             # 库入口
│   │   ├── models.rs          # 数据模型
│   │   ├── discovery.rs       # 设备发现模块
│   │   ├── transfer.rs        # 文件传输模块
│   │   ├── db.rs              # 数据库模块
│   │   └── commands.rs        # Tauri 命令
│   ├── Cargo.toml             # Rust 依赖配置
│   └── tauri.conf.json        # Tauri 配置
├── docs/                      # 文档
│   ├── PRD.md                 # 产品需求文档
│   └── DEVELOPMENT.md         # 本文档
├── package.json               # NPM 配置
├── vite.config.ts             # Vite 配置
├── tailwind.config.js         # Tailwind 配置
└── tsconfig.json              # TypeScript 配置
```

## 快速开始

### 环境要求

- Node.js >= 18
- Rust >= 1.70
- npm >= 9

### 安装依赖

```bash
# 安装前端依赖
npm install

# Rust 依赖会在首次构建时自动安装
```

### 开发模式

```bash
# 启动开发服务器
npm run tauri dev
```

这将同时启动：
- Vite 开发服务器 (http://localhost:1420)
- Tauri 应用窗口

### 构建发布

```bash
# 构建生产版本
npm run tauri build
```

构建产物位于 `src-tauri/target/release/bundle/` 目录下。

## 核心模块说明

### 1. 设备发现模块 (discovery.rs)

使用 UDP 广播实现局域网设备自动发现。

**主要功能**:
- UDP 广播设备信息 (端口 7890)
- 接收其他设备的广播消息
- 维护设备列表（在线/离线状态）
- 设备收藏功能

**关键常量**:
```rust
const DISCOVERY_PORT: u16 = 7890;        // UDP 广播端口
const BROADCAST_INTERVAL: Duration = 5s;  // 广播间隔
const DEVICE_TIMEOUT: Duration = 15s;     // 设备超时时间
```

**消息格式**:
```json
{
  "type": "device_announce",
  "device_id": "uuid",
  "device_name": "My Device",
  "device_type": "windows",
  "ip": "192.168.1.100",
  "port": 7891,
  "timestamp": 1234567890
}
```

### 2. 文件传输模块 (transfer.rs)

实现文件的发送和接收功能。

**主要功能**:
- 文件发送队列管理
- 传输状态追踪
- 聊天历史记录管理

**传输端口**: 7891

**文件分块**: 默认 512KB 每块

### 3. 数据库模块 (db.rs)

使用 SQLite 存储持久化数据。

**数据表**:
- `devices`: 设备信息
- `settings`: 应用设置
- `chat_messages`: 聊天记录

### 4. Tauri 命令 (commands.rs)

前后端通信的接口层。

**可用命令**:
| 命令 | 功能 | 参数 |
|------|------|------|
| `get_devices` | 获取设备列表 | 无 |
| `update_device_alias` | 更新设备别名 | device_id, alias |
| `toggle_favorite` | 切换收藏状态 | device_id |
| `send_files` | 发送文件 | device_id, file_paths |
| `get_chat_history` | 获取聊天记录 | device_id |
| `get_settings` | 获取设置 | 无 |
| `update_settings` | 更新设置 | settings |
| `set_device_name` | 设置设备名称 | name |

## 前端组件说明

### DeviceList

设备列表组件，显示所有发现的设备。

**Props**:
- `devices`: Device[] - 设备列表
- `currentDevice`: Device | null - 当前选中设备
- `onSelect`: (device: Device) => void - 选择设备回调
- `onToggleFavorite`: (device_id: string) => void - 切换收藏回调

**功能**:
- 在线/离线设备分组显示
- 设备类型图标 (Windows/Android)
- 收藏功能
- 设备别名显示

### ChatWindow

聊天式传输窗口，展示文件传输记录。

**Props**:
- `messages`: ChatMessage[] - 消息列表
- `deviceName`: string - 设备名称
- `onSendFiles`: (files: FileList) => void - 发送文件回调

**功能**:
- 聊天式消息展示
- 文件拖放上传
- 传输进度显示
- 传输状态指示

### FileItem

单个文件项组件。

**Props**:
- `message`: ChatMessage - 消息对象
- `isOwn`: boolean - 是否为发送方

**功能**:
- 文件类型图标
- 文件大小格式化
- 传输进度条
- 状态图标显示

## 状态管理

使用 Zustand 管理全局状态。

**状态结构**:
```typescript
interface AppState {
  devices: Device[]           // 设备列表
  currentDevice: Device | null // 当前设备
  messages: Record<string, ChatMessage[]> // 消息记录
  settings: Settings          // 应用设置
}
```

**主要方法**:
- `setDevices`: 更新设备列表
- `setCurrentDevice`: 设置当前设备
- `addMessage`: 添加消息
- `updateMessage`: 更新消息
- `setSettings`: 更新设置

## 配置说明

### Tauri 配置 (tauri.conf.json)

```json
{
  "productName": "MultiTrans",
  "identifier": "com.multitrans.app",
  "version": "0.1.0",
  "build": {
    "beforeDevCommand": "npm run dev",
    "devUrl": "http://localhost:1420",
    "beforeBuildCommand": "npm run build",
    "frontendDist": "../dist"
  },
  "app": {
    "windows": [{
      "title": "MultiTrans",
      "width": 1200,
      "height": 800,
      "resizable": true
    }]
  }
}
```

### Vite 配置 (vite.config.ts)

- 端口: 1420
- 目标: ES2021, Chrome 100+, Safari 13+

### Tailwind 配置

- 内容扫描: `index.html`, `src/**/*.{js,ts,jsx,tsx}`

## 开发规范

### 代码风格

**Rust**:
- 使用 `cargo fmt` 格式化代码
- 使用 `cargo clippy` 进行代码检查
- 遵循 Rust 命名规范

**TypeScript/React**:
- 使用函数组件和 Hooks
- 使用 TypeScript 类型注解
- 组件使用 PascalCase 命名
- 文件使用 camelCase 命名

### Git 提交规范

```
feat: 新功能
fix: 修复 bug
docs: 文档更新
style: 代码格式调整
refactor: 重构
test: 测试相关
chore: 构建/工具相关
```

### 分支管理

- `main`: 生产分支
- `develop`: 开发分支
- `feature/*`: 功能分支
- `bugfix/*`: 修复分支

## 待实现功能

### Phase 1: 核心功能完善
- [ ] TCP 文件传输实现
- [ ] 断点续传完整实现
- [ ] 传输进度实时更新
- [ ] 文件完整性校验

### Phase 2: 用户体验优化
- [ ] 文件拖放优化
- [ ] 传输速度限制
- [ ] 通知提醒
- [ ] 深色模式

### Phase 3: 高级功能
- [ ] 文件夹传输
- [ ] 传输历史搜索
- [ ] 设备分组
- [ ] 快捷键支持

### Phase 4: Android 适配
- [ ] Tauri Mobile 配置
- [ ] Android 权限处理
- [ ] 移动端 UI 适配
- [ ] 后台传输

## 调试技巧

### 前端调试

开发模式下打开 DevTools:
- Windows/Linux: `Ctrl + Shift + I`
- macOS: `Cmd + Option + I`

### Rust 后端调试

使用日志输出:
```rust
println!("Debug info: {:?}", value);
// 或使用 log crate
log::debug!("Debug info: {:?}", value);
```

查看 Tauri 命令调用:
```rust
#[tauri::command]
async fn my_command() -> Result<(), String> {
    println!("Command called");
    Ok(())
}
```

### 网络调试

检查端口占用:
```bash
# Windows
netstat -ano | findstr "7890"
netstat -ano | findstr "7891"

# macOS/Linux
lsof -i :7890
lsof -i :7891
```

## 常见问题

### 1. 设备发现不了

**原因**: 防火墙阻止 UDP 广播
**解决**: 在防火墙中添加入站规则，允许 UDP 7890 端口

### 2. 文件传输失败

**原因**: TCP 端口被占用
**解决**: 检查 7891 端口是否被占用，修改端口配置

### 3. 数据库初始化失败

**原因**: 应用数据目录权限问题
**解决**: 确保应用有写入数据目录的权限

### 4. 前端无法调用后端命令

**原因**: Tauri 命令未注册
**解决**: 检查 `main.rs` 中的 `invoke_handler` 是否包含该命令

## 性能优化建议

### 传输性能
- 使用零拷贝技术
- 调整缓冲区大小
- 启用多连接并发传输

### 内存优化
- 流式传输大文件
- 及时释放已传输数据
- 缩略图压缩存储

### UI 性能
- 使用虚拟列表渲染长列表
- 防抖/节流处理频繁更新
- 使用 React.memo 优化组件

## 构建发布

### Windows

```bash
npm run tauri build
```

生成文件:
- `src-tauri/target/release/multitrans.exe` - 可执行文件
- `src-tauri/target/release/bundle/msi/` - MSI 安装包
- `src-tauri/target/release/bundle/nsis/` - NSIS 安装包

### Android

```bash
# 需要配置 Android 开发环境
npm run tauri android build
```

生成 APK 文件。

## 资源链接

- [Tauri 2.0 文档](https://beta.tauri.app/)
- [React 文档](https://react.dev/)
- [Rust 文档](https://doc.rust-lang.org/)
- [Tokio 异步运行时](https://tokio.rs/)
- [TailwindCSS](https://tailwindcss.com/)
- [Zustand 状态管理](https://github.com/pmndrs/zustand)

---

**文档版本**: v1.0  
**最后更新**: 2025-01-XX  
**维护者**: 开发团队