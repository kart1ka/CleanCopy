import { spawn } from 'child_process';
import * as fs from 'fs';
import {
  ensureStateDir,
  logFilePath,
  pidFilePath,
  resolveHelperBinary,
  startWatcher,
} from '../watcher';

// `cleancopy start` daemonizes `cleancopy run`: a detached copy of this CLI
// with stdout/stderr redirected to the event log, tracked by a pid file in
// ~/.cleancopy. The log receives event lines only — never clipboard text.

export function readPid(): number | null {
  try {
    const pid = parseInt(fs.readFileSync(pidFilePath(), 'utf8').trim(), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function runningPid(): number | null {
  const pid = readPid();
  if (pid === null) return null;
  if (isAlive(pid)) return pid;
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
  fs.writeFileSync(pidFilePath(), `${process.pid}\n`);

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
  if (pid === null) {
    process.stdout.write('cleancopy is not running\n');
    return;
  }
  process.kill(pid, 'SIGTERM');
  for (let i = 0; i < 30; i++) {
    await sleep(100);
    if (!isAlive(pid)) {
      fs.rmSync(pidFilePath(), { force: true });
      process.stdout.write('cleancopy stopped\n');
      return;
    }
  }
  process.stderr.write(`cleancopy (pid ${pid}) did not exit after 3s; sending SIGKILL\n`);
  process.kill(pid, 'SIGKILL');
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
}
