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
    platform: "win32",
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

function macFixture(root = "/Applications/ChatGPT.app") {
  return [
    { name: "ChatGPT", processId: 500, parentProcessId: 1, executablePath: `${root}/Contents/MacOS/ChatGPT`, commandLine: `${root}/Contents/MacOS/ChatGPT` },
    { name: "codex", processId: 501, parentProcessId: 500, executablePath: `${root}/Contents/Resources/codex`, commandLine: `${root}/Contents/Resources/codex app-server` },
    { name: "Codex Helper", processId: 502, parentProcessId: 500, executablePath: `${root}/Contents/Frameworks/Codex Helper.app/Contents/MacOS/Codex Helper`, commandLine: "Codex Helper --type=renderer" },
  ];
}

test("finds macOS desktop from its app-server without mistaking ChatGPT or CLI", () => {
  assert.equal(service.findCodexDesktopProcess(macFixture()).processId, 500);
  assert.equal(service.findCodexDesktopProcess(macFixture().slice(0, 1)), null);
  const cli = macFixture();
  cli[0].executablePath = "/usr/local/bin/codex";
  assert.equal(service.findCodexDesktopProcess(cli), null);
});

test("parses macOS process paths containing spaces and joins command lines by PID", () => {
  const rows = "500 1 /Users/test/My Apps/ChatGPT.app/Contents/MacOS/ChatGPT\n501 500 /Users/test/My Apps/ChatGPT.app/Contents/Resources/codex\n";
  const args = "500 /Users/test/My Apps/ChatGPT.app/Contents/MacOS/ChatGPT\n501 /Users/test/My Apps/ChatGPT.app/Contents/Resources/codex app-server\n";
  const commands = [];
  const processes = service.listCodexProcesses({ platform: "darwin", run: (cmd, argv) => {
    commands.push([cmd, argv]);
    return argv.includes("pid=,ppid=,comm=") ? rows : args;
  }});
  assert.equal(service.findCodexDesktopProcess(processes).processId, 500);
  assert.equal(processes[0].executablePath, "/Users/test/My Apps/ChatGPT.app/Contents/MacOS/ChatGPT");
  assert.equal(commands[0][0], "/bin/ps");
});

test("macOS termination sends SIGTERM only to the desktop root", () => {
  const calls = [];
  const result = service.terminateProcessTree(500, { platform: "darwin", listProcesses: () => [], kill: (...args) => calls.push(args) });
  assert.deepEqual(calls, [[500, "SIGTERM"]]);
  assert.equal(result.terminated, true);
});

test("macOS launch uses Launch Services with the original app bundle", () => {
  const calls = [];
  service.launchDesktop("/Users/test/My Apps/ChatGPT.app/Contents/MacOS/ChatGPT", {
    platform: "darwin", run: (...args) => calls.push(args),
  });
  assert.deepEqual(calls[0].slice(0, 2), ["/usr/bin/open", ["-a", "/Users/test/My Apps/ChatGPT.app"]]);
});

test("macOS restart waits for a new desktop and does not touch unrelated processes", async () => {
  let processes = macFixture();
  const result = await service.restartCodex({ platform: "darwin", listProcesses: () => processes,
    terminate: (pid) => { assert.equal(pid, 500); processes = []; },
    launch: () => { processes = macFixture().map(p => ({ ...p, processId: p.processId + 100, parentProcessId: p.parentProcessId === 500 ? 600 : 1 })); },
    wait: async () => {}, attempts: 2,
  });
  assert.equal(result.pid, 600);
  assert.equal(result.restarted, true);
});

test("restart refuses to launch a duplicate if the old desktop does not exit", async () => {
  await assert.rejects(service.restartCodex({ platform: "darwin", listProcesses: macFixture,
    terminate: () => {}, launch: () => assert.fail("must not launch"), wait: async () => {}, attempts: 2,
  }), /退出/);
});

test("macOS termination also stops the identified app-server child", () => {
  const calls = [];
  service.terminateProcessTree(500, { platform: "darwin", listProcesses: macFixture, kill: (...args) => calls.push(args) });
  assert.deepEqual(calls, [[500, "SIGTERM"], [501, "SIGTERM"]]);
});

test("macOS restart waits for the old app-server to exit before launch", async () => {
  let processes = macFixture();
  await assert.rejects(service.restartCodex({ platform: "darwin", listProcesses: () => processes,
    terminate: () => { processes = processes.filter(p => p.processId !== 500); },
    launch: () => assert.fail("old server still alive"), wait: async () => {}, attempts: 2,
  }), /退出/);
});
