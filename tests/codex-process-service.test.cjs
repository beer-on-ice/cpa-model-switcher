const test = require("node:test");
const assert = require("node:assert/strict");
const service = require("../src/codex-process-service.cjs");

function fixture() {
  return [
    { Name: "ChatGPT.exe", ProcessId: 100, ParentProcessId: 9, ExecutablePath: "D:\\Codex\\app\\ChatGPT.exe", CommandLine: '"D:\\Codex\\app\\ChatGPT.exe"' },
    { Name: "ChatGPT.exe", ProcessId: 101, ParentProcessId: 100, ExecutablePath: "D:\\Codex\\app\\ChatGPT.exe", CommandLine: '"D:\\Codex\\app\\ChatGPT.exe" --type=renderer' },
    { Name: "codex.exe", ProcessId: 200, ParentProcessId: 100, ExecutablePath: "D:\\Codex\\app\\resources\\codex.exe", CommandLine: "codex.exe app-server --analytics-default-enabled" },
    { Name: "ChatGPT.exe", ProcessId: 300, ParentProcessId: 9, ExecutablePath: "C:\\Other\\ChatGPT.exe", CommandLine: '"C:\\Other\\ChatGPT.exe"' },
  ];
}

test("finds the Codex desktop root through its app-server child", () => {
  const desktop = service.findCodexDesktopProcess(fixture());
  assert.equal(desktop.processId, 100);
  assert.equal(desktop.executablePath, "D:\\Codex\\app\\ChatGPT.exe");
});

test("does not mistake an unrelated ChatGPT process for Codex", () => {
  const processes = fixture().filter((item) => item.Name !== "codex.exe");
  assert.equal(service.findCodexDesktopProcess(processes), null);
});

test("treats a nonzero taskkill result as success when the process already exited", () => {
  let processes = fixture();
  const result = service.terminateProcessTree(100, {
    run: () => { processes = []; throw new Error("taskkill returned a partial failure"); },
    listProcesses: () => processes,
  });
  assert.equal(result.terminated, true);
  assert.equal(result.mode, "graceful_partial");
});

test("restarts the detected desktop process and waits for the replacement", async () => {
  let processes = fixture();
  let terminatedPid = null;
  let launchedPath = null;
  const result = await service.restartCodex({
    listProcesses: () => processes,
    terminate: (pid) => { terminatedPid = pid; processes = []; },
    launch: (filePath) => {
      launchedPath = filePath;
      processes = [
        { Name: "ChatGPT.exe", ProcessId: 400, ParentProcessId: 9, ExecutablePath: filePath, CommandLine: `"${filePath}"` },
        { Name: "codex.exe", ProcessId: 401, ParentProcessId: 400, ExecutablePath: "D:\\Codex\\app\\resources\\codex.exe", CommandLine: "codex.exe app-server" },
      ];
      return 400;
    },
    wait: async () => {},
    attempts: 3,
  });
  assert.equal(terminatedPid, 100);
  assert.equal(launchedPath, "D:\\Codex\\app\\ChatGPT.exe");
  assert.equal(result.restarted, true);
  assert.equal(result.pid, 400);
});
