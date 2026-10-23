const fs = require("node:fs");
const { version } = require("../package.json");
const prefix = `CPA-Model-Switcher-${version}`;
const expected = process.env.BUILD_PLATFORM === "windows-x64"
  ? [`${prefix}-x64.exe`]
  : ["arm64", "x64"].flatMap(arch => ["dmg", "zip"].map(ext => `${prefix}-mac-${arch}.${ext}`));
for (const file of expected) {
  if (!fs.statSync(`release/${file}`).isFile()) throw new Error(`Missing package ${file}`);
}
require("./checksums.cjs");
