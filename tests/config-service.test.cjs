const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const service = require("../src/config-service.cjs");

function tempWorkspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cpa-model-switcher-"));
  const codexHome = path.join(root, ".codex");
  const agentsDirectory = path.join(codexHome, "agents");
  const backupRoot = path.join(root, "backups");
  fs.mkdirSync(agentsDirectory, { recursive: true });
  const mainConfigPath = path.join(codexHome, "config.toml");
  fs.writeFileSync(mainConfigPath, `# keep-main-comment\nsandbox_mode = "danger-full-access"\nmodel_provider = "cpa_direct"\nmodel = "gpt-old"\nmodel_reasoning_effort = "medium"\n\n[model_providers.cpa_direct]\n# keep-provider-comment\nbase_url = "https://cpa.example/v1"\nexperimental_bearer_token = "secret"\nwire_api = "responses"\nsupports_websockets = false\n\n[features]\nhooks = true\n`, "utf8");
  const agentPath = path.join(agentsDirectory, "default.toml");
  fs.writeFileSync(agentPath, `name = "default"\ndescription = "General read-only scout."\n# keep-agent-comment\nmodel_provider = "cpa_direct"\nmodel = "agent-old"\nmodel_reasoning_effort = "low"\nsandbox_mode = "read-only"\n`, "utf8");
  return { root, codexHome, mainConfigPath, agentsDirectory, backupRoot, agentPath };
}

test("loads main and agent configuration without exposing secret", () => {
  const ws = tempWorkspace();
  const loaded = service.loadWorkspace({ codexHome: ws.codexHome, mainConfigPath: ws.mainConfigPath, agentsDirectory: ws.agentsDirectory });
  assert.equal(loaded.main.model, "gpt-old");
  assert.equal(loaded.main.connection.baseUrl, "https://cpa.example/v1");
  assert.equal(loaded.main.connection.apiKey, undefined);
  assert.equal(loaded.connectionSecretPresent, true);
  assert.equal(loaded.agents[0].model, "agent-old");
  assert.equal(loaded.agents[0].description, "General read-only scout.");
});

test("updates only selected top-level and provider values", () => {
  const input = `# comment\nmodel = "old"\nmodel_provider = "cpa_direct"\n\n[model_providers.cpa_direct]\nbase_url = "https://old/v1"\nsupports_websockets = false\n\n[features]\nhooks = true\n`;
  let output = service.updateTopLevel(input, { model: "grok-4.6" });
  output = service.updateSection(output, "model_providers.cpa_direct", { supports_websockets: true });
  assert.match(output, /# comment/);
  assert.match(output, /model = "grok-4.6"/);
  assert.match(output, /supports_websockets = true/);
  assert.match(output, /\[features\]\nhooks = true/);
});

test("applies configuration, preserves comments, and creates a snapshot", () => {
  const ws = tempWorkspace();
  const agent = service.parseAgentFile(ws.agentPath);
  const result = service.applyConfiguration({
    paths: { codexHome: ws.codexHome, mainConfigPath: ws.mainConfigPath, agentsDirectory: ws.agentsDirectory },
    main: { provider: "cpa_direct", model: "grok-4.6", reasoningEffort: "high" },
    connection: { baseUrl: "https://new.example/v1", supportsWebsockets: true },
    agents: [{ filePath: ws.agentPath, originalHash: agent.hash, provider: "cpa_direct", model: "grok-4.6", reasoningEffort: "high" }],
  }, ws.backupRoot);
  const main = fs.readFileSync(ws.mainConfigPath, "utf8");
  const child = fs.readFileSync(ws.agentPath, "utf8");
  assert.match(main, /# keep-main-comment/);
  assert.match(main, /# keep-provider-comment/);
  assert.match(main, /model = "grok-4.6"/);
  assert.match(main, /base_url = "https:\/\/new.example\/v1"/);
  assert.match(main, /supports_websockets = true/);
  assert.match(child, /# keep-agent-comment/);
  assert.match(child, /model = "grok-4.6"/);
  assert.ok(fs.existsSync(path.join(result.snapshot.directory, "manifest.json")));
});

test("restores a snapshot and creates a safety snapshot", () => {
  const ws = tempWorkspace();
  const snapshot = service.createSnapshot([ws.mainConfigPath, ws.agentPath], ws.backupRoot, "original");
  fs.writeFileSync(ws.mainConfigPath, `model_provider = "cpa_direct"\nmodel = "changed"\n`, "utf8");
  const restored = service.restoreSnapshot(snapshot.directory, ws.backupRoot);
  assert.match(fs.readFileSync(ws.mainConfigPath, "utf8"), /model = "gpt-old"/);
  assert.equal(restored.restored.id, snapshot.id);
  assert.ok(fs.existsSync(restored.safety.directory));
});

test("rejects an externally modified agent file", () => {
  const ws = tempWorkspace();
  const agent = service.parseAgentFile(ws.agentPath);
  fs.appendFileSync(ws.agentPath, "# external change\n", "utf8");
  assert.throws(() => service.applyConfiguration({
    paths: { mainConfigPath: ws.mainConfigPath, agentsDirectory: ws.agentsDirectory },
    main: { provider: "cpa_direct", model: "grok-4.6", reasoningEffort: "high" },
    connection: {},
    agents: [{ filePath: ws.agentPath, originalHash: agent.hash, provider: "cpa_direct", model: "grok-4.6", reasoningEffort: "high" }],
  }, ws.backupRoot), /已被其他程序修改/);
});

test("creates and activates a new provider section", () => {
  const ws = tempWorkspace();
  const agent = service.parseAgentFile(ws.agentPath);
  service.applyConfiguration({
    paths: { mainConfigPath: ws.mainConfigPath, agentsDirectory: ws.agentsDirectory },
    main: { provider: "cpa_backup", model: "gemini-3.8-flash-high", reasoningEffort: "high" },
    connection: { name: "备用 CPA", baseUrl: "https://backup.example/v1", apiKey: "backup-secret", wireApi: "responses", supportsWebsockets: false },
    agents: [{ filePath: ws.agentPath, originalHash: agent.hash, provider: "cpa_backup", model: "gemini-3.8-flash-high", reasoningEffort: "high" }],
  }, ws.backupRoot);
  const main = fs.readFileSync(ws.mainConfigPath, "utf8");
  const child = fs.readFileSync(ws.agentPath, "utf8");
  assert.match(main, /model_provider = "cpa_backup"/);
  assert.match(main, /\[model_providers\.cpa_backup\]/);
  assert.match(main, /name = "备用 CPA"/);
  assert.match(main, /base_url = "https:\/\/backup.example\/v1"/);
  assert.match(main, /experimental_bearer_token = "backup-secret"/);
  assert.match(child, /model_provider = "cpa_backup"/);
});

test("generates an independent model catalog from the active CPA model list", () => {
  const ws = tempWorkspace();
  const legacyCatalogPath = path.join(ws.codexHome, "cc-switch-model-catalog.json");
  fs.writeFileSync(legacyCatalogPath, JSON.stringify({ models: [{
    slug: "gpt-template",
    display_name: "gpt-template",
    description: "template",
    context_window: 500000,
    max_context_window: 500000,
    priority: 1000,
    visibility: "list",
    supported_in_api: true,
  }] }, null, 2), "utf8");
  const mainBefore = service.updateTopLevel(fs.readFileSync(ws.mainConfigPath, "utf8"), {
    model_catalog_json: "cc-switch-model-catalog.json",
  });
  fs.writeFileSync(ws.mainConfigPath, mainBefore, "utf8");
  const originalLegacy = fs.readFileSync(legacyCatalogPath, "utf8");
  const agent = service.parseAgentFile(ws.agentPath);
  const result = service.applyConfiguration({
    paths: { codexHome: ws.codexHome, mainConfigPath: ws.mainConfigPath, agentsDirectory: ws.agentsDirectory },
    main: { provider: "cpa_direct", model: "claude-opus-4-6-thinking", reasoningEffort: "high" },
    catalogModels: ["claude-opus-4-6-thinking", "gemini-3.5-flash-lite"],
    connection: {},
    agents: [{ filePath: ws.agentPath, originalHash: agent.hash, provider: "cpa_direct", model: "claude-opus-4-6-thinking", reasoningEffort: "high" }],
  }, ws.backupRoot);
  const generatedPath = path.join(ws.codexHome, "cpa-model-switcher-catalog.json");
  const generated = JSON.parse(fs.readFileSync(generatedPath, "utf8"));
  const mainAfter = fs.readFileSync(ws.mainConfigPath, "utf8");
  assert.equal(result.modelCatalog.generatedCount, 2);
  assert.deepEqual(generated.models.map((item) => item.slug), ["claude-opus-4-6-thinking", "gemini-3.5-flash-lite"]);
  assert.match(mainAfter, /model_catalog_json = "cpa-model-switcher-catalog\.json"/);
  assert.equal(fs.readFileSync(legacyCatalogPath, "utf8"), originalLegacy);
});

test("creates a role file and registers it in the main config", () => {
  const ws = tempWorkspace();
  const result = service.createRole({
    paths: { mainConfigPath: ws.mainConfigPath, agentsDirectory: ws.agentsDirectory },
    role: {
      id: "api_research",
      description: "Search API implementation and return file:line evidence.",
      provider: "cpa_direct",
      model: "grok-4.6",
      reasoningEffort: "high",
      sandboxMode: "read-only",
    },
  }, ws.backupRoot);
  const rolePath = path.join(ws.agentsDirectory, "api_research.toml");
  const roleText = fs.readFileSync(rolePath, "utf8");
  const mainText = fs.readFileSync(ws.mainConfigPath, "utf8");
  assert.equal(result.role.id, "api_research");
  assert.match(roleText, /description = "Search API implementation and return file:line evidence\."/);
  assert.match(roleText, /model = "grok-4\.6"/);
  assert.match(mainText, /\[agents\.api_research\]/);
  assert.match(mainText, /description = "Search API implementation and return file:line evidence\."/);
  assert.ok(fs.existsSync(path.join(result.snapshot.directory, "manifest.json")));
  assert.throws(() => service.createRole({
    paths: { mainConfigPath: ws.mainConfigPath, agentsDirectory: ws.agentsDirectory },
    role: { id: "api_research", description: "Duplicate", provider: "cpa_direct", model: "grok-4.6" },
  }, ws.backupRoot), /已存在/);
});

test("updates role details while preserving existing comments", () => {
  const ws = tempWorkspace();
  const current = service.parseAgentFile(ws.agentPath);
  const result = service.updateRole({
    paths: { mainConfigPath: ws.mainConfigPath, agentsDirectory: ws.agentsDirectory },
    role: {
      id: "default",
      filePath: ws.agentPath,
      originalHash: current.hash,
      description: "General verification and focused read-only exploration.",
      provider: "cpa_direct",
      model: "grok-4.6",
      reasoningEffort: "high",
      sandboxMode: "read-only",
    },
  }, ws.backupRoot);
  const roleText = fs.readFileSync(ws.agentPath, "utf8");
  const mainText = fs.readFileSync(ws.mainConfigPath, "utf8");
  assert.match(roleText, /# keep-agent-comment/);
  assert.match(roleText, /description = "General verification and focused read-only exploration\."/);
  assert.match(roleText, /model = "grok-4\.6"/);
  assert.match(mainText, /\[agents\.default\]/);
  assert.equal(result.role.reasoningEffort, "high");
});
