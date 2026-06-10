import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  isAlive,
  processStartedAt,
  readPidRecord,
  runningPid,
  writePidFile,
} from '../src/cli/daemon';
import { pidFilePath } from '../src/watcher/paths';

// The pid file must identify a process, not just name a pid: pids are
// recycled, and a stale file must never cause stop() to signal whatever
// process happens to hold the number now.

let dir: string;
let previousStateDir: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cleancopy-daemon-'));
  previousStateDir = process.env.CLEANCOPY_STATE_DIR;
  process.env.CLEANCOPY_STATE_DIR = dir;
});

afterEach(() => {
  if (previousStateDir === undefined) delete process.env.CLEANCOPY_STATE_DIR;
  else process.env.CLEANCOPY_STATE_DIR = previousStateDir;
  rmSync(dir, { recursive: true, force: true });
});

describe('pid file identity', () => {
  it('round-trips a record that identifies the current process as running', () => {
    writePidFile();
    expect(readPidRecord()).toEqual({
      pid: process.pid,
      startedAt: processStartedAt(process.pid),
    });
    expect(runningPid()).toBe(process.pid);
  });

  it('treats a recycled pid (live pid, different start time) as not running', () => {
    writeFileSync(
      pidFilePath(),
      JSON.stringify({ pid: process.pid, startedAt: 'Thu Jan  1 00:00:00 1970' }),
    );
    expect(runningPid()).toBeNull();
    expect(existsSync(pidFilePath())).toBe(false); // stale file cleaned up
  });

  it('treats a dead process as not running', async () => {
    const child = spawn(process.execPath, ['-e', '']);
    const pid = child.pid!;
    await new Promise((resolve) => child.on('exit', resolve));
    writeFileSync(pidFilePath(), JSON.stringify({ pid, startedAt: 'whenever' }));
    expect(isAlive(pid)).toBe(false);
    expect(runningPid()).toBeNull();
  });

  it('rejects the old bare-number format and garbage', () => {
    writeFileSync(pidFilePath(), `${process.pid}\n`);
    expect(readPidRecord()).toBeNull();
    writeFileSync(pidFilePath(), 'not json at all');
    expect(readPidRecord()).toBeNull();
    writeFileSync(pidFilePath(), JSON.stringify({ pid: -4, startedAt: 'x' }));
    expect(readPidRecord()).toBeNull();
  });
});

describe('isAlive', () => {
  it('sees the current process', () => {
    expect(isAlive(process.pid)).toBe(true);
  });

  it("does not claim another user's process (EPERM) — it cannot be our daemon", () => {
    expect(isAlive(1)).toBe(false); // launchd: exists, but not signalable by us
  });
});
