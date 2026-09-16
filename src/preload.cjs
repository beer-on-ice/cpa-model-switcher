const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("cpaSwitcher", {
  loadWorkspace: (paths) => ipcRenderer.invoke("workspace:load", paths),
  listModels: (request) => ipcRenderer.invoke("models:list", request),
  testHttp: (request) => ipcRenderer.invoke("diagnostics:http", request),
  testWebSocket: (request) => ipcRenderer.invoke("diagnostics:websocket", request),
  testCompact: (request) => ipcRenderer.invoke("diagnostics:compact", request),
  saveSettings: (settings) => ipcRenderer.invoke("settings:save", settings),
  applyConfiguration: (payload) => ipcRenderer.invoke("config:apply", payload),
  listBackups: () => ipcRenderer.invoke("backups:list"),
  restoreBackup: (directory) => ipcRenderer.invoke("backups:restore", directory),
  testWebDav: (settings) => ipcRenderer.invoke("webdav:test", settings),
  listWebDavBackups: (settings) => ipcRenderer.invoke("webdav:list", settings),
  uploadWebDavBackup: (request) => ipcRenderer.invoke("webdav:upload", request),
  restoreWebDavBackup: (request) => ipcRenderer.invoke("webdav:restore", request),
  openPath: (targetPath) => ipcRenderer.invoke("system:open-path", targetPath),
  codexStatus: () => ipcRenderer.invoke("system:codex-status"),
});
