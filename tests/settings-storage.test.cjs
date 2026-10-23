const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");

function loadMain(t, safeStorage) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cpa-secure-settings-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = fs.readFileSync(path.join(__dirname, "../src/main.cjs"), "utf8");
  const context = { process: { env: {} }, console, Buffer, require: (id) => {
    if (id === "electron") return { safeStorage, app: { getPath: () => root, whenReady: () => ({ then() {} }), on() {} } };
    if (id.startsWith("node:")) return require(id);
    return {};
  }};
  vm.createContext(context);
  vm.runInContext(source, context);
  const file = path.join(root, "settings.json");
  fs.writeFileSync(file, JSON.stringify({ profiles: [{ id: "test", providerId: "test", encryptedApiKey: "encrypted" }] }));
  return { context, file };
}

test("unavailable system key store surfaces an error and preserves saved encrypted credentials", t => {
  const { context, file } = loadMain(t, { isEncryptionAvailable: () => false });
  const before = fs.readFileSync(file, "utf8");
  assert.throws(() => context.loadSettings(), /安全存储/);
  assert.equal(fs.readFileSync(file, "utf8"), before);
});

test("failed credential decryption does not silently return empty profiles", t => {
  const { context } = loadMain(t, { isEncryptionAvailable: () => true, decryptString: () => { throw new Error("Keychain locked"); } });
  assert.throws(() => context.loadSettings(), /设置/);
});
