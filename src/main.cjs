const { app, BrowserWindow, ipcMain, safeStorage, shell } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { execFileSync } = require("node:child_process");
const WebSocket = require("ws");
const configService = require("./config-service.cjs");
const webdavService = require("./webdav-service.cjs");

let mainWindow;

if (process.env.CPA_SWITCHER_SMOKE === "1") {
  app.setPath("userData", path.join(os.tmpdir(), `cpa-model-switcher-smoke-${process.pid}`));
}

function createWindow() {
  const smokeMode = process.env.CPA_SWITCHER_SMOKE === "1";
  mainWindow = new BrowserWindow({
    width: 1120,
    height: 760,
    minWidth: 960,
    minHeight: 640,
    show: !smokeMode,
    backgroundColor: "#f3f3f3",
    title: "CPA Model Switcher",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.loadFile(path.join(__dirname, "index.html"));
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  mainWindow.webContents.on("did-fail-load", (_event, code, description) => {
    console.error(`[renderer] load failed ${code}: ${description}`);
  });
  mainWindow.webContents.on("console-message", (_event, details) => {
    if (details.level === "error") console.error(`[renderer] ${details.message}`);
  });
  if (smokeMode) {
    mainWindow.webContents.once("did-finish-load", async () => {
      try {
        const result = await mainWindow.webContents.executeJavaScript(`(async () => {
          const workspace = await window.cpaSwitcher.loadWorkspace();
          return {
            title: document.title,
            navCount: document.querySelectorAll('.nav').length,
            pageCount: document.querySelectorAll('.page').length,
            agentCount: workspace.agents.length,
            mainModel: workspace.main.model,
            bridgeReady: typeof window.cpaSwitcher?.listModels === 'function'
          };
        })()`);
        console.log(`SMOKE_RESULT ${JSON.stringify(result)}`);
        app.exit(result.bridgeReady && result.agentCount >= 1 ? 0 : 2);
      } catch (error) {
        console.error(`SMOKE_ERROR ${error.stack || error.message}`);
        app.exit(1);
      }
    });
  }
  mainWindow.once("ready-to-show", () => mainWindow.show());
}

function settingsPath() {
  return path.join(app.getPath("userData"), "settings.json");
}

function backupRoot() {
  return path.join(app.getPath("userData"), "backups");
}

function loadSettings() {
  const filePath = settingsPath();
  if (!fs.existsSync(filePath)) return { profiles: [] };
  try {
    const data = JSON.parse(fs.readFileSync(filePath, "utf8"));
    let legacyApiKey = "";
    if (data.encryptedApiKey && safeStorage.isEncryptionAvailable()) {
      legacyApiKey = safeStorage.decryptString(Buffer.from(data.encryptedApiKey, "base64"));
    }
    if (!Array.isArray(data.profiles)) data.profiles = [];
    data.profiles = data.profiles.map((profile) => {
      const next = { ...profile };
      if (next.encryptedApiKey && safeStorage.isEncryptionAvailable()) {
        next.apiKey = safeStorage.decryptString(Buffer.from(next.encryptedApiKey, "base64"));
      }
      delete next.encryptedApiKey;
      return next;
    });
    if (data.webdav) {
      data.webdav = { ...data.webdav };
      if (data.webdav.encryptedPassword && safeStorage.isEncryptionAvailable()) {
        data.webdav.password = safeStorage.decryptString(Buffer.from(data.webdav.encryptedPassword, "base64"));
      }
      if (data.webdav.encryptedPassphrase && safeStorage.isEncryptionAvailable()) {
        data.webdav.encryptionPassphrase = safeStorage.decryptString(Buffer.from(data.webdav.encryptedPassphrase, "base64"));
      }
      delete data.webdav.encryptedPassword;
      delete data.webdav.encryptedPassphrase;
    }
    if (!data.profiles.length && data.baseUrl) {
      data.profiles.push({
        id: "legacy-cpa",
        name: "默认 CPA",
        providerId: "cpa_direct",
        baseUrl: data.baseUrl,
        apiKey: legacyApiKey,
        transportMode: data.transportMode || "http",
      });
      data.activeProfileId = "legacy-cpa";
    }
    delete data.encryptedApiKey;
    delete data.apiKey;
    return data;
  } catch {
    return { profiles: [] };
  }
}

function saveSettings(settings) {
  const output = { ...settings, profiles: [] };
  for (const profile of settings.profiles || []) {
    if (!/^[A-Za-z0-9_-]+$/.test(profile.providerId || "")) {
      throw new Error(`提供方标识“${profile.providerId || ""}”无效，只能使用字母、数字、下划线和连字符。`);
    }
    const stored = { ...profile };
    if (stored.apiKey) {
      if (!safeStorage.isEncryptionAvailable()) {
        throw new Error("Windows 安全存储当前不可用，无法安全保存 API Key。配置文件仍可正常使用现有密钥。");
      }
      stored.encryptedApiKey = safeStorage.encryptString(stored.apiKey).toString("base64");
    }
    delete stored.apiKey;
    output.profiles.push(stored);
  }
  if (settings.webdav) {
    const webdav = { ...settings.webdav };
    if ((webdav.password || webdav.encryptionPassphrase) && !safeStorage.isEncryptionAvailable()) {
      throw new Error("Windows 安全存储当前不可用，无法安全保存 WebDAV 凭据。 ");
    }
    if (webdav.password) webdav.encryptedPassword = safeStorage.encryptString(webdav.password).toString("base64");
    if (webdav.encryptionPassphrase) webdav.encryptedPassphrase = safeStorage.encryptString(webdav.encryptionPassphrase).toString("base64");
    delete webdav.password;
    delete webdav.encryptionPassphrase;
    output.webdav = webdav;
  }
  delete output.baseUrl;
  delete output.transportMode;
  fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
  fs.writeFileSync(settingsPath(), JSON.stringify(output, null, 2), "utf8");
  return publicSettings(settings);
}

function ensureProfiles(settings, main) {
  const next = { ...settings, profiles: [...(settings.profiles || [])] };
  let imported = next.profiles.find((profile) => profile.providerId === main.provider);
  if (!imported) {
    imported = {
      id: `imported-${main.provider}`,
      name: main.connection.name || `当前线路 (${main.provider})`,
      providerId: main.provider,
      baseUrl: main.connection.baseUrl,
      apiKey: main.connection.apiKey,
      transportMode: main.connection.supportsWebsockets ? "websocket" : "http",
      imported: true,
    };
    next.profiles.unshift(imported);
  } else if (!imported.apiKey && main.connection.apiKey) {
    imported.apiKey = main.connection.apiKey;
  }
  if (imported.id === "legacy-cpa") imported.imported = true;
  if (!next.activeProfileId || !next.profiles.some((profile) => profile.id === next.activeProfileId)) {
    next.activeProfileId = imported.id;
  }
  return next;
}

function publicSettings(settings) {
  return {
    activeProfileId: settings.activeProfileId || "",
    profiles: (settings.profiles || []).map((profile) => ({
      ...profile,
      apiKey: undefined,
      apiKeyPresent: Boolean(profile.apiKey),
    })),
    autoRestartCodex: Boolean(settings.autoRestartCodex),
    webdav: settings.webdav ? {
      enabled: Boolean(settings.webdav.enabled),
      url: settings.webdav.url || "",
      username: settings.webdav.username || "",
      remotePath: settings.webdav.remotePath || "CPA-Model-Switcher",
      passwordPresent: Boolean(settings.webdav.password),
      encryptionPassphrasePresent: Boolean(settings.webdav.encryptionPassphrase),
    } : { enabled: false, url: "", username: "", remotePath: "CPA-Model-Switcher", passwordPresent: false, encryptionPassphrasePresent: false },
  };
}

function mergeProfileSettings(current, incoming, main) {
  const base = ensureProfiles(current, main);
  const existingById = new Map(base.profiles.map((profile) => [profile.id, profile]));
  const profiles = (incoming.profiles || base.profiles).map((profile) => {
    const existing = existingById.get(profile.id);
    return { ...existing, ...profile, apiKey: profile.apiKey || existing?.apiKey || "" };
  });
  return {
    ...base,
    ...incoming,
    profiles,
    activeProfileId: incoming.activeProfileId || base.activeProfileId,
    webdav: incoming.webdav ? {
      ...(base.webdav || {}),
      ...incoming.webdav,
      password: incoming.webdav.password || base.webdav?.password || "",
      encryptionPassphrase: incoming.webdav.encryptionPassphrase || base.webdav?.encryptionPassphrase || "",
    } : base.webdav,
  };
}

function resolveWebDavSettings(request = {}) {
  const saved = loadSettings().webdav || {};
  return {
    ...saved,
    ...request,
    password: request.password || saved.password || "",
    encryptionPassphrase: request.encryptionPassphrase || saved.encryptionPassphrase || "",
  };
}

function sanitizeBaseUrl(baseUrl) {
  return String(baseUrl || "").trim().replace(/\/+$/, "");
}

function getConnection(request = {}) {
  const paths = { ...configService.defaultPaths(), ...(request.paths || {}) };
  const main = configService.parseMainConfig(paths.mainConfigPath);
  const settings = ensureProfiles(loadSettings(), main);
  const profile = settings.profiles.find((item) => item.id === request.profileId)
    || settings.profiles.find((item) => item.providerId === request.providerId)
    || settings.profiles.find((item) => item.id === settings.activeProfileId);
  return {
    paths,
    profile,
    baseUrl: sanitizeBaseUrl(request.baseUrl || profile?.baseUrl || main.connection.baseUrl),
    apiKey: request.apiKey || profile?.apiKey || main.connection.apiKey,
    model: request.model || main.model,
  };
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 20000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

function authHeaders(apiKey, extra = {}) {
  return {
    Accept: "application/json",
    ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    ...extra,
  };
}

async function listModels(request = {}) {
  const connection = getConnection(request);
  if (!connection.baseUrl) throw new Error("请先配置 CPA 地址。 ");
  const started = performance.now();
  const response = await fetchWithTimeout(
    `${connection.baseUrl}/models`,
    { headers: authHeaders(connection.apiKey) },
    request.timeoutMs || 20000,
  );
  const elapsedMs = Math.round(performance.now() - started);
  const text = await response.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`CPA 返回的模型数据不是 JSON（HTTP ${response.status}）。`);
  }
  if (!response.ok) {
    throw new Error(json.error?.message || json.error || json.message || `HTTP ${response.status}`);
  }
  const models = Array.isArray(json.data)
    ? json.data.map((item) => ({
        id: String(item.id || ""),
        ownedBy: String(item.owned_by || item.ownedBy || "CPA"),
      })).filter((item) => item.id)
    : [];
  return { models, elapsedMs, status: response.status, baseUrl: connection.baseUrl };
}

function websocketUrl(baseUrl) {
  const url = new URL(sanitizeBaseUrl(baseUrl));
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = `${url.pathname.replace(/\/$/, "")}/responses`;
  return url.toString();
}

function testWebSocket(request = {}) {
  const connection = getConnection(request);
  return new Promise((resolve) => {
    const started = performance.now();
    let settled = false;
    let socket;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      try { socket?.terminate(); } catch {}
      resolve({ ...result, elapsedMs: Math.round(performance.now() - started) });
    };
    const timeout = setTimeout(() => finish({ ok: false, error: "WebSocket 握手超时" }), request.timeoutMs || 10000);
    try {
      socket = new WebSocket(websocketUrl(connection.baseUrl), {
        headers: authHeaders(connection.apiKey, {
          "OpenAI-Beta": "responses_websockets=2026-02-06",
        }),
      });
      socket.once("open", () => finish({ ok: true, url: websocketUrl(connection.baseUrl) }));
      socket.once("unexpected-response", (_req, response) => {
        finish({ ok: false, error: `握手被拒绝（HTTP ${response.statusCode}）` });
      });
      socket.once("error", (error) => finish({ ok: false, error: error.message }));
    } catch (error) {
      finish({ ok: false, error: error.message });
    }
  });
}

async function testCompact(request = {}) {
  const connection = getConnection(request);
  if (!connection.model) throw new Error("没有可用于压缩测试的当前模型。 ");
  const started = performance.now();
  const response = await fetchWithTimeout(
    `${connection.baseUrl}/responses/compact`,
    {
      method: "POST",
      headers: authHeaders(connection.apiKey, { "Content-Type": "application/json" }),
      body: JSON.stringify({
        model: connection.model,
        input: [{ role: "user", content: [{ type: "input_text", text: "CPA Model Switcher compact probe" }] }],
      }),
    },
    request.timeoutMs || 30000,
  );
  const elapsedMs = Math.round(performance.now() - started);
  const text = await response.text();
  let detail = text;
  try {
    const json = JSON.parse(text);
    detail = json.error?.message || json.error || json.message || json.id || "请求已完成";
  } catch {}
  return { ok: response.ok, status: response.status, elapsedMs, detail: String(detail).slice(0, 500) };
}

function codexStatus() {
  if (process.platform !== "win32") return { running: false, supported: false };
  try {
    const output = execFileSync("tasklist.exe", ["/FI", "IMAGENAME eq Codex.exe", "/FO", "CSV", "/NH"], {
      encoding: "utf8",
      windowsHide: true,
    });
    const running = /"Codex\.exe"/i.test(output);
    const pidMatch = output.match(/"Codex\.exe","(\d+)"/i);
    return { running, supported: true, pid: pidMatch ? Number(pidMatch[1]) : null };
  } catch {
    return { running: false, supported: true };
  }
}

function registerIpc() {
  ipcMain.handle("workspace:load", (_event, paths) => {
    const workspace = configService.loadWorkspace(paths || {});
    const mainWithSecret = configService.parseMainConfig(workspace.paths.mainConfigPath);
    const settings = ensureProfiles(loadSettings(), mainWithSecret);
    return {
      ...workspace,
      settings: publicSettings(settings),
      codex: codexStatus(),
      version: app.getVersion(),
    };
  });
  ipcMain.handle("models:list", (_event, request) => listModels(request));
  ipcMain.handle("diagnostics:websocket", (_event, request) => testWebSocket(request));
  ipcMain.handle("diagnostics:compact", (_event, request) => testCompact(request));
  ipcMain.handle("diagnostics:http", async (_event, request) => {
    const result = await listModels(request);
    return { ok: true, status: result.status, elapsedMs: result.elapsedMs, modelCount: result.models.length };
  });
  ipcMain.handle("settings:save", (_event, settings) => {
    const paths = configService.defaultPaths();
    const main = configService.parseMainConfig(paths.mainConfigPath);
    const current = loadSettings();
    const next = mergeProfileSettings(current, settings || {}, main);
    return saveSettings(next);
  });
  ipcMain.handle("config:apply", async (_event, payload) => {
    const paths = { ...configService.defaultPaths(), ...(payload.paths || {}) };
    const main = configService.parseMainConfig(paths.mainConfigPath);
    const settings = ensureProfiles(loadSettings(), main);
    const profile = settings.profiles.find((item) => item.id === payload.connection?.profileId)
      || settings.profiles.find((item) => item.providerId === payload.main.provider);
    const resolvedPayload = {
      ...payload,
      connection: {
        ...payload.connection,
        name: payload.connection?.name || profile?.name || payload.main.provider,
        baseUrl: payload.connection?.baseUrl || profile?.baseUrl,
        apiKey: payload.connection?.apiKey || profile?.apiKey,
        wireApi: "responses",
      },
    };
    const result = configService.applyConfiguration(resolvedPayload, backupRoot());
    settings.activeProfileId = profile?.id || payload.connection?.profileId || settings.activeProfileId;
    saveSettings(settings);
    let webdav = null;
    if (settings.webdav?.enabled) {
      try {
        webdav = await webdavService.uploadSnapshot(result.snapshot.directory, settings.webdav);
      } catch (error) {
        webdav = { ok: false, error: error.message };
      }
    }
    return { ...result, webdav };
  });
  ipcMain.handle("backups:list", () => configService.listSnapshots(backupRoot()));
  ipcMain.handle("backups:restore", (_event, snapshotDirectory) =>
    configService.restoreSnapshot(snapshotDirectory, backupRoot()),
  );
  ipcMain.handle("webdav:test", (_event, request) => webdavService.testConnection(resolveWebDavSettings(request)));
  ipcMain.handle("webdav:list", (_event, request) => webdavService.listRemoteBackups(resolveWebDavSettings(request)));
  ipcMain.handle("webdav:upload", async (_event, request = {}) => {
    const snapshotDirectory = request.snapshotDirectory || configService.listSnapshots(backupRoot())[0]?.directory;
    if (!snapshotDirectory) throw new Error("没有可上传的本地备份。 ");
    return webdavService.uploadSnapshot(snapshotDirectory, resolveWebDavSettings(request.settings || {}));
  });
  ipcMain.handle("webdav:restore", async (_event, request = {}) => {
    const settings = resolveWebDavSettings(request.settings || {});
    const archive = await webdavService.downloadBackup(request.url, settings);
    const extracted = webdavService.extractSnapshot(archive, settings.encryptionPassphrase);
    try {
      return configService.restoreSnapshot(extracted, backupRoot());
    } finally {
      fs.rmSync(extracted, { recursive: true, force: true });
    }
  });
  ipcMain.handle("system:open-path", (_event, targetPath) => {
    if (!targetPath) return false;
    shell.showItemInFolder(targetPath);
    return true;
  });
  ipcMain.handle("system:codex-status", () => codexStatus());
}

app.whenReady().then(() => {
  app.setAppUserModelId("com.mdsd.cpa-model-switcher");
  registerIpc();
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
