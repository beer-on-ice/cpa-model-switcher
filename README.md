# CPA Model Switcher

[简体中文](README.md) | [English](README_EN.md)

一个独立的 Windows 桌面工具，用来管理 Codex 主代理和子代理使用的 CPA 线路、模型与传输配置。

它作为独立的 Windows 桌面程序运行，只在用户确认后修改 Codex 的 TOML 配置，并在每次写入前创建可恢复快照。

## 主要功能

### 多线路 CPA 管理

- 保存多个 OpenAI Responses API 兼容线路。
- 每条线路独立配置显示名称、Codex 提供方标识、接口地址、API Key 和传输模式。
- 自动导入当前 Codex 配置中的 provider，例如 `cpa_direct`，并明确标记来源。
- 从所选线路的 `/v1/models` 动态获取模型列表。
- API Key 使用 Electron `safeStorage` 和 Windows 安全存储加密保存。

### 主代理与子代理模型切换

- 切换 Codex 主代理的模型和 `model_reasoning_effort`。
- 扫描并管理 `%USERPROFILE%\.codex\agents\*.toml`。
- 在子代理矩阵中点击角色名称，查看中文用途、适用场景、模型、推理强度、沙箱模式和配置文件位置。
- 新增自定义子代理角色，并自动创建角色 TOML、注册主配置中的 `[agents.<角色标识>]` 区块。
- 为每个子代理单独选择模型。
- 一键让子代理跟随主代理。
- 批量切换时可以保护 `visual_analysis` 和 `document_reader` 等 Gemini 专用角色。
- 保留 TOML 中原有的注释、顺序和其他自定义配置。

### HTTP、WebSocket 与压缩诊断

- 测试 CPA `/v1/models` 请求和延迟。
- 测试 Responses WebSocket 握手。
- 配置自动检测、强制 WebSocket 或强制 HTTP 流式模式。
- 使用当前主模型测试 `/responses/compact`，帮助排查压缩时错误使用其他模型的问题。

### 本地备份与恢复

- 每次写入配置前自动创建本地快照。
- 查看快照包含的配置文件。
- 恢复主配置及子代理配置。
- 恢复远程或本地快照前再次创建安全快照。
- 使用文件哈希检测外部修改，避免覆盖 Codex 或编辑器刚写入的内容。

### 加密 WebDAV 备份

- 自动或手动上传本地快照到 WebDAV。
- 使用 AES-256-GCM 加密 `.cpabackup` 文件。
- WebDAV 服务器不会收到明文 `config.toml` 或 API Key。
- 查看远程备份列表。
- 下载、解密并恢复远程备份。
- WebDAV 密码和备份加密口令使用 Windows 安全存储保存。

当前 WebDAV 实现使用标准方法：

```text
MKCOL
PROPFIND
PUT
GET
```

认证方式为 Basic Auth，建议使用 WebDAV 服务提供的应用专用密码。

### GitHub 自动构建与发布

- 可在 GitHub Actions 中手动运行 **Build and Release**，生成 Windows x64 构建产物但不发布 Release。
- 推送与 `package.json` 版本一致的 `v*.*.*` 标签时，GitHub 自动运行测试、编译便携 EXE、生成 SHA-256，并创建或更新正式 Release。
- 工作流使用仓库自动提供的 `GITHUB_TOKEN`，无需额外保存 GitHub Personal Access Token。
- 自动构建仍是未签名版本；如需消除 SmartScreen 的未知发布者提示，需要另行配置 Windows 代码签名证书。

发布新版本示例：

```powershell
npm version 0.5.0 --no-git-tag-version
git add package.json package-lock.json
git commit -m "chore: release v0.5.0"
git tag -a v0.5.0 -m "CPA Model Switcher v0.5.0"
git push origin main v0.5.0
```

## 系统要求

- Windows 10/11 x64。
- 已安装并配置 Codex Desktop。
- 一个支持 OpenAI Responses API 的 CPA 或兼容服务。
- 可选：支持 Basic Auth 的 WebDAV 服务。

默认读取：

```text
%USERPROFILE%\.codex\config.toml
%USERPROFILE%\.codex\agents\*.toml
```

## 使用方法

1. 打开 CPA Model Switcher。
2. 进入“线路管理”，新增或导入 CPA 线路。
3. 填写 CPA 地址和 API Key，然后测试线路。
4. 在“模型切换”页面选择当前线路和主代理模型。
5. 为子代理设置“跟随”或独立模型。
6. 点击“应用更改”并确认 Diff。
7. 新建 Codex 任务，或重新打开已有任务使配置生效。

程序不会在启动时自动修改 Codex 配置。只有用户点击“应用更改”并再次确认后才会写入。

## WebDAV 注意事项

- 加密口令至少需要 8 个字符。
- 加密口令遗失后，远程备份无法恢复。
- WebDAV 上传失败不会回滚已经成功保存的本地 Codex 配置。
- 上传失败时，本地快照仍然保留，可以稍后手动重试。
- WebDAV 备份可能包含 Codex provider 配置，因此不提供明文上传模式。

## 安全设计

- Renderer 不直接访问文件系统或 Node.js。
- Electron 使用 `contextIsolation`，并关闭 Renderer 的 Node 集成。
- API Key、WebDAV 密码和加密口令不会写入应用日志。
- 应用自己的凭据副本通过 Windows 安全存储加密。
- 配置写入采用临时文件和原子替换。
- 每次写入前自动备份。

需要注意：Codex 本身的 `config.toml` 可能要求保存 provider token。CPA Model Switcher 无法改变 Codex 对该配置的读取方式，因此请保护好 Windows 用户目录权限。

## 开发

需要 Node.js 和 npm：

```powershell
npm install
npm test
npm run smoke
npm start
```

构建 Windows 便携 EXE：

```powershell
npm run dist
```

构建产物位于：

```text
release/CPA-Model-Switcher-<version>-x64.exe
```

## 测试

测试覆盖：

- TOML 定点修改与注释保留。
- 主代理和子代理 provider/model 切换。
- 新 provider 区块创建。
- 子代理角色创建、主配置注册、详情更新和重复标识拦截。
- 本地快照创建与恢复。
- 外部文件修改冲突检测。
- AES-256-GCM 加密和错误口令检测。
- 快照压缩与解压。
- 模拟 WebDAV 建目录、上传、远程列表、下载和恢复。
- Electron Renderer 与 Preload 冒烟测试。

运行：

```powershell
npm test
npm run smoke
```

## 发布说明

当前本地构建未进行 Authenticode 代码签名，直接下载自构建 EXE 时 Windows SmartScreen 可能显示警告。请核对发布页面提供的 SHA-256 后再运行。

## 许可证

[MIT License](LICENSE)
