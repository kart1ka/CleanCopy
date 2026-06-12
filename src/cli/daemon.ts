import { execFileSync, spawn } from 'child_process';
import * as fs from 'fs';
import {
  ensureStateDir,
  logFilePath,
  pidFilePath,
  resolveHelperBinary,
  startWatcher,
} from '../watcher';
import {
  currentConfig,
  ensureDarwin,
  isLaunchAgentLoaded,
  loadFreshPlist,
  plistPath,
  removePlist,
} from './launchagent';

// `cleancopy start` daemonizes `cleancopy run`: a detached copy of this CLI
// with stdout/stderr redirected to the event log, tracked by a pid file in
// ~/.cleancopy. The log receives event lines only — never clipboard text.
//
// The pid file records the pid AND the process start time. Pids are recycled:
// after a crash leaves a stale file, the bare pid can belong to a completely
// unrelated process, and acting on it would let `cleancopy stop` SIGKILL
// something that was never ours. Same pid + same start time is, in practice,
// the same process.

export interface PidRecord {
  pid: number;
  /** `ps -o lstart` of the daemon when it wrote the file ('' if ps failed). */
  startedAt: string;
}

/** When the process started, per ps(1); null when the pid is gone. */
export function processStartedAt(pid: number): string | null {
  try {
    const out = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf8',
    }).trim();
    return out || null;
  } catch {
    return null;
  }
}

export function readPidRecord(): PidRecord | null {
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(pidFilePath(), 'utf8'));
    if (typeof raw !== 'object' || raw === null) return null;
    const record = raw as Record<string, unknown>;
    if (!Number.isInteger(record.pid) || (record.pid as number) <= 0) return null;
    if (typeof record.startedAt !== 'string') return null;
    return { pid: record.pid as number, startedAt: record.startedAt };
  } catch {
    return null;
  }
}

export function writePidFile(): void {
  const record: PidRecord = {
    pid: process.pid,
    startedAt: processStartedAt(process.pid) ?? '',
  };
  fs.writeFileSync(pidFilePath(), JSON.stringify(record) + '\n');
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    // ESRCH: no such process. EPERM: someone else's process — which cannot
    // be our daemon either, since the daemon runs as this same user.
    return false;
  }
}

/** Whether the record still points at the process that wrote it. */
function isOurs(record: PidRecord): boolean {
  if (!isAlive(record.pid)) return false;
  // '' means ps failed when the file was written; fall back to liveness alone.
  return record.startedAt === '' || processStartedAt(record.pid) === record.startedAt;
}

export function runningPid(): number | null {
  const record = readPidRecord();
  if (record === null) return null;
  if (isOurs(record)) return record.pid;
  fs.rmSync(pidFilePath(), { force: true }); // stale pid file
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Foreground watcher: what `cleancopy run` executes and `start` daemonizes. */
export function runForeground(): void {
  const existing = runningPid();
  if (existing !== null) {
    process.stderr.write(`cleancopy is already running (pid ${existing})\n`);
    process.exit(1);
  }

  const helperPath = resolveHelperBinary();
  ensureStateDir();
  writePidFile();

  const log = (line: string) =>
    process.stdout.write(`${new Date().toISOString()} ${line}\n`);

  const watcher = startWatcher({
    helperPath,
    log,
    pasteboard: process.env.CLEANCOPY_PASTEBOARD || undefined,
    onFatal: () => shutdown(1),
  });

  let shuttingDown = false;
  function shutdown(code: number): void {
    if (shuttingDown) return;
    shuttingDown = true;
    log('stopping');
    watcher.stop();
    fs.rmSync(pidFilePath(), { force: true });
    // Give the helper its grace period to exit on stdin EOF.
    setTimeout(() => process.exit(code), 600).unref();
  }

  process.on('SIGINT', () => shutdown(0));
  process.on('SIGTERM', () => shutdown(0));
  log('cleancopy started');
}

export async function start(): Promise<void> {
  const existing = runningPid();
  if (existing !== null) {
    process.stdout.write(`cleancopy is already running (pid ${existing})\n`);
    return;
  }

  resolveHelperBinary(); // fail fast, with a useful message, before forking
  ensureStateDir();
  const logFd = fs.openSync(logFilePath(), 'a');

  // Re-run this same CLI entry as `run`, detached. execArgv carries any
  // loader flags (so this also works under tsx in development).
  const child = spawn(
    process.execPath,
    [...process.execArgv, process.argv[1], 'run'],
    { detached: true, stdio: ['ignore', logFd, logFd] },
  );
  child.unref();
  fs.closeSync(logFd);

  // The child writes the pid file itself once it is actually up.
  for (let i = 0; i < 20; i++) {
    await sleep(100);
    const pid = runningPid();
    if (pid !== null) {
      process.stdout.write(`cleancopy started (pid ${pid})\n`);
      process.stdout.write(`events are logged to ${logFilePath()} (never clipboard contents)\n`);
      return;
    }
    if (child.exitCode !== null) break;
  }
  process.stderr.write(`cleancopy failed to start — check ${logFilePath()}\n`);
  process.exit(1);
}

export async function stop(): Promise<void> {
  const pid = runningPid();
  const record = readPidRecord();
  if (pid === null || record === null) {
    process.stdout.write('cleancopy is not running\n');
    return;
  }
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    // It exited between the liveness check and the signal.
  }
  for (let i = 0; i < 30; i++) {
    await sleep(100);
    if (!isAlive(pid)) {
      fs.rmSync(pidFilePath(), { force: true });
      process.stdout.write('cleancopy stopped\n');
      return;
    }
  }
  // Re-verify identity before the force kill: SIGKILL must never reach a
  // process that merely inherited the daemon's old pid.
  if (record.startedAt !== '' && processStartedAt(pid) !== record.startedAt) {
    fs.rmSync(pidFilePath(), { force: true });
    process.stdout.write('cleancopy stopped\n');
    return;
  }
  process.stderr.write(`cleancopy (pid ${pid}) did not exit after 3s; sending SIGKILL\n`);
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // Already gone.
  }
  fs.rmSync(pidFilePath(), { force: true });
}

export function status(): void {
  const pid = runningPid();
  if (pid !== null) {
    process.stdout.write(`cleancopy is running (pid ${pid})\n`);
  } else {
    process.stdout.write('cleancopy is not running\n');
  }
  let helper: string;
  try {
    helper = resolveHelperBinary();
  } catch {
    helper = 'NOT FOUND — run `npm run build:helper`';
  }
  process.stdout.write(`helper: ${helper}\n`);
  process.stdout.write(`log:    ${logFilePath()}\n`);

  const installed = fs.existsSync(plistPath());
  const autostart = !installed
    ? 'disabled (run `cleancopy install`)'
    : isLaunchAgentLoaded()
      ? 'enabled (starts at login)'
      : 'installed but not loaded';
  process.stdout.write(`autostart: ${autostart}\n`);
}

/** Register the launchd LaunchAgent so the watcher starts at login. */
export async function install(): Promise<void> {
  ensureDarwin();
  resolveHelperBinary(); // fail fast with a useful message before we touch launchd

  // A manually-started daemon already owns the pid file; stop it so the
  // launch-agent copy becomes the single owner instead of colliding.
  if (runningPid() !== null) await stop();

  ensureStateDir(); // StandardOutPath's parent must exist before launchd opens it
  try {
    loadFreshPlist(currentConfig());
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    process.stderr.write(`failed to load the launch agent: ${detail}\n`);
    process.exit(1);
  }

  process.stdout.write('cleancopy will now start automatically at login.\n');
  process.stdout.write(`launch agent: ${plistPath()}\n`);
  // The plist pins an absolute Node path (launchd has a bare PATH and can't
  // resolve a version-managed `node`). If that path moves, the agent silently
  // fails to launch — so tell the user how to repair it.
  process.stdout.write(
    `note: autostart is pinned to this Node binary:\n        ${process.execPath}\n` +
      '      If you upgrade or switch Node (e.g. via nvm/fnm), re-run `cleancopy install`.\n',
  );
}

/** Remove the launchd LaunchAgent so the watcher no longer starts at login. */
export function uninstall(): void {
  ensureDarwin();
  const existed = removePlist();
  process.stdout.write(
    existed
      ? 'cleancopy will no longer start automatically.\n'
      : 'autostart was not installed.\n',
  );
}
