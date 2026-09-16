# CPA Model Switcher

[简体中文](README.md) | [English](README_EN.md)

CPA Model Switcher is an independent Windows desktop utility for managing the CPA providers, models, and transport settings used by Codex main agents and subagents.

It runs as an independent Windows desktop application. Codex TOML files are modified only after explicit confirmation, and a recoverable snapshot is created before every write.

## Features

### Multiple CPA provider profiles

- Store multiple OpenAI Responses API-compatible provider profiles.
- Configure a display name, Codex provider ID, endpoint, API key, and transport mode for each profile.
- Import the provider currently used by Codex, such as `cpa_direct`, and clearly label it as imported.
- Fetch models dynamically from the selected provider's `/v1/models` endpoint.
- Protect saved API keys with Electron `safeStorage` and Windows secure storage.

### Main-agent and subagent model switching

- Change the Codex main-agent model and `model_reasoning_effort`.
- Discover and manage `%USERPROFILE%\.codex\agents\*.toml`.
- Select an independent model for each subagent.
- Make all subagents follow the main-agent model.
- Protect Gemini-focused roles such as `visual_analysis` and `document_reader` from bulk changes.
- Preserve existing TOML comments, ordering, and unrelated custom settings.

### HTTP, WebSocket, and compaction diagnostics

- Test CPA `/v1/models` connectivity and latency.
- Test the Responses WebSocket handshake.
- Choose automatic detection, forced WebSocket, or forced HTTP streaming.
- Test `/responses/compact` with the current main model to diagnose compaction requests that unexpectedly use a different model.

### Local snapshots and recovery

- Create a local snapshot before every configuration write.
- Inspect which files are included in a snapshot.
- Restore the main configuration and subagent configuration files.
- Create another safety snapshot before restoring a local or remote backup.
- Detect external file changes through hashes to avoid overwriting changes made by Codex or an editor.

### Encrypted WebDAV backups

- Upload local snapshots to WebDAV automatically or manually.
- Encrypt `.cpabackup` archives with AES-256-GCM.
- Never send plaintext `config.toml` files or API keys to the WebDAV server.
- List remote backup archives.
- Download, decrypt, and restore a remote backup.
- Protect the WebDAV password and backup passphrase with Windows secure storage.

The current WebDAV implementation uses standard methods:

```text
MKCOL
PROPFIND
PUT
GET
```

Authentication uses Basic Auth. An application-specific password from the WebDAV provider is recommended.

## Requirements

- Windows 10/11 x64.
- Codex Desktop installed and configured.
- A CPA or compatible service that implements the OpenAI Responses API.
- Optional: a WebDAV server with Basic Auth support.

Default configuration paths:

```text
%USERPROFILE%\.codex\config.toml
%USERPROFILE%\.codex\agents\*.toml
```

## Usage

1. Open CPA Model Switcher.
2. Open **Provider Profiles** and add or import a CPA provider.
3. Enter the endpoint and API key, then test the connection.
4. Open **Model Switcher** and select the active provider and main-agent model.
5. Configure each subagent to follow the main agent or use an independent model.
6. Select **Apply Changes** and review the proposed diff.
7. Create a new Codex task, or reopen an existing task, to use the new configuration.

Launching the application does not modify Codex. Files are written only after the user selects **Apply Changes** and confirms the operation.

## WebDAV notes

- The backup encryption passphrase must contain at least eight characters.
- Remote archives cannot be recovered if the encryption passphrase is lost.
- A failed WebDAV upload does not roll back a successfully saved local Codex configuration.
- The local snapshot remains available after an upload failure and can be uploaded again later.
- WebDAV snapshots may contain Codex provider configuration, so plaintext uploads are intentionally unsupported.

## Security design

- The Renderer has no direct filesystem or Node.js access.
- Electron runs with `contextIsolation` enabled and Renderer Node integration disabled.
- API keys, WebDAV passwords, and encryption passphrases are not written to application logs.
- The application's credential copies are encrypted with Windows secure storage.
- Configuration changes use a temporary file followed by atomic replacement.
- A snapshot is created before every write.

Codex itself may require provider tokens in `config.toml`. CPA Model Switcher cannot change how Codex reads those credentials, so the Windows user profile and its filesystem permissions should be protected.

## Development

Node.js and npm are required:

```powershell
npm install
npm test
npm run smoke
npm start
```

Build the portable Windows executable:

```powershell
npm run dist
```

The executable is written to:

```text
release/CPA-Model-Switcher-<version>-x64.exe
```

## Tests

The test suite covers:

- Targeted TOML updates and comment preservation.
- Main-agent and subagent provider/model switching.
- New provider-section creation.
- Local snapshot creation and restoration.
- External file modification conflict detection.
- AES-256-GCM encryption and incorrect-passphrase rejection.
- Snapshot archive creation and extraction.
- Mock WebDAV directory creation, upload, listing, download, and restore.
- Electron Renderer and Preload smoke tests.

Run:

```powershell
npm test
npm run smoke
```

## Release note

Local builds are currently not Authenticode-signed. Windows SmartScreen may display a warning when running a downloaded self-built executable. Verify the SHA-256 value published with the release before running it.

## License

[MIT License](LICENSE)
