import { execFileSync, spawn } from 'child_process';
import * as fs from 'fs';
import {
  configFilePath,
  ensureStateDir,
  loadConfig,
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

export function writePidFile(): PidRecord {
  const record: PidRecord = {
    pid: process.pid,
    startedAt: processStartedAt(process.pid) ?? '',
  };
  fs.writeFileSync(pidFilePath(), JSON.stringify(record) + '\n');
  return record;
}

/**
 * Atomically claim the pid file for this process, or return null when a
 * live daemon already holds it. Exclusive create (O_EXCL) closes the
 * check-then-write race: two daemons started at once (double `start`, or a
 * manual start racing the launchd agent at login) would both see "not
 * running" and both come up — the second silently clobbering the first's
 * record, leaving a daemon that stop() can never find.
 */
export function claimPidFile(): PidRecord | null {
  const record: PidRecord = {
    pid: process.pid,
    startedAt: processStartedAt(process.pid) ?? '',
  };
  const payload = JSON.stringify(record) + '\n';
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(pidFilePath(), payload, { flag: 'wx' });
      return record;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      // Someone holds the file. If it's a live daemon, we lose; if it's
      // stale, runningRecord() removes it and the retry can claim it.
      if (runningRecord() !== null) return null;
    }
  }
  return null; // lost the post-cleanup re-claim race too
}

/**
 * Remove the pid file only if it still holds `record`. Between deciding a
 * daemon is gone and deleting its file, launchd (or a concurrent `start`)
 * may have written a fresh record for a new daemon — deleting that would
 * leave the new daemon running but untracked.
 */
export function removePidFileIfMatches(record: PidRecord): void {
  const current = readPidRecord();
  if (current === null) return;
  if (current.pid !== record.pid) return;
  if (
    record.startedAt !== '' &&
    current.startedAt !== '' &&
    current.startedAt !== record.startedAt
  ) {
    return;
  }
  fs.rmSync(pidFilePath(), { force: true });
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

/**
 * Whether the record still points at the process that wrote it — THE
 * pid-recycling rule. Read-only; exported so doctor shares this exact check
 * instead of drifting on a copy.
 */
export function isOurs(record: PidRecord): boolean {
  if (!isAlive(record.pid)) return false;
  // '' means ps failed when the file was written; fall back to liveness alone.
  return record.startedAt === '' || processStartedAt(record.pid) === record.startedAt;
}

/** The validated record of a live daemon, or null (stale files are removed). */
export function runningRecord(): PidRecord | null {
  const record = readPidRecord();
  if (record === null) {
    // A pid file that exists but holds no parseable record (a torn write:
    // crash mid-write, full disk) used to be a dead end — every command said
    // "not running", yet `start`'s exclusive create kept failing against the
    // never-deleted file, so its log claimed "already running (pid unknown)"
    // and only a hand-run `rm` recovered. The file carries no usable
    // information; treat it exactly like a stale record and remove it.
    // Re-reading before deleting keeps a fresh daemon's just-written valid
    // record out of the blast radius. (doctor never calls this — it reads
    // the record directly, and stays non-destructive by design.)
    if (fs.existsSync(pidFilePath()) && readPidRecord() === null) {
      fs.rmSync(pidFilePath(), { force: true });
    }
    return null;
  }
  if (isOurs(record)) return record;
  removePidFileIfMatches(record); // stale pid file
  return null;
}

export function runningPid(): number | null {
  return runningRecord()?.pid ?? null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Record the intended status before scheduling the grace-period exit. The
 * timer is unref'd, so Node may finish naturally first; exitCode makes that
 * natural exit carry the same status instead of silently becoming success.
 */
export function scheduleProcessExit(
  code: number,
  delayMs = 600,
  exit: (code: number) => never = process.exit,
): NodeJS.Timeout {
  process.exitCode = code;
  const timer = setTimeout(() => exit(code), delayMs);
  timer.unref();
  return timer;
}

/**
 * Exit status for a startup failure that relaunching cannot fix (already
 * running, helper binary missing). Under the launch agent (KeepAlive gated
 * on SuccessfulExit=false) a non-zero exit means "relaunch me", which would
 * turn such failures into an infinite retry loop — so there they exit 0.
 */
export function startupFailureExitCode(): number {
  return process.env.CLEANCOPY_LAUNCHD === '1' ? 0 : 1;
}

/** Foreground watcher: what `cleancopy run` executes and `start` daemonizes. */
export function runForeground(): void {
  const failStartup: (message: string) => never = (message) => {
    process.stderr.write(message);
    process.exit(startupFailureExitCode());
  };

  let helperPath: string;
  try {
    helperPath = resolveHelperBinary();
  } catch (err) {
    failStartup(`${err instanceof Error ? err.message : String(err)}\n`);
  }

  // An unwritable or invalid state dir is as unfixable-by-relaunch as a
  // missing helper: outside failStartup it would escape as an uncaught throw
  // (exit 1), which under the launch agent's KeepAlive means being relaunched
  // into the same failure forever.
  let claimed: PidRecord | null;
  try {
    ensureStateDir();
    claimed = claimPidFile();
  } catch (err) {
    failStartup(`${err instanceof Error ? err.message : String(err)}\n`);
  }
  if (claimed === null) {
    failStartup(`cleancopy is already running (pid ${runningPid() ?? 'unknown'})\n`);
  }
  const ownRecord: PidRecord = claimed;

  const log = (line: string) =>
    process.stdout.write(`${new Date().toISOString()} ${line}\n`);

  // A broken config file downgrades to defaults with a logged warning; it
  // must never keep the watcher from starting.
  const { config, warnings } = loadConfig();
  for (const warning of warnings) log(`config: ${warning}`);
  log(
    config.mode === 'manual'
      ? 'mode: manual — a terminal copy is cleaned only when the same text is copied twice, quickly'
      : 'mode: auto — terminal copies are cleaned as they land',
  );
  if (config.hotkeys.revert) log(`revert hotkey: ${config.hotkeys.revert}`);

  const watcher = startWatcher({
    helperPath,
    log,
    pasteboard: process.env.CLEANCOPY_PASTEBOARD || undefined,
    mode: config.mode,
    hotkeys: config.hotkeys,
    onFatal: () => shutdown(1),
  });

  let shuttingDown = false;
  function shutdown(code: number): void {
    if (shuttingDown) return;
    shuttingDown = true;
    log('stopping');
    watcher.stop();
    removePidFileIfMatches(ownRecord);
    // Give the helper its grace period to exit on stdin EOF.
    scheduleProcessExit(code);
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

async function stopWatcher(): Promise<void> {
  // One validated read: pid and identity always come from the same record,
  // and every deletion below re-checks the file still holds that record.
  const record = runningRecord();
  if (record === null) {
    process.stdout.write('cleancopy is not running\n');
    return;
  }
  const pid = record.pid;
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    // It exited between the liveness check and the signal.
  }
  for (let i = 0; i < 30; i++) {
    await sleep(100);
    if (!isAlive(pid)) {
      removePidFileIfMatches(record);
      process.stdout.write('cleancopy stopped\n');
      return;
    }
  }
  // Re-verify identity before the force kill: SIGKILL must never reach a
  // process that merely inherited the daemon's old pid.
  if (record.startedAt !== '' && processStartedAt(pid) !== record.startedAt) {
    removePidFileIfMatches(record);
    process.stdout.write('cleancopy stopped\n');
    return;
  }
  process.stderr.write(`cleancopy (pid ${pid}) did not exit after 3s; sending SIGKILL\n`);
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // Already gone.
  }
  removePidFileIfMatches(record);
}

export interface StopOptions {
  /** Also remove the launch agent so CleanCopy stays stopped after login. */
  disableAutostart?: boolean;
}

/** Stop now, optionally making that choice persistent across future logins. */
export async function stop(options: StopOptions = {}): Promise<void> {
  await stopWatcher();
  if (!options.disableAutostart) return;

  ensureDarwin();
  const existed = removePlist();
  process.stdout.write(
    existed
      ? 'autostart disabled; cleancopy will stay stopped after login\n'
      : 'autostart was already disabled\n',
  );
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

  const { config } = loadConfig();
  process.stdout.write(
    config.mode === 'manual'
      ? 'mode:   manual — a copy is cleaned only when you copy the same text twice, quickly\n'
      : 'mode:   auto — terminal copies are cleaned as they land\n',
  );
  process.stdout.write(
    `revert: ${config.hotkeys.revert ? `press ${config.hotkeys.revert} to restore the last original` : 'off'}\n`,
  );
  process.stdout.write(`config: ${configFilePath()} (edit via \`cleancopy config\`)\n`);

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
