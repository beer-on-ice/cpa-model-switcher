const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const AdmZip = require("adm-zip");

const MAGIC = Buffer.from("CPAMS01", "ascii");

function validateSettings(settings, requireEncryption = false) {
  if (!settings?.url) throw new Error("请填写 WebDAV 地址。 ");
  if (!settings?.username) throw new Error("请填写 WebDAV 用户名。 ");
  if (!settings?.password) throw new Error("请填写 WebDAV 密码或应用专用密码。 ");
  if (requireEncryption && (!settings?.encryptionPassphrase || settings.encryptionPassphrase.length < 8)) {
    throw new Error("远程备份加密口令至少需要 8 个字符。 ");
  }
}

function authHeaders(settings, extra = {}) {
  const token = Buffer.from(`${settings.username}:${settings.password}`, "utf8").toString("base64");
  return { Authorization: `Basic ${token}`, ...extra };
}

function normalizeBaseUrl(value) {
  const url = new URL(String(value).trim());
  if (!/^https?:$/.test(url.protocol)) throw new Error("WebDAV 地址必须使用 HTTP 或 HTTPS。 ");
  url.pathname = url.pathname.replace(/\/+$/, "");
  return url;
}

function remoteSegments(remotePath) {
  return String(remotePath || "CPA-Model-Switcher")
    .split("/")
    .map((part) => part.trim())
    .filter(Boolean);
}

function collectionUrls(settings) {
  const base = normalizeBaseUrl(settings.url);
  const urls = [];
  const segments = remoteSegments(settings.remotePath);
  let currentPath = base.pathname;
  for (const segment of segments) {
    currentPath = `${currentPath}/${encodeURIComponent(segment)}`.replace(/\/+/g, "/");
    const next = new URL(base.toString());
    next.pathname = currentPath;
    urls.push(next.toString().replace(/\/$/, ""));
  }
  return urls;
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 20000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function ensureCollection(settings) {
  validateSettings(settings);
  const urls = collectionUrls(settings);
  if (!urls.length) return normalizeBaseUrl(settings.url).toString().replace(/\/$/, "");
  for (const url of urls) {
    const response = await fetchWithTimeout(url, {
      method: "MKCOL",
      headers: authHeaders(settings),
    }, settings.timeoutMs || 20000);
    if (![200, 201, 204, 301, 302, 405].includes(response.status)) {
      const detail = (await response.text()).slice(0, 300);
      throw new Error(`创建 WebDAV 目录失败（HTTP ${response.status}）：${detail}`);
    }
  }
  return urls.at(-1);
}

function encryptBuffer(buffer, passphrase) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = crypto.scryptSync(passphrase, salt, 32);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(buffer), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([MAGIC, salt, iv, tag, encrypted]);
}

function decryptBuffer(buffer, passphrase) {
  if (!Buffer.isBuffer(buffer)) buffer = Buffer.from(buffer);
  if (buffer.length < MAGIC.length + 44 || !buffer.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new Error("远程备份格式无效或不是 CPA Model Switcher 加密备份。 ");
  }
  let offset = MAGIC.length;
  const salt = buffer.subarray(offset, offset += 16);
  const iv = buffer.subarray(offset, offset += 12);
  const tag = buffer.subarray(offset, offset += 16);
  const encrypted = buffer.subarray(offset);
  const key = crypto.scryptSync(passphrase, salt, 32);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(encrypted), decipher.final()]);
  } catch {
    throw new Error("远程备份解密失败，请检查加密口令。 ");
  }
}

function archiveSnapshot(snapshotDirectory, passphrase) {
  validateSettings({ url: "https://placeholder.invalid", username: "x", password: "x", encryptionPassphrase: passphrase }, true);
  const manifestPath = path.join(snapshotDirectory, "manifest.json");
  if (!fs.existsSync(manifestPath)) throw new Error("本地快照缺少 manifest.json。 ");
  const zip = new AdmZip();
  zip.addLocalFolder(snapshotDirectory);
  return encryptBuffer(zip.toBuffer(), passphrase);
}

function extractSnapshot(encryptedArchive, passphrase) {
  const zipBuffer = decryptBuffer(encryptedArchive, passphrase);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cpa-model-switcher-webdav-"));
  const zip = new AdmZip(zipBuffer);
  zip.extractAllTo(directory, true);
  if (!fs.existsSync(path.join(directory, "manifest.json"))) {
    fs.rmSync(directory, { recursive: true, force: true });
    throw new Error("远程备份内容无效：缺少 manifest.json。 ");
  }
  return directory;
}

async function testConnection(settings) {
  const collection = await ensureCollection(settings);
  const started = performance.now();
  const response = await fetchWithTimeout(collection, {
    method: "PROPFIND",
    headers: authHeaders(settings, { Depth: "0", "Content-Type": "application/xml" }),
    body: '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/></d:prop></d:propfind>',
  }, settings.timeoutMs || 20000);
  if (![200, 207].includes(response.status)) {
    throw new Error(`WebDAV 连接测试失败（HTTP ${response.status}）。`);
  }
  return { ok: true, status: response.status, elapsedMs: Math.round(performance.now() - started), collection };
}

async function uploadSnapshot(snapshotDirectory, settings) {
  validateSettings(settings, true);
  const collection = await ensureCollection(settings);
  const manifest = JSON.parse(fs.readFileSync(path.join(snapshotDirectory, "manifest.json"), "utf8"));
  const fileName = `${manifest.id}.cpabackup`;
  const archive = archiveSnapshot(snapshotDirectory, settings.encryptionPassphrase);
  const url = `${collection}/${encodeURIComponent(fileName)}`;
  const response = await fetchWithTimeout(url, {
    method: "PUT",
    headers: authHeaders(settings, { "Content-Type": "application/octet-stream", "Content-Length": String(archive.length) }),
    body: archive,
  }, settings.timeoutMs || 60000);
  if (![200, 201, 204].includes(response.status)) {
    const detail = (await response.text()).slice(0, 300);
    throw new Error(`WebDAV 上传失败（HTTP ${response.status}）：${detail}`);
  }
  return { ok: true, fileName, url, bytes: archive.length, status: response.status };
}

function parseRemoteFiles(xml, collectionUrl) {
  const hrefs = [...String(xml).matchAll(/<(?:d:)?href[^>]*>([\s\S]*?)<\/(?:d:)?href>/gi)].map((match) => match[1].trim());
  const basePath = new URL(collectionUrl).pathname.replace(/\/$/, "");
  const files = [];
  for (const href of hrefs) {
    let pathname;
    try { pathname = new URL(href, collectionUrl).pathname; } catch { continue; }
    if (pathname.replace(/\/$/, "") === basePath) continue;
    const fileName = decodeURIComponent(pathname.split("/").filter(Boolean).at(-1) || "");
    if (!fileName.endsWith(".cpabackup")) continue;
    files.push({ fileName, url: new URL(href, collectionUrl).toString(), id: fileName.replace(/\.cpabackup$/, "") });
  }
  return files.sort((a, b) => b.fileName.localeCompare(a.fileName));
}

async function listRemoteBackups(settings) {
  validateSettings(settings);
  const collection = await ensureCollection(settings);
  const response = await fetchWithTimeout(collection, {
    method: "PROPFIND",
    headers: authHeaders(settings, { Depth: "1", "Content-Type": "application/xml" }),
    body: '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:getcontentlength/><d:getlastmodified/><d:resourcetype/></d:prop></d:propfind>',
  }, settings.timeoutMs || 20000);
  if (![200, 207].includes(response.status)) throw new Error(`读取 WebDAV 目录失败（HTTP ${response.status}）。`);
  return parseRemoteFiles(await response.text(), collection);
}

async function downloadBackup(remoteUrl, settings) {
  validateSettings(settings, true);
  const response = await fetchWithTimeout(remoteUrl, { headers: authHeaders(settings) }, settings.timeoutMs || 60000);
  if (!response.ok) throw new Error(`下载 WebDAV 备份失败（HTTP ${response.status}）。`);
  return Buffer.from(await response.arrayBuffer());
}

module.exports = {
  encryptBuffer,
  decryptBuffer,
  archiveSnapshot,
  extractSnapshot,
  testConnection,
  uploadSnapshot,
  listRemoteBackups,
  downloadBackup,
  parseRemoteFiles,
};
