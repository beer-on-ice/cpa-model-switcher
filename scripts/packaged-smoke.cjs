const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { productName } = require("../package.json").build;
const executable = process.platform === "darwin"
  ? path.join("release", process.arch === "arm64" ? "mac-arm64" : "mac", `${productName}.app`, "Contents", "MacOS", productName)
  : path.join("release", "win-unpacked", `${productName}.exe`);
const result = spawnSync(process.execPath, [path.join(__dirname, "smoke.cjs"), path.resolve(executable)], { stdio: "inherit" });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
