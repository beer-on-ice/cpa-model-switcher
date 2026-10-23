<p align="center">
  <img src="assets/logo.svg" width="112" alt="CPA Model Switcher Logo">
</p>

<h1 align="center">CPA Model Switcher</h1>

<p align="center">
  面向 Codex Desktop 的独立 Windows / macOS 模型与子代理配置工具
</p>

<p align="center">
  <a href="https://github.com/beer-on-ice/cpa-model-switcher/releases/latest"><img alt="Latest release" src="https://img.shields.io/github/v/release/beer-on-ice/cpa-model-switcher?display_name=tag&sort=semver&style=flat-square"></a>
  <a href="https://github.com/beer-on-ice/cpa-model-switcher/actions/workflows/release.yml"><img alt="Build status" src="https://img.shields.io/github/actions/workflow/status/beer-on-ice/cpa-model-switcher/release.yml?style=flat-square&label=Windows%20%2B%20macOS%20build"></a>
  <img alt="Windows" src="https://img.shields.io/badge/Windows-10%20%7C%2011-0078D4?style=flat-square&logo=windows11&logoColor=white">
  <a href="LICENSE"><img alt="MIT License" src="https://img.shields.io/badge/license-MIT-green?style=flat-square"></a>
</p>

<p align="center">
  <a href="https://github.com/beer-on-ice/cpa-model-switcher/releases/latest"><strong>下载最新 Windows / macOS 版本</strong></a>
  · <a href="README_EN.md">English</a>
  · <a href="#三步上手">快速上手</a>
  · <a href="#常见问题">常见问题</a>
</p>

> [!IMPORTANT]
> 这是一个独立桌面程序，不注入、不修改 Codex Desktop 程序文件。启动时会从当前 CPA `/models` 自动同步本工具的模型目录，可能写入 `%USERPROFILE%\.codex` 下的 `config.toml` 和目录 JSON；自动同步不创建快照。手动保存配置及逐模型设置前会创建恢复快照。

## macOS 使用

- 支持 macOS 13 及以上，提供 Apple Silicon（`arm64`，M 系列）和 Intel（`x64`）两种版本。
- 打开对应架构的 DMG，把 **CPA Model Switcher.app** 拖入 **Applications**。ZIP 是同一应用的压缩版本。
- 当前包没有 Apple Developer ID 签名和 Apple 公证。如果系统阻止打开，首次启动后到 **系统设置 → 隐私与安全性 → 仍要打开**，核实来源后确认。
- 主配置在 `~/.codex/config.toml`，角色在 `~/.codex/agents/`；设置了 `CODEX_HOME` 时使用该目录。
- 应用数据和日志在 `~/Library/Application Support/cpa-model-switcher/`。
- 支持 `⌘S` 保存和 `⌘R` 刷新模型；菜单提供标准复制、粘贴和退出。
- 自动重启通过 `codex app-server` 的父进程定位 Codex Desktop，支持 `Codex.app` / `ChatGPT.app` 及带空格的安装路径。
- API Key、WebDAV 密码与加密口令通过 Electron `safeStorage` 使用 macOS 钥匙串。钥匙串不可用或解密失败时停止读取设置，避免把已有凭据覆盖为空。

## 一眼看懂

| 你想做什么 | CPA Model Switcher 会做什么 |
|---|---|
| 切换主代理模型 | 修改 `config.toml`，可选择保存后自动重启 Codex |
| 切换 Fast 模式 | 设置 `service_tier = "fast"` 与 `[features].fast_mode`；实际加速取决于模型/CPA |
| 给不同子代理分配模型 | 扫描和管理 `agents/*.toml`，支持跟随主代理或独立模型 |
| 为子代理单独选 WebSocket/HTTP | 为角色创建同 CPA 地址的独立 provider；可随时切回“跟随线路” |
| 让 CPA 模型出现在 Codex 模型目录 | 启动和刷新时根据 `/models` 同步 `cpa-model-switcher-catalog.json` |
| 逐模型调整上下文元数据 | 在「模型配置」设置显示名称、上下文窗口、最大窗口和有效比例 |
| 管理多个 CPA | 保存多条线路，分别配置地址、API Key 和传输方式 |
| 排查 400、WebSocket、压缩问题 | 提供 HTTP、WebSocket 和 `/responses/compact` 单项诊断 |
| 防止改坏配置 | 写入前自动备份、哈希冲突检测、一键恢复 |
| 跨设备备份 | 使用 AES-256-GCM 加密后上传 WebDAV |

## 三步上手

### 1. 配置 CPA 线路

进入 **线路管理**，填写：

- 显示名称
- Codex provider 标识
- CPA `/v1` 地址
- API Key
- HTTP / WebSocket 模式

点击 **测试此线路**，确认能够读取模型列表。

### 2. 选择主代理和子代理模型

在 **模型切换** 页面：

- 选择主代理模型与推理强度；
- 按需开启 Fast 模式；这只是服务档位偏好，上游可能不支持或另行计费；
- 为每个子代理选择“跟随主代理”或独立模型；
- 在“子代理连接”选择跟随线路、WebSocket 或 HTTP 流式；
- 点击角色名称查看职责、适用场景、沙箱模式和配置文件；
- 需要时创建新的自定义角色。

### 3. 应用配置

| 按钮 | 行为 |
|---|---|
| **仅保存配置** | 写入并备份，不中断正在运行的 Codex；当前对话不会切换模型 |
| **应用并重启 Codex** | 写入、备份、关闭并重新启动 Codex；重启后新对话可靠读取新模型 |

> [!NOTE]
> 自定义 CPA provider 在 Codex 顶部可能仍被归类为“自定义”。真实模型以新会话的请求记录和 `turn_context.model` 为准。

## 工作流程

```mermaid
flowchart LR
    A[CPA /models] --> B[CPA Model Switcher]
    B --> C[config.toml]
    B --> D[agents/*.toml]
    B --> E[cpa-model-switcher-catalog.json]
    B --> F[本地恢复快照]
    F --> G[加密 WebDAV 备份]
    C --> H[重启 Codex]
    D --> H
    E --> H
    H --> I[新对话使用新模型]
```

## 功能概览

### 主代理与模型目录

- 切换 `model_provider`、`model` 和 `model_reasoning_effort`。
- 启动和手动刷新时从当前 CPA `/models` 获取模型列表并同步本工具的目录；CPA 离线时保留已有目录。
- 动态生成：

```text
%USERPROFILE%\.codex\cpa-model-switcher-catalog.json
```

- 不覆盖、不删除其他工具维护的模型目录。
- 「模型配置」按模型 ID 分别保存显示名称、`context_window`、`max_context_window`、`effective_context_window_percent`；再次同步时保留同 ID 的设置，新模型不会继承旧模型手动修改的窗口。
- 这些是 Codex 本地目录元数据，不会提高 CPA/上游的实际上下文上限；设得过高可能导致请求被拒绝。保存后建议重启 Codex 并新建对话。逐模型保存会先创建可恢复快照；自动同步不创建快照。
- 支持保存后自动定位并重启 Codex Desktop 主进程。
- Fast 开关同时控制 `service_tier` 与 `[features].fast_mode`，只影响之后的新回合；子代理可能继承这个全局偏好。

### 子代理矩阵

- 自动发现 `%USERPROFILE%\.codex\agents\*.toml`。
- 为每个角色单独设置模型和推理强度。
- 一键让全部角色跟随主代理。
- 可保护视觉与文档角色，避免批量切换。
- 点击角色名称查看中文用途和完整配置。
- 创建自定义角色并自动注册 `[agents.<role_id>]`。
- 每个角色可单独选 WebSocket 或 HTTP：程序复制当前 CPA provider 配置为角色专用 ID，保留地址与认证，只改变 `supports_websockets`；“跟随线路”不创建专用路由。

### 多线路 CPA

- 保存多条 OpenAI Responses API 兼容线路。
- 为每条线路设置独立的 provider ID、地址、API Key 和传输模式。
- 自动导入 Codex 当前使用的 provider。
- API Key 的应用副本使用 Electron `safeStorage` 与系统安全存储（macOS 使用钥匙串）保护。

### 连接诊断

| 诊断项 | 用途 |
|---|---|
| HTTP `/models` | 检查地址、凭据、延迟和模型数量 |
| Responses WebSocket | 检查握手与长连接兼容性 |
| `/responses/compact` | 验证上下文压缩是否使用当前模型 |
| 运行日志 | 记录配置写入、模型目录生成和 Codex 重启阶段 |

运行日志位置：

```text
%APPDATA%\cpa-model-switcher\logs\app.log
```

### 备份与恢复

- 每次配置写入前创建时间戳快照。
- 保留主配置、角色配置和本工具模型目录。
- 恢复前再次创建安全快照。
- 使用 SHA-256 检测文件是否被其他程序修改。

### 加密 WebDAV

- 自动或手动上传 `.cpabackup`。
- 备份使用 AES-256-GCM 加密，不上传明文配置。
- 支持远程列表、下载、解密和恢复。
- WebDAV 密码与加密口令使用系统安全存储保护。

## 默认管理的文件

```text
%USERPROFILE%\.codex\config.toml
%USERPROFILE%\.codex\agents\*.toml
%USERPROFILE%\.codex\cpa-model-switcher-catalog.json
```

应用自己的数据位于：

```text
%APPDATA%\cpa-model-switcher\
├── settings.json
├── backups\
└── logs\app.log
```

## 安全设计

- Renderer 无法直接访问 Node.js 或文件系统。
- 启用 Electron `contextIsolation`，关闭 Renderer Node 集成。
- API Key、WebDAV 密码和加密口令不会写入运行日志。
- 配置使用临时文件和原子替换写入。
- 手动保存主/子代理及逐模型设置前自动备份；恢复前再次备份。启动时模型目录自动同步不备份。
- WebDAV 只接收加密归档。
- 不修改 Codex Desktop 安装目录。

> [!WARNING]
> “应用并重启 Codex”会中断正在运行的对话和子代理任务。请先等待重要任务结束。

## 系统要求

- Windows 10/11 x64，或 macOS 13+（Apple Silicon / Intel）
- 已安装 Codex Desktop
- 一个兼容 OpenAI Responses API 的 CPA 服务
- 可选：支持 Basic Auth 的 WebDAV 服务

## 本地开发

```powershell
npm install
npm test
npm run smoke
npm start
```

构建当前平台的安装包（Mac 生成两种架构的 DMG 和 ZIP；Windows 生成便携 EXE）：

```sh
npm ci
npm run dist
```

也可明确选择平台，在相应平台机器运行：

```sh
npm run dist:mac
npm run dist:win
```

Mac 产物：

```text
release/CPA-Model-Switcher-<version>-mac-arm64.dmg
release/CPA-Model-Switcher-<version>-mac-arm64.zip
release/CPA-Model-Switcher-<version>-mac-x64.dmg
release/CPA-Model-Switcher-<version>-mac-x64.zip
release/SHA256SUMS.txt
```

Windows 产物为 `release/CPA-Model-Switcher-<version>-x64.exe`。
`npm run smoke` 使用临时配置目录和本地模拟 CPA，不读取或修改真实 Codex 配置。

## 自动构建与发布

工作流：[`.github/workflows/release.yml`](.github/workflows/release.yml)

- 手动运行：生成 Windows x64 和 macOS arm64/x64 Actions 构建产物，不创建 Release。
- 推送 `v*.*.*` 标签：在 Windows 和 macOS 分别测试与构建，全部成功后汇总 SHA-256 并将所有平台产物发布到同一个 GitHub Release。
- 标签版本必须与 `package.json` 一致。
- 使用仓库自带的 `GITHUB_TOKEN`，无需额外 Personal Access Token。

```powershell
npm version 0.7.0 --no-git-tag-version
git add package.json package-lock.json
git commit -m "chore: release v0.7.0"
git tag -a v0.7.0 -m "CPA Model Switcher v0.7.0"
git push origin main v0.7.0
```

## 测试范围

当前测试覆盖：

- TOML 定点修改、注释保留和冲突检测
- 主代理、provider、模型目录和子代理切换
- 自定义角色创建与注册
- Codex Desktop 主进程识别和模拟重启
- 本地快照与恢复
- AES-256-GCM 备份加密
- 模拟 WebDAV 上传、列表、下载和恢复
- Electron Renderer / Preload 冒烟检查

## 常见问题

<details>
<summary><strong>为什么 Codex 仍然显示“自定义”？</strong></summary>

自定义 provider 可能被 Codex 统一归类为“自定义”。本工具会同步具体模型名称，但真实生效模型仍应以新会话请求记录为准。

</details>

<details>
<summary><strong>切换模型后，当前对话会改变吗？</strong></summary>

不会。模型属于会话上下文的一部分。使用“应用并重启 Codex”，然后创建新对话。

</details>

<details>
<summary><strong>为什么 Windows SmartScreen 提示未知发布者？</strong></summary>

当前构建尚未配置 Authenticode 代码签名。请从 GitHub Release 下载并核对发布页面中的 SHA-256。

</details>

<details>
<summary><strong>WebDAV 失败会不会破坏本地配置？</strong></summary>

不会。WebDAV 上传发生在本地配置和快照成功保存之后；上传失败时，本地快照仍然保留。

</details>

## Logo

`assets/logo.svg` 由 CPA 中的 `gemini-3.8-flash-high` 根据项目功能重新设计，概念为“双轨路由矩阵”：两条代理/模型通道在中心网关交叉切换。设计未使用第三方商标或网络素材，最终 SVG 由项目侧审核并针对小尺寸显示进行了调整。

当前 Windows EXE 仍使用 Electron 默认程序图标。后续可以基于此 SVG 生成 ICO，并加入 Windows 程序签名与图标资源。

## License

[MIT License](LICENSE)
