const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");

const DEFAULT_CODEX_HOME = path.join(os.homedir(), ".codex");

function defaultPaths() {
  return {
    codexHome: DEFAULT_CODEX_HOME,
    mainConfigPath: path.join(DEFAULT_CODEX_HOME, "config.toml"),
    agentsDirectory: path.join(DEFAULT_CODEX_HOME, "agents"),
  };
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function decodeTomlValue(raw) {
  const value = String(raw ?? "").trim();
  if (value === "true") return true;
  if (value === "false") return false;
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  return value;
}

function encodeTomlValue(value) {
  if (typeof value === "boolean") return value ? "true" : "false";
  return `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function readTomlKey(text, key) {
  const pattern = new RegExp(`^\\s*${escapeRegex(key)}\\s*=\\s*(.+?)\\s*$`, "m");
  const match = String(text).match(pattern);
  return match ? decodeTomlValue(match[1]) : undefined;
}

function replaceTomlKey(text, key, value) {
  const encoded = encodeTomlValue(value);
  const pattern = new RegExp(`^(\\s*${escapeRegex(key)}\\s*=\\s*).*$`, "m");
  if (pattern.test(text)) return text.replace(pattern, `$1${encoded}`);
  const ending = text.endsWith("\n") ? "" : "\n";
  return `${text}${ending}${key} = ${encoded}\n`;
}

function splitTopLevel(text) {
  const match = /^\s*\[/m.exec(text);
  if (!match) return { top: text, rest: "" };
  return { top: text.slice(0, match.index), rest: text.slice(match.index) };
}

function updateTopLevel(text, updates) {
  const parts = splitTopLevel(text);
  let top = parts.top;
  for (const [key, value] of Object.entries(updates)) {
    if (value !== undefined && value !== null && value !== "") {
      top = replaceTomlKey(top, key, value);
    }
  }
  return `${top}${parts.rest}`;
}

function sectionBounds(text, sectionName) {
  const headerPattern = /^\s*\[([^\]]+)\]\s*$/gm;
  const sections = [];
  let match;
  while ((match = headerPattern.exec(text))) {
    sections.push({ name: match[1], start: match.index, bodyStart: headerPattern.lastIndex });
  }
  const index = sections.findIndex((section) => section.name === sectionName);
  if (index < 0) return null;
  return {
    start: sections[index].start,
    bodyStart: sections[index].bodyStart,
    end: index + 1 < sections.length ? sections[index + 1].start : text.length,
  };
}

function readSection(text, sectionName) {
  const bounds = sectionBounds(text, sectionName);
  return bounds ? text.slice(bounds.bodyStart, bounds.end) : "";
}

function updateSection(text, sectionName, updates) {
  const bounds = sectionBounds(text, sectionName);
  if (!bounds) {
    let appended = text.endsWith("\n") ? text : `${text}\n`;
    appended += `\n[${sectionName}]\n`;
    for (const [key, value] of Object.entries(updates)) {
      if (value !== undefined && value !== null && value !== "") {
        appended += `${key} = ${encodeTomlValue(value)}\n`;
      }
    }
    return appended;
  }

  let body = text.slice(bounds.bodyStart, bounds.end);
  for (const [key, value] of Object.entries(updates)) {
    if (value !== undefined && value !== null && value !== "") {
      body = replaceTomlKey(body, key, value);
    }
  }
  return `${text.slice(0, bounds.bodyStart)}${body}${text.slice(bounds.end)}`;
}

function parseMainConfig(mainConfigPath) {
  const text = fs.readFileSync(mainConfigPath, "utf8");
  const top = splitTopLevel(text).top;
  const provider = String(readTomlKey(top, "model_provider") || "cpa_direct");
  const providerSection = readSection(text, `model_providers.${provider}`);
  return {
    filePath: mainConfigPath,
    provider,
    model: String(readTomlKey(top, "model") || ""),
    reasoningEffort: String(readTomlKey(top, "model_reasoning_effort") || "high"),
    sandboxMode: String(readTomlKey(top, "sandbox_mode") || ""),
    connection: {
      name: String(readTomlKey(providerSection, "name") || provider),
      baseUrl: String(readTomlKey(providerSection, "base_url") || ""),
      apiKey: String(
        readTomlKey(providerSection, "experimental_bearer_token") ||
          readTomlKey(providerSection, "api_key") ||
          "",
      ),
      supportsWebsockets: Boolean(readTomlKey(providerSection, "supports_websockets")),
      wireApi: String(readTomlKey(providerSection, "wire_api") || "responses"),
    },
    rawText: text,
  };
}

function parseAgentFile(filePath) {
  const text = fs.readFileSync(filePath, "utf8");
  return {
    filePath,
    fileName: path.basename(filePath),
    name: String(readTomlKey(text, "name") || path.basename(filePath, ".toml")),
    provider: String(readTomlKey(text, "model_provider") || "cpa_direct"),
    model: String(readTomlKey(text, "model") || ""),
    reasoningEffort: String(readTomlKey(text, "model_reasoning_effort") || "high"),
    sandboxMode: String(readTomlKey(text, "sandbox_mode") || "read-only"),
    hash: crypto.createHash("sha256").update(text).digest("hex"),
  };
}

function listAgents(agentsDirectory) {
  if (!fs.existsSync(agentsDirectory)) return [];
  return fs
    .readdirSync(agentsDirectory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".toml"))
    .map((entry) => parseAgentFile(path.join(agentsDirectory, entry.name)))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function loadWorkspace(customPaths = {}) {
  const paths = { ...defaultPaths(), ...customPaths };
  if (!fs.existsSync(paths.mainConfigPath)) {
    throw new Error(`Codex 主配置不存在：${paths.mainConfigPath}`);
  }
  const main = parseMainConfig(paths.mainConfigPath);
  const agents = listAgents(paths.agentsDirectory);
  return {
    paths,
    main: { ...main, connection: { ...main.connection, apiKey: undefined } },
    connectionSecretPresent: Boolean(main.connection.apiKey),
    agents,
  };
}

function safeTimestamp(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, "-");
}

function createSnapshot(files, backupRoot, reason = "配置写入前自动备份") {
  fs.mkdirSync(backupRoot, { recursive: true });
  const id = safeTimestamp();
  const directory = path.join(backupRoot, id);
  fs.mkdirSync(directory, { recursive: true });
  const manifest = { id, createdAt: new Date().toISOString(), reason, files: [] };

  for (const filePath of [...new Set(files)]) {
    if (!fs.existsSync(filePath)) continue;
    const relativeName = path.basename(filePath) === "config.toml"
      ? "config.toml"
      : path.join("agents", path.basename(filePath));
    const destination = path.join(directory, relativeName);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(filePath, destination);
    manifest.files.push({ originalPath: filePath, backupPath: relativeName });
  }
  fs.writeFileSync(path.join(directory, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
  return { ...manifest, directory };
}

function atomicWrite(filePath, content) {
  const directory = path.dirname(filePath);
  const tempPath = path.join(directory, `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tempPath, content, { encoding: "utf8", flag: "wx" });
  try {
    fs.renameSync(tempPath, filePath);
  } catch (error) {
    if (fs.existsSync(tempPath)) fs.rmSync(tempPath, { force: true });
    throw error;
  }
}

function validateModelConfig(text, filePath) {
  const model = readTomlKey(text, "model");
  const provider = readTomlKey(text, "model_provider");
  if (!model || !provider) throw new Error(`配置校验失败：${filePath} 缺少 model 或 model_provider`);
}

function applyConfiguration(payload, backupRoot) {
  const paths = { ...defaultPaths(), ...(payload.paths || {}) };
  const touchedAgents = (payload.agents || []).map((agent) => agent.filePath);
  const snapshot = createSnapshot(
    [paths.mainConfigPath, ...touchedAgents],
    backupRoot,
    payload.reason || "配置写入前自动备份",
  );

  let mainText = fs.readFileSync(paths.mainConfigPath, "utf8");
  mainText = updateTopLevel(mainText, {
    model_provider: payload.main.provider,
    model: payload.main.model,
    model_reasoning_effort: payload.main.reasoningEffort,
  });

  const providerUpdates = {};
  if (payload.connection?.name) providerUpdates.name = payload.connection.name;
  if (payload.connection?.baseUrl) providerUpdates.base_url = payload.connection.baseUrl;
  if (payload.connection?.apiKey) providerUpdates.experimental_bearer_token = payload.connection.apiKey;
  providerUpdates.wire_api = payload.connection?.wireApi || "responses";
  providerUpdates.requires_openai_auth = false;
  if (typeof payload.connection?.supportsWebsockets === "boolean") {
    providerUpdates.supports_websockets = payload.connection.supportsWebsockets;
  }
  if (Object.keys(providerUpdates).length) {
    mainText = updateSection(mainText, `model_providers.${payload.main.provider}`, providerUpdates);
  }
  validateModelConfig(splitTopLevel(mainText).top, paths.mainConfigPath);

  const preparedAgents = [];
  for (const agent of payload.agents || []) {
    let text = fs.readFileSync(agent.filePath, "utf8");
    if (agent.originalHash) {
      const currentHash = crypto.createHash("sha256").update(text).digest("hex");
      if (currentHash !== agent.originalHash) {
        throw new Error(`${path.basename(agent.filePath)} 已被其他程序修改，请重新加载后再保存。`);
      }
    }
    text = updateTopLevel(text, {
      model_provider: agent.provider,
      model: agent.model,
      model_reasoning_effort: agent.reasoningEffort,
    });
    validateModelConfig(text, agent.filePath);
    preparedAgents.push({ filePath: agent.filePath, text });
  }

  atomicWrite(paths.mainConfigPath, mainText);
  for (const agent of preparedAgents) atomicWrite(agent.filePath, agent.text);
  return { snapshot };
}

function listSnapshots(backupRoot) {
  if (!fs.existsSync(backupRoot)) return [];
  return fs
    .readdirSync(backupRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const directory = path.join(backupRoot, entry.name);
      const manifestPath = path.join(directory, "manifest.json");
      if (!fs.existsSync(manifestPath)) return null;
      try {
        return { ...JSON.parse(fs.readFileSync(manifestPath, "utf8")), directory };
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

function restoreSnapshot(snapshotDirectory, safetyBackupRoot) {
  const manifestPath = path.join(snapshotDirectory, "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const currentFiles = manifest.files.map((item) => item.originalPath).filter(fs.existsSync);
  const safety = createSnapshot(currentFiles, safetyBackupRoot, `恢复 ${manifest.id} 前的安全备份`);
  for (const item of manifest.files) {
    const source = path.join(snapshotDirectory, item.backupPath);
    if (!fs.existsSync(source)) throw new Error(`备份文件缺失：${item.backupPath}`);
    atomicWrite(item.originalPath, fs.readFileSync(source, "utf8"));
  }
  return { restored: manifest, safety };
}

function readConnectionSecret(mainConfigPath) {
  return parseMainConfig(mainConfigPath).connection.apiKey;
}

module.exports = {
  defaultPaths,
  readTomlKey,
  replaceTomlKey,
  updateTopLevel,
  updateSection,
  parseMainConfig,
  parseAgentFile,
  listAgents,
  loadWorkspace,
  createSnapshot,
  applyConfiguration,
  listSnapshots,
  restoreSnapshot,
  readConnectionSecret,
};
