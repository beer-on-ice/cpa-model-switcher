const { spawnSync } = require("node:child_process");
const path = require("node:path");
const platform = process.argv[2] || process.platform;
if (!["darwin", "win32"].includes(platform)) throw new Error("Packaging supports macOS and Windows hosts.");
const args = platform === "darwin" ? ["--mac", "--arm64", "--x64"] : ["--win", "portable", "--x64"];
const result = spawnSync(process.execPath, [require.resolve("electron-builder/cli.js"), ...args, "--publish", "never"], {
  stdio: "inherit", env: process.env,
});
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status || 1);
require("./checksums.cjs");
