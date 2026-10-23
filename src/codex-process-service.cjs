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

function listCodexProcesses(options = {}) {
  const platform = options.platform || process.platform;
  const run = options.run || execFileSync;
  if (platform === "darwin") {
    const execOptions = { encoding: "utf8", timeout: 8000 };
    // Separate comm from args: app paths can contain spaces, and args contain flags.
    const rows = run("/bin/ps", ["-ww", "-axo", "pid=,ppid=,comm="], execOptions);
    const commands = new Map(run("/bin/ps", ["-ww", "-axo", "pid=,args="], execOptions)
      .trim().split("\n").map(line => {
        const match = line.trim().match(/^(\d+)\s+(.*)$/);
        return match ? [Number(match[1]), match[2]] : [0, ""];
      }));
    return rows.trim().split("\n").flatMap(line => {
      const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
      if (!match) return [];
      const executablePath = match[3];
      const name = path.posix.basename(executablePath);
      if (!/^(codex|chatgpt)$/i.test(name)) return [];
      return [{ name, processId: Number(match[1]), parentProcessId: Number(match[2]),
        executablePath, commandLine: commands.get(Number(match[1])) || "" }];
    });
  }
  if (platform !== "win32") return [];
  const script = [
    "$items = @(Get-CimInstance Win32_Process | Where-Object {",
    "  $_.Name -ieq 'ChatGPT.exe' -or $_.Name -ieq 'codex.exe'",
    "} | Select-Object Name, ProcessId, ParentProcessId, ExecutablePath, CommandLine)",
    "ConvertTo-Json -InputObject $items -Compress",
  ].join("\n");
  const output = run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 8000,
  }).trim();
  return normalizeProcesses(output ? JSON.parse(output) : []);
}

function findCodexDesktopProcess(processes) {
  const items = normalizeProcesses(processes);
  const appServers = items.filter((item) =>
    /^(codex|codex\.exe)$/i.test(item.name) && /\bapp-server\b/i.test(item.commandLine),
  );
  for (const server of appServers) {
    const desktop = items.find((item) =>
      (item.name.toLowerCase() === "chatgpt.exe" ||
        (/^(codex|chatgpt)$/i.test(item.name) &&
         /\.app\/Contents\/MacOS\/(Codex|ChatGPT)$/.test(item.executablePath))) &&
      item.processId === server.parentProcessId &&
      !/--type=/i.test(item.commandLine),
    );
    if (desktop?.executablePath) return desktop;
  }
  return null;
}

function codexStatus(options = {}) {
  if (!["win32", "darwin"].includes(options.platform || process.platform) && !options.listProcesses) {
    return { running: false, supported: false };
  }
  try {
    const listProcesses = options.listProcesses || (() => listCodexProcesses(options));
    const desktop = findCodexDesktopProcess(listProcesses());
    return desktop
      ? { running: true, supported: true, pid: desktop.processId, executablePath: desktop.executablePath }
      : { running: false, supported: true };
  } catch (error) {
    return { running: false, supported: true, error: error.message };
  }
}

function terminateProcessTree(processId, options = {}) {
  if ((options.platform || process.platform) === "darwin") {
    if (!Number.isSafeInteger(Number(processId)) || Number(processId) <= 1) throw new Error("无效的 Codex PID。");
    const processes = normalizeProcesses((options.listProcesses || (() => listCodexProcesses(options)))());
    const servers = processes.filter(item => item.parentProcessId === Number(processId)
      && /^codex$/i.test(item.name) && /\bapp-server\b/i.test(item.commandLine));
    for (const pid of [Number(processId), ...servers.map(item => item.processId)]) {
      try {
        // Target only the desktop and its identified app-server, never processes by name.
        (options.kill || process.kill)(pid, "SIGTERM");
      } catch (error) {
        if (error.code !== "ESRCH") throw new Error(`无法关闭 Codex：${error.message}`);
      }
    }
    return { terminated: true, mode: "graceful" };
  }
  const run = options.run || execFileSync;
  const listProcesses = options.listProcesses || (() => listCodexProcesses(options));
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

function launchDesktop(executablePath, options = {}) {
  if ((options.platform || process.platform) === "darwin") {
    const match = executablePath.match(/^(.*\.app)\/Contents\/MacOS\/(Codex|ChatGPT)$/);
    if (!match) throw new Error("无法确定 Codex 应用程序包路径。");
    (options.run || execFileSync)("/usr/bin/open", ["-a", match[1]], { encoding: "utf8", timeout: 8000 });
    return null;
  }
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
  if (!["win32", "darwin"].includes(options.platform || process.platform) && !options.listProcesses) {
    throw new Error("自动重启 Codex 目前支持 Windows 和 macOS。");
  }
  const listProcesses = options.listProcesses || (() => listCodexProcesses(options));
  const terminate = options.terminate || ((processId) => terminateProcessTree(processId, { ...options, listProcesses }));
  const launch = options.launch || ((filePath) => launchDesktop(filePath, options));
  const wait = options.wait || delay;
  const attempts = Number(options.attempts || 80);
  const intervalMs = Number(options.intervalMs || 250);
  const originalProcesses = normalizeProcesses(listProcesses());
  const desktop = findCodexDesktopProcess(originalProcesses);
  if (!desktop) return { restarted: false, reason: "not_running" };

  const exitingPids = new Set([desktop.processId]);
  if ((options.platform || process.platform) === "darwin") {
    for (const item of originalProcesses) {
      if (item.parentProcessId === desktop.processId && /^codex$/i.test(item.name)
        && /\bapp-server\b/i.test(item.commandLine)) exitingPids.add(item.processId);
    }
  }
  terminate(desktop.processId);
  for (let index = 0; index < attempts; index += 1) {
    if (!listProcesses().some((item) => exitingPids.has(Number(item.processId || item.ProcessId)))) break;
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
  launchDesktop,
  restartCodex,
};
