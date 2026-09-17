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

function agentProviderId(provider, filePath) {
  const role = path.basename(filePath, ".toml").replace(/[^A-Za-z0-9_-]/g, "_");
  const suffix = crypto.createHash("sha256").update(path.resolve(filePath).toLowerCase()).digest("hex").slice(0, 8);
  return `${provider}__subagent_${role}_${suffix}`;
}

function upsertAgentProvider(mainText, provider, agentFilePath, supportsWebsockets) {
  const source = readSection(mainText, `model_providers.${provider}`);
  if (!source || !readTomlKey(source, "base_url")) {
    throw new Error(`无法为子代理配置独立连接：提供方 ${provider} 缺少 base_url。`);
  }
  const alias = agentProviderId(provider, agentFilePath);
  const header = `model_providers.${alias}`;
  const copied = updateSection(`[${header}]\n${source.trimEnd()}\n`, header, {
    supports_websockets: supportsWebsockets,
  });
  const bounds = sectionBounds(mainText, header);
  if (!bounds) return { alias, text: `${mainText.trimEnd()}\n\n${copied}` };
  return { alias, text: `${mainText.slice(0, bounds.start)}${copied}${mainText.slice(bounds.end)}` };
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
    serviceTier: String(readTomlKey(top, "service_tier") || "default"),
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
  const id = path.basename(filePath, ".toml");
  return {
    id,
    filePath,
    fileName: path.basename(filePath),
    name: String(readTomlKey(text, "name") || id),
    description: String(readTomlKey(text, "description") || ""),
    provider: String(readTomlKey(text, "model_provider") || "cpa_direct"),
    model: String(readTomlKey(text, "model") || ""),
    reasoningEffort: String(readTomlKey(text, "model_reasoning_effort") || "high"),
    sandboxMode: String(readTomlKey(text, "sandbox_mode") || "read-only"),
    hash: crypto.createHash("sha256").update(text).digest("hex"),
  };
}

function listAgents(agentsDirectory, mainText = "") {
  if (!fs.existsSync(agentsDirectory)) return [];
  return fs
    .readdirSync(agentsDirectory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".toml"))
    .map((entry) => {
      const agent = parseAgentFile(path.join(agentsDirectory, entry.name));
      const alias = agent.provider.match(/^(.*?)__subagent_[A-Za-z0-9_-]+_([a-f0-9]{8})$/);
      if (!alias || agent.provider !== agentProviderId(alias[1], agent.filePath)) {
        return { ...agent, baseProvider: agent.provider, transportOverride: "inherit" };
      }
      const section = readSection(mainText, `model_providers.${agent.provider}`);
      const enabled = readTomlKey(section, "supports_websockets");
      return {
        ...agent,
        baseProvider: alias[1],
        transportOverride: enabled === true ? "websocket" : enabled === false ? "http" : "inherit",
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

function loadWorkspace(customPaths = {}) {
  const paths = { ...defaultPaths(), ...customPaths };
  if (!fs.existsSync(paths.mainConfigPath)) {
    throw new Error(`Codex 主配置不存在：${paths.mainConfigPath}`);
  }
  const main = parseMainConfig(paths.mainConfigPath);
  const agents = listAgents(paths.agentsDirectory, main.rawText);
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

function modelFamily(modelId) {
  const value = String(modelId || "").toLowerCase();
  if (value.includes("gemini")) return "gemini";
  if (value.includes("claude")) return "claude";
  if (value.includes("grok")) return "grok";
  if (value.includes("gpt")) return "gpt";
  return "other";
}

function prepareModelCatalog(mainText, mainConfigPath, codexHome, modelIds) {
  const targetName = "cpa-model-switcher-catalog.json";
  const catalogPath = path.join(codexHome, targetName);
  const configuredPath = String(readTomlKey(splitTopLevel(mainText).top, "model_catalog_json") || "").trim();
  const sourcePath = configuredPath
    ? (path.isAbsolute(configuredPath) ? path.resolve(configuredPath) : path.resolve(path.dirname(mainConfigPath), configuredPath))
    : catalogPath;
  let sourceModels = [];
  if (fs.existsSync(sourcePath)) {
    try {
      const sourceCatalog = JSON.parse(fs.readFileSync(sourcePath, "utf8"));
      if (Array.isArray(sourceCatalog.models)) sourceModels = sourceCatalog.models;
    } catch {}
  }
  const desiredIds = [...new Set((Array.isArray(modelIds) ? modelIds : [modelIds])
    .map((item) => String(item || "").trim())
    .filter(Boolean))];
  const models = desiredIds.map((modelId, index) => {
    const exact = sourceModels.find((item) => String(item.slug || "") === modelId);
    const family = modelFamily(modelId);
    const template = exact || sourceModels.find((item) => modelFamily(item.slug) === family) || sourceModels[0];
    const base = template ? JSON.parse(JSON.stringify(template)) : {
      additional_speed_tiers: [],
      availability_nux: null,
      base_instructions: "You are Codex, a coding agent. You and the user share the same workspace and collaborate to achieve the user's goals.",
      context_window: family === "gemini" ? 1048576 : 500000,
      default_reasoning_level: "high",
      default_reasoning_summary: "none",
      effective_context_window_percent: 95,
      experimental_supported_tools: [],
      input_modalities: ["text", "image"],
      max_context_window: family === "gemini" ? 1048576 : 500000,
      service_tiers: [],
      shell_type: "shell_command",
      support_verbosity: false,
      supported_in_api: true,
      supported_reasoning_levels: [
        { description: "Disable Thinking", effort: "none" },
        { description: "Enabled Thinking", effort: "high" },
      ],
      supports_image_detail_original: false,
      supports_parallel_tool_calls: false,
      supports_reasoning_summaries: true,
      supports_search_tool: false,
      truncation_policy: { limit: 10000, mode: "bytes" },
      upgrade: null,
      visibility: "list",
    };
    return {
      ...base,
      slug: modelId,
      display_name: modelId,
      description: modelId,
      priority: 1000 + index,
      visibility: "list",
      supported_in_api: true,
      upgrade: null,
    };
  });
  return {
    mainText: updateTopLevel(mainText, { model_catalog_json: targetName }),
    filePath: catalogPath,
    sourcePath,
    content: `${JSON.stringify({ models }, null, 2)}\n`,
    generatedCount: models.length,
  };
}

function normalizeRolePayload(payload = {}) {
  const role = payload.role || payload;
  const id = String(role.id || "").trim();
  if (!/^[a-z][a-z0-9_]*$/.test(id)) {
    throw new Error("角色标识必须以小写字母开头，并且只能包含小写字母、数字和下划线。");
  }
  const description = String(role.description || "").replace(/\s+/g, " ").trim();
  if (!description) throw new Error("请填写角色职责说明。");
  const provider = String(role.provider || "").trim();
  const model = String(role.model || "").trim();
  if (!provider || !model) throw new Error("角色缺少提供方或模型。");
  const reasoningEffort = String(role.reasoningEffort || "high").trim();
  const allowedEfforts = new Set(["none", "low", "medium", "high", "xhigh", "max", "ultra"]);
  if (!allowedEfforts.has(reasoningEffort)) throw new Error(`不支持的推理强度：${reasoningEffort}`);
  const sandboxMode = String(role.sandboxMode || "read-only").trim();
  const allowedSandboxes = new Set(["read-only", "workspace-write", "danger-full-access"]);
  if (!allowedSandboxes.has(sandboxMode)) throw new Error(`不支持的沙箱模式：${sandboxMode}`);
  return { id, description, provider, model, reasoningEffort, sandboxMode };
}

function roleFileText(role) {
  return [
    `name = ${encodeTomlValue(role.id)}`,
    `description = ${encodeTomlValue(role.description)}`,
    `model_provider = ${encodeTomlValue(role.provider)}`,
    `model = ${encodeTomlValue(role.model)}`,
    `model_reasoning_effort = ${encodeTomlValue(role.reasoningEffort)}`,
    `sandbox_mode = ${encodeTomlValue(role.sandboxMode)}`,
    "",
  ].join("\n");
}

function createRole(payload, backupRoot) {
  const paths = { ...defaultPaths(), ...(payload.paths || {}) };
  const role = normalizeRolePayload(payload);
  const filePath = path.join(paths.agentsDirectory, `${role.id}.toml`);
  if (fs.existsSync(filePath)) throw new Error(`角色 ${role.id} 已存在。`);

  let mainText = fs.readFileSync(paths.mainConfigPath, "utf8");
  if (sectionBounds(mainText, `agents.${role.id}`)) {
    throw new Error(`主配置中已经注册了角色 ${role.id}。`);
  }
  const snapshot = createSnapshot(
    [paths.mainConfigPath],
    backupRoot,
    payload.reason || `新增子代理角色 ${role.id} 前自动备份`,
  );
  mainText = updateSection(mainText, `agents.${role.id}`, {
    description: role.description,
    config_file: filePath,
  });
  const agentText = roleFileText(role);
  validateModelConfig(agentText, filePath);
  fs.mkdirSync(paths.agentsDirectory, { recursive: true });
  atomicWrite(filePath, agentText);
  try {
    atomicWrite(paths.mainConfigPath, mainText);
  } catch (error) {
    fs.rmSync(filePath, { force: true });
    throw error;
  }
  return { role: parseAgentFile(filePath), snapshot };
}

function updateRole(payload, backupRoot) {
  const paths = { ...defaultPaths(), ...(payload.paths || {}) };
  const role = normalizeRolePayload(payload);
  const filePath = path.resolve(String(payload.role?.filePath || payload.filePath || ""));
  const agentsRoot = `${path.resolve(paths.agentsDirectory)}${path.sep}`.toLowerCase();
  if (!filePath.toLowerCase().startsWith(agentsRoot) || path.extname(filePath).toLowerCase() !== ".toml") {
    throw new Error("角色文件必须位于 Codex agents 目录中。");
  }
  if (path.basename(filePath, ".toml") !== role.id) throw new Error("已有角色的标识不能直接修改。");
  if (!fs.existsSync(filePath)) throw new Error(`角色文件不存在：${filePath}`);

  let agentText = fs.readFileSync(filePath, "utf8");
  if (payload.role?.originalHash || payload.originalHash) {
    const originalHash = payload.role?.originalHash || payload.originalHash;
    const currentHash = crypto.createHash("sha256").update(agentText).digest("hex");
    if (currentHash !== originalHash) {
      throw new Error(`${path.basename(filePath)} 已被其他程序修改，请重新加载后再保存。`);
    }
  }
  const snapshot = createSnapshot(
    [paths.mainConfigPath, filePath],
    backupRoot,
    payload.reason || `更新子代理角色 ${role.id} 前自动备份`,
  );
  agentText = updateTopLevel(agentText, {
    name: role.id,
    description: role.description,
    model_provider: role.provider,
    model: role.model,
    model_reasoning_effort: role.reasoningEffort,
    sandbox_mode: role.sandboxMode,
  });
  validateModelConfig(agentText, filePath);
  let mainText = fs.readFileSync(paths.mainConfigPath, "utf8");
  mainText = updateSection(mainText, `agents.${role.id}`, {
    description: role.description,
    config_file: filePath,
  });
  atomicWrite(filePath, agentText);
  atomicWrite(paths.mainConfigPath, mainText);
  return { role: parseAgentFile(filePath), snapshot };
}

function applyConfiguration(payload, backupRoot) {
  const customPaths = payload.paths || {};
  const paths = { ...defaultPaths(), ...customPaths };
  if (!customPaths.codexHome && customPaths.mainConfigPath) {
    paths.codexHome = path.dirname(customPaths.mainConfigPath);
  }
  const touchedAgents = (payload.agents || []).map((agent) => agent.filePath);
  if (payload.main.serviceTier !== undefined && !["default", "fast"].includes(payload.main.serviceTier)) {
    throw new Error(`不支持的服务档位：${payload.main.serviceTier}`);
  }
  let mainText = fs.readFileSync(paths.mainConfigPath, "utf8");
  const catalog = prepareModelCatalog(
    mainText,
    paths.mainConfigPath,
    paths.codexHome,
    [...(payload.catalogModels || []), payload.main.model],
  );
  mainText = catalog.mainText;
  const snapshot = createSnapshot(
    [paths.mainConfigPath, ...(fs.existsSync(catalog.filePath) ? [catalog.filePath] : []), ...touchedAgents],
    backupRoot,
    payload.reason || "配置写入前自动备份",
  );

  mainText = updateTopLevel(mainText, {
    model_provider: payload.main.provider,
    model: payload.main.model,
    model_reasoning_effort: payload.main.reasoningEffort,
    service_tier: payload.main.serviceTier,
  });
  if (payload.main.serviceTier !== undefined) {
    mainText = updateSection(mainText, "features", { fast_mode: payload.main.serviceTier === "fast" });
  }

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
    const transport = agent.transportOverride || "inherit";
    if (!["inherit", "websocket", "http"].includes(transport)) {
      throw new Error(`不支持的子代理连接方式：${transport}`);
    }
    let provider = agent.provider;
    if (transport !== "inherit") {
      const result = upsertAgentProvider(mainText, provider, agent.filePath, transport === "websocket");
      provider = result.alias;
      mainText = result.text;
    }
    text = updateTopLevel(text, {
      model_provider: provider,
      model: agent.model,
      model_reasoning_effort: agent.reasoningEffort,
    });
    validateModelConfig(text, agent.filePath);
    preparedAgents.push({ filePath: agent.filePath, text });
  }

  if (catalog.content) atomicWrite(catalog.filePath, catalog.content);
  atomicWrite(paths.mainConfigPath, mainText);
  for (const agent of preparedAgents) atomicWrite(agent.filePath, agent.text);
  return {
    snapshot,
    modelCatalog: {
      filePath: catalog.filePath,
      generatedCount: catalog.generatedCount,
    },
  };
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
  agentProviderId,
  upsertAgentProvider,
  parseMainConfig,
  parseAgentFile,
  listAgents,
  loadWorkspace,
  createSnapshot,
  prepareModelCatalog,
  createRole,
  updateRole,
  applyConfiguration,
  listSnapshots,
  restoreSnapshot,
  readConnectionSecret,
};
