const path = require("node:path");
const { execFileSync, spawn } = require("node:child_process");

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function normalizeProcesses(value) {
  if (!value) return [];
  return (Array.isArray(value) ? value : [value]).map((item) => ({
    name: String(item.Name || item.name || ""),
    processId: Number(item.ProcessId || item.processId || 0),
    parentProcessId: Number(item.ParentProcessId || item.parentProcessId || 0),
    executablePath: String(item.ExecutablePath || item.executablePath || ""),
    commandLine: String(item.CommandLine || item.commandLine || ""),
  }));
}

function listCodexProcesses() {
  if (process.platform !== "win32") return [];
  const script = [
    "$items = @(Get-CimInstance Win32_Process | Where-Object {",
    "  $_.Name -ieq 'ChatGPT.exe' -or $_.Name -ieq 'codex.exe'",
    "} | Select-Object Name, ProcessId, ParentProcessId, ExecutablePath, CommandLine)",
    "ConvertTo-Json -InputObject $items -Compress",
  ].join("\n");
  const output = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 8000,
  }).trim();
  return normalizeProcesses(output ? JSON.parse(output) : []);
}

function findCodexDesktopProcess(processes) {
  const items = normalizeProcesses(processes);
  const appServers = items.filter((item) =>
    item.name.toLowerCase() === "codex.exe" && /\bapp-server\b/i.test(item.commandLine),
  );
  for (const server of appServers) {
    const desktop = items.find((item) =>
      item.name.toLowerCase() === "chatgpt.exe" &&
      item.processId === server.parentProcessId &&
      !/--type=/i.test(item.commandLine),
    );
    if (desktop?.executablePath) return desktop;
  }
  return null;
}

function codexStatus(options = {}) {
  if (process.platform !== "win32" && !options.listProcesses) {
    return { running: false, supported: false };
  }
  try {
    const listProcesses = options.listProcesses || listCodexProcesses;
    const desktop = findCodexDesktopProcess(listProcesses());
    return desktop
      ? { running: true, supported: true, pid: desktop.processId, executablePath: desktop.executablePath }
      : { running: false, supported: true };
  } catch (error) {
    return { running: false, supported: true, error: error.message };
  }
}

function terminateProcessTree(processId, options = {}) {
  const run = options.run || execFileSync;
  const listProcesses = options.listProcesses || listCodexProcesses;
  const isRunning = () => listProcesses().some((item) =>
    Number(item.processId || item.ProcessId) === Number(processId),
  );
  try {
    run("taskkill.exe", ["/PID", String(processId), "/T"], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 8000,
    });
    return { terminated: true, mode: "graceful" };
  } catch (firstError) {
    if (!isRunning()) return { terminated: true, mode: "graceful_partial" };
    try {
      run("taskkill.exe", ["/PID", String(processId), "/T", "/F"], {
        encoding: "utf8",
        windowsHide: true,
        timeout: 8000,
      });
      return { terminated: true, mode: "forced" };
    } catch (secondError) {
      if (!isRunning()) return { terminated: true, mode: "forced_partial" };
      throw new Error(`无法关闭 Codex：${secondError.message || firstError.message}`);
    }
  }
}

function launchDesktop(executablePath) {
  const child = spawn(executablePath, [], {
    cwd: path.dirname(executablePath),
    detached: true,
    stdio: "ignore",
    windowsHide: false,
  });
  child.unref();
  return child.pid;
}

async function restartCodex(options = {}) {
  if (process.platform !== "win32" && !options.listProcesses) {
    throw new Error("自动重启 Codex 目前只支持 Windows。");
  }
  const listProcesses = options.listProcesses || listCodexProcesses;
  const terminate = options.terminate || ((processId) => terminateProcessTree(processId, { listProcesses }));
  const launch = options.launch || launchDesktop;
  const wait = options.wait || delay;
  const attempts = Number(options.attempts || 80);
  const intervalMs = Number(options.intervalMs || 250);
  const desktop = findCodexDesktopProcess(listProcesses());
  if (!desktop) return { restarted: false, reason: "not_running" };

  terminate(desktop.processId);
  for (let index = 0; index < attempts; index += 1) {
    if (!listProcesses().some((item) => Number(item.processId || item.ProcessId) === desktop.processId)) break;
    await wait(intervalMs);
    if (index === attempts - 1) throw new Error("Codex 未能在限定时间内退出。");
  }

  const launchedPid = launch(desktop.executablePath);
  for (let index = 0; index < attempts; index += 1) {
    await wait(intervalMs);
    const nextDesktop = findCodexDesktopProcess(listProcesses());
    if (nextDesktop && nextDesktop.processId !== desktop.processId) {
      return {
        restarted: true,
        previousPid: desktop.processId,
        pid: nextDesktop.processId,
        launchedPid,
        executablePath: desktop.executablePath,
      };
    }
  }
  throw new Error("Codex 已退出，但重新启动后未在限定时间内就绪。");
}

module.exports = {
  normalizeProcesses,
  listCodexProcesses,
  findCodexDesktopProcess,
  codexStatus,
  terminateProcessTree,
  restartCodex,
};
