const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { spawn } = require("node:child_process");

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cpa-switcher-check-"));
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ data: [{ id: "smoke-model", owned_by: "smoke" }] }));
  });
  try {
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const home = path.join(root, "codex");
    fs.mkdirSync(path.join(home, "agents"), { recursive: true });
    fs.writeFileSync(path.join(home, "config.toml"), `model = "smoke-model"\nmodel_provider = "smoke"\n[model_providers.smoke]\nbase_url = "http://127.0.0.1:${server.address().port}/v1"\nwire_api = "responses"\n`);
    fs.writeFileSync(path.join(home, "agents", "default.toml"), 'name = "default"\nmodel = "smoke-model"\nsandbox_mode = "read-only"\n');
    const executable = process.argv[2] || require("electron");
    const result = await new Promise((resolve, reject) => {
      const env = { ...process.env, CPA_SWITCHER_SMOKE: "1", CODEX_HOME: home, CPA_SWITCHER_SMOKE_DATA: path.join(root, "userData") };
      delete env.ELECTRON_RUN_AS_NODE;
      const child = spawn(executable, process.argv[2] ? [] : [path.join(__dirname, "..")], { stdio: "inherit", env, timeout: 45000 });
      child.once("error", reject);
      child.once("exit", code => resolve(code ?? 1));
    });
    if (result !== 0) throw new Error(`Electron smoke failed (${result})`);
    if (!fs.existsSync(path.join(home, "cpa-model-switcher-catalog.json"))) throw new Error("Smoke did not synchronize the model catalog");
  } finally {
    server.closeAllConnections();
    server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
