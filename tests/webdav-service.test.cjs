const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const http = require("node:http");
const service = require("../src/webdav-service.cjs");

test("encrypts and decrypts backup buffers", () => {
  const source = Buffer.from("secret config content", "utf8");
  const encrypted = service.encryptBuffer(source, "correct horse battery staple");
  assert.notDeepEqual(encrypted, source);
  assert.deepEqual(service.decryptBuffer(encrypted, "correct horse battery staple"), source);
  assert.throws(() => service.decryptBuffer(encrypted, "wrong password"), /解密失败/);
});
test("archives and extracts a snapshot", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cpams-archive-test-"));
  fs.mkdirSync(path.join(root, "agents"));
  fs.writeFileSync(path.join(root, "manifest.json"), JSON.stringify({ id: "snapshot-1", files: [] }), "utf8");
  fs.writeFileSync(path.join(root, "config.toml"), 'model = "grok-4.6"\n', "utf8");
  fs.writeFileSync(path.join(root, "agents", "default.toml"), 'model = "grok-4.6"\n', "utf8");
  const archive = service.archiveSnapshot(root, "backup-password");
  const extracted = service.extractSnapshot(archive, "backup-password");
  try {
    assert.ok(fs.existsSync(path.join(extracted, "manifest.json")));
    assert.match(fs.readFileSync(path.join(extracted, "config.toml"), "utf8"), /grok-4.6/);
    assert.ok(fs.existsSync(path.join(extracted, "agents", "default.toml")));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(extracted, { recursive: true, force: true });
  }
});

test("uploads, lists, and downloads an encrypted WebDAV snapshot", async (t) => {
  const stored = new Map();
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      if (req.method === "MKCOL") {
        res.writeHead(201).end();
        return;
      }
      if (req.method === "PUT") {
        stored.set(req.url, Buffer.concat(chunks));
        res.writeHead(201).end();
        return;
      }
      if (req.method === "GET") {
        const value = stored.get(req.url);
        if (!value) return res.writeHead(404).end();
        res.writeHead(200, { "Content-Type": "application/octet-stream" }).end(value);
        return;
      }
      if (req.method === "PROPFIND") {
        const fileHrefs = [...stored.keys()].map((href) => `<d:response><d:href>${href}</d:href></d:response>`).join("");
        res.writeHead(207, { "Content-Type": "application/xml" });
        res.end(`<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"><d:response><d:href>${req.url}</d:href></d:response>${fileHrefs}</d:multistatus>`);
        return;
      }
      res.writeHead(405).end();
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const port = server.address().port;
  const settings = { url: `http://127.0.0.1:${port}/dav`, username: "user", password: "app-password", remotePath: "CPA-Model-Switcher", encryptionPassphrase: "encryption-password" };
  const snapshot = fs.mkdtempSync(path.join(os.tmpdir(), "cpams-webdav-test-"));
  fs.writeFileSync(path.join(snapshot, "manifest.json"), JSON.stringify({ id: "2026-09-16T12-00-00", files: [] }), "utf8");
  fs.writeFileSync(path.join(snapshot, "config.toml"), 'model = "grok-4.6"\n', "utf8");
  t.after(() => fs.rmSync(snapshot, { recursive: true, force: true }));

  const connection = await service.testConnection(settings);
  assert.equal(connection.ok, true);
  const uploaded = await service.uploadSnapshot(snapshot, settings);
  assert.equal(uploaded.ok, true);
  assert.equal(uploaded.fileName, "2026-09-16T12-00-00.cpabackup");
  const remote = await service.listRemoteBackups(settings);
  assert.equal(remote.length, 1);
  assert.equal(remote[0].fileName, uploaded.fileName);
  const downloaded = await service.downloadBackup(remote[0].url, settings);
  const extracted = service.extractSnapshot(downloaded, settings.encryptionPassphrase);
  try {
    assert.match(fs.readFileSync(path.join(extracted, "config.toml"), "utf8"), /grok-4.6/);
  } finally {
    fs.rmSync(extracted, { recursive: true, force: true });
  }
});
