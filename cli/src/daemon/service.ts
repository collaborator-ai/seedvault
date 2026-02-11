import { resolve, dirname } from "path";
import { existsSync, mkdirSync, unlinkSync } from "fs";
import {
  getDaemonLogPath,
  getLaunchdPlistPath,
  getSystemdUnitPath,
  getSchtasksXmlPath,
  getPidPath,
  ensureConfigDir,
} from "../config.js";

// --- Types ---

export type Platform = "macos" | "linux" | "windows";

export interface ServiceStatus {
  installed: boolean;
  running: boolean;
  pid: number | null;
}

// --- Constants ---

const TASK_NAME = "SeedvaultDaemon";

// --- Platform detection ---

export function detectPlatform(): Platform {
  if (process.platform === "darwin") return "macos";
  if (process.platform === "linux") return "linux";
  if (process.platform === "win32") return "windows";
  throw new Error(`Unsupported platform: ${process.platform}. Only macOS, Linux, and Windows are supported.`);
}

// --- Internal helpers ---

function resolveBunPath(): string {
  const which = Bun.which("bun");
  if (which) return which;

  // Platform-specific fallbacks
  if (process.platform === "win32") {
    const fallback = resolve(process.env.USERPROFILE || process.env.HOME || "~", ".bun", "bin", "bun.exe");
    if (existsSync(fallback)) return fallback;
  } else {
    const fallback = resolve(process.env.HOME || "~", ".bun", "bin", "bun");
    if (existsSync(fallback)) return fallback;
  }

  throw new Error("Cannot find bun executable. Ensure bun is in your PATH.");
}

function resolveSvPath(): string {
  return resolve(process.argv[1]);
}

async function runCommand(cmd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  const proc = Bun.spawn([cmd, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);

  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    throw new Error(`Command failed: ${cmd} ${args.join(" ")}\n${stderr.trim() || stdout.trim()}`);
  }

  return { stdout: stdout.trim(), stderr: stderr.trim() };
}

// --- Service file generators ---

function generatePlist(bunPath: string, svPath: string, logPath: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>ai.seedvault.daemon</string>
  <key>ProgramArguments</key>
  <array>
    <string>${bunPath}</string>
    <string>${svPath}</string>
    <string>start</string>
    <string>--foreground</string>
  </array>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>5</integer>
  <key>StandardOutPath</key>
  <string>${logPath}</string>
  <key>StandardErrorPath</key>
  <string>${logPath}</string>
</dict>
</plist>
`;
}

function generateUnit(bunPath: string, svPath: string, logPath: string): string {
  return `[Unit]
Description=Seedvault Sync Daemon

[Service]
ExecStart=${bunPath} ${svPath} start --foreground
Restart=on-failure
RestartSec=5
StandardOutput=append:${logPath}
StandardError=append:${logPath}

[Install]
WantedBy=default.target
`;
}

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function generateTaskXml(bunPath: string, svPath: string, logPath: string): string {
  // XML task definition for Windows Task Scheduler.
  // - LogonTrigger: starts the task when the user logs in.
  // - RestartOnFailure: restarts every 5 seconds, up to 999 attempts.
  // - ExecutionTimeLimit: PT0S = no time limit (runs indefinitely).
  // - cmd /c with output redirection: captures stdout+stderr to the log file.
  const eBun = escapeXml(bunPath);
  const eSv = escapeXml(svPath);
  const eLog = escapeXml(logPath);
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>Seedvault Sync Daemon</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
    </LogonTrigger>
  </Triggers>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <RestartOnFailure>
      <Interval>PT5S</Interval>
      <Count>999</Count>
    </RestartOnFailure>
  </Settings>
  <Actions>
    <Exec>
      <Command>cmd</Command>
      <Arguments>/c "${eBun}" "${eSv}" start --foreground &gt;&gt; "${eLog}" 2&gt;&amp;1</Arguments>
    </Exec>
  </Actions>
</Task>
`;
}

// --- Service management ---

export async function installService(): Promise<void> {
  const platform = detectPlatform();
  const bunPath = resolveBunPath();
  const svPath = resolveSvPath();
  const logPath = getDaemonLogPath();

  ensureConfigDir();

  if (platform === "macos") {
    await installMacos(bunPath, svPath, logPath);
  } else if (platform === "linux") {
    await installLinux(bunPath, svPath, logPath);
  } else {
    await installWindows(bunPath, svPath, logPath);
  }
}

async function installMacos(bunPath: string, svPath: string, logPath: string): Promise<void> {
  const plistPath = getLaunchdPlistPath();
  const plistDir = dirname(plistPath);
  if (!existsSync(plistDir)) {
    mkdirSync(plistDir, { recursive: true });
  }

  // Unload existing service if installed (idempotent)
  if (existsSync(plistPath)) {
    try { await runCommand("launchctl", ["unload", plistPath]); } catch {}
  }

  await Bun.write(plistPath, generatePlist(bunPath, svPath, logPath));
  await runCommand("launchctl", ["load", plistPath]);

  console.log("Seedvault daemon registered with launchd.");
  console.log(`  Service: ai.seedvault.daemon`);
  console.log(`  Log:     ${logPath}`);
  console.log(`  The daemon will auto-restart on crash and start on login.`);
  console.log(`  Run 'sv status' to check, 'sv stop' to unregister.`);
}

async function installLinux(bunPath: string, svPath: string, logPath: string): Promise<void> {
  const unitPath = getSystemdUnitPath();
  const unitDir = dirname(unitPath);
  if (!existsSync(unitDir)) {
    mkdirSync(unitDir, { recursive: true });
  }

  if (existsSync(unitPath)) {
    try { await runCommand("systemctl", ["--user", "disable", "--now", "seedvault.service"]); } catch {}
  }

  await Bun.write(unitPath, generateUnit(bunPath, svPath, logPath));
  await runCommand("systemctl", ["--user", "daemon-reload"]);
  await runCommand("systemctl", ["--user", "enable", "--now", "seedvault.service"]);

  console.log("Seedvault daemon registered with systemd.");
  console.log(`  Service: seedvault.service`);
  console.log(`  Log:     ${logPath}`);
  console.log(`  The daemon will auto-restart on crash and start on login.`);
  console.log(`  Run 'sv status' to check, 'sv stop' to unregister.`);
}

async function installWindows(bunPath: string, svPath: string, logPath: string): Promise<void> {
  const xmlPath = getSchtasksXmlPath();

  // Delete existing task if present (idempotent)
  try { await runCommand("schtasks", ["/Delete", "/TN", TASK_NAME, "/F"]); } catch {}

  await Bun.write(xmlPath, generateTaskXml(bunPath, svPath, logPath));
  await runCommand("schtasks", ["/Create", "/TN", TASK_NAME, "/XML", xmlPath, "/F"]);

  // Start the task immediately
  await runCommand("schtasks", ["/Run", "/TN", TASK_NAME]);

  console.log("Seedvault daemon registered with Windows Task Scheduler.");
  console.log(`  Task:    ${TASK_NAME}`);
  console.log(`  Log:     ${logPath}`);
  console.log(`  The daemon will auto-restart on failure and start on login.`);
  console.log(`  Run 'sv status' to check, 'sv stop' to unregister.`);
}

export async function uninstallService(): Promise<void> {
  const platform = detectPlatform();

  if (platform === "macos") {
    await uninstallMacos();
  } else if (platform === "linux") {
    await uninstallLinux();
  } else {
    await uninstallWindows();
  }
}

async function uninstallMacos(): Promise<void> {
  const plistPath = getLaunchdPlistPath();

  if (!existsSync(plistPath)) {
    console.log("No daemon service is registered.");
    return;
  }

  try { await runCommand("launchctl", ["unload", plistPath]); } catch {}
  unlinkSync(plistPath);
  cleanupPidFile();
  console.log("Daemon stopped and service unregistered.");
}

async function uninstallLinux(): Promise<void> {
  const unitPath = getSystemdUnitPath();

  if (!existsSync(unitPath)) {
    console.log("No daemon service is registered.");
    return;
  }

  try { await runCommand("systemctl", ["--user", "disable", "--now", "seedvault.service"]); } catch {}
  unlinkSync(unitPath);
  try { await runCommand("systemctl", ["--user", "daemon-reload"]); } catch {}
  cleanupPidFile();
  console.log("Daemon stopped and service unregistered.");
}

async function uninstallWindows(): Promise<void> {
  // Check if task exists by querying it
  let taskExists = false;
  try {
    await runCommand("schtasks", ["/Query", "/TN", TASK_NAME]);
    taskExists = true;
  } catch {}

  if (!taskExists) {
    console.log("No daemon service is registered.");
    return;
  }

  // End the running task, then delete it
  try { await runCommand("schtasks", ["/End", "/TN", TASK_NAME]); } catch {}
  try { await runCommand("schtasks", ["/Delete", "/TN", TASK_NAME, "/F"]); } catch {}

  // Clean up the XML file
  const xmlPath = getSchtasksXmlPath();
  if (existsSync(xmlPath)) {
    try { unlinkSync(xmlPath); } catch {}
  }

  cleanupPidFile();
  console.log("Daemon stopped and service unregistered.");
}

function cleanupPidFile(): void {
  const pidPath = getPidPath();
  if (existsSync(pidPath)) {
    try { unlinkSync(pidPath); } catch {}
  }
}

// --- Status ---

export async function getServiceStatus(): Promise<ServiceStatus> {
  const platform = detectPlatform();

  if (platform === "macos") {
    return getStatusMacos();
  } else if (platform === "linux") {
    return getStatusLinux();
  } else {
    return getStatusWindows();
  }
}

async function getStatusMacos(): Promise<ServiceStatus> {
  const plistPath = getLaunchdPlistPath();
  if (!existsSync(plistPath)) {
    return { installed: false, running: false, pid: null };
  }

  try {
    const { stdout } = await runCommand("launchctl", ["list", "ai.seedvault.daemon"]);
    const pidMatch = stdout.match(/"PID"\s*=\s*(\d+)/);
    const pid = pidMatch ? parseInt(pidMatch[1], 10) : null;
    return { installed: true, running: pid !== null, pid };
  } catch {
    return { installed: true, running: false, pid: null };
  }
}

async function getStatusLinux(): Promise<ServiceStatus> {
  const unitPath = getSystemdUnitPath();
  if (!existsSync(unitPath)) {
    return { installed: false, running: false, pid: null };
  }

  let running = false;
  try {
    const { stdout } = await runCommand("systemctl", ["--user", "is-active", "seedvault.service"]);
    running = stdout === "active";
  } catch {}

  let pid: number | null = null;
  if (running) {
    try {
      const { stdout } = await runCommand("systemctl", ["--user", "show", "--property=MainPID", "seedvault.service"]);
      const match = stdout.match(/MainPID=(\d+)/);
      if (match) {
        const parsed = parseInt(match[1], 10);
        if (parsed > 0) pid = parsed;
      }
    } catch {}
  }

  return { installed: true, running, pid };
}

async function getStatusWindows(): Promise<ServiceStatus> {
  try {
    const { stdout } = await runCommand("schtasks", ["/Query", "/TN", TASK_NAME, "/FO", "CSV", "/NH"]);
    // CSV format: "TaskName","Next Run Time","Status"
    const installed = true;
    const running = stdout.toLowerCase().includes("running");

    // Try to get PID from the PID file (schtasks doesn't expose PID directly)
    let pid: number | null = null;
    const pidPath = getPidPath();
    if (running && existsSync(pidPath)) {
      try {
        const content = await Bun.file(pidPath).text();
        const parsed = parseInt(content.trim(), 10);
        if (!isNaN(parsed) && parsed > 0) pid = parsed;
      } catch {}
    }

    return { installed, running, pid };
  } catch {
    return { installed: false, running: false, pid: null };
  }
}
