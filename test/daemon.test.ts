import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  claimPidFile,
  isAlive,
  processStartedAt,
  readPidRecord,
  removePidFileIfMatches,
  runningPid,
  runningRecord,
  scheduleProcessExit,
  startupFailureExitCode,
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

  it('recovers from a corrupt pid file instead of dead-ending', () => {
    // A torn write used to be unrecoverable: every command said "not
    // running", yet start's exclusive create kept failing against the
    // never-deleted file — only a hand-run `rm` escaped. Unparseable
    // content carries no information; it must be cleaned like a stale
    // record so the next start can claim the file.
    writeFileSync(pidFilePath(), 'not json at all');
    expect(runningPid()).toBeNull();
    expect(existsSync(pidFilePath())).toBe(false); // corrupt file cleaned up
    expect(claimPidFile()).not.toBeNull(); // and start can claim it again
    rmSync(pidFilePath(), { force: true });
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

describe('pid file claim', () => {
  it('claims a free pid file and writes this process record', () => {
    expect(claimPidFile()).toEqual({
      pid: process.pid,
      startedAt: processStartedAt(process.pid),
    });
    expect(runningPid()).toBe(process.pid);
  });

  it('refuses when a live daemon already holds the file', () => {
    // The current process stands in for the live daemon.
    expect(claimPidFile()).not.toBeNull();
    expect(claimPidFile()).toBeNull();
    // The winner's record is untouched by the losing claim.
    expect(readPidRecord()?.pid).toBe(process.pid);
  });

  it('takes over a stale pid file (recycled pid, different start time)', () => {
    writeFileSync(
      pidFilePath(),
      JSON.stringify({ pid: process.pid, startedAt: 'Thu Jan  1 00:00:00 1970' }),
    );
    expect(claimPidFile()).toEqual({
      pid: process.pid,
      startedAt: processStartedAt(process.pid),
    });
  });

  it('takes over a dead daemon pid file', async () => {
    const child = spawn(process.execPath, ['-e', '']);
    const pid = child.pid!;
    await new Promise((resolve) => child.on('exit', resolve));
    writeFileSync(pidFilePath(), JSON.stringify({ pid, startedAt: 'whenever' }));
    expect(claimPidFile()).not.toBeNull();
    expect(readPidRecord()?.pid).toBe(process.pid);
  });
});

describe('pid file deletion safety', () => {
  // The race this guards: stop() decides daemon A is gone, but launchd has
  // already relaunched daemon B and B wrote a fresh pid file. Deleting by
  // path would orphan B — running, but invisible to status/stop.
  it('leaves a pid file that a newer daemon has rewritten', () => {
    const fresh = writePidFile(); // "daemon B": the current process
    removePidFileIfMatches({ pid: 424242, startedAt: 'Thu Jun  1 00:00:00 2023' });
    expect(readPidRecord()).toEqual(fresh);
  });

  it('leaves a pid file whose start time no longer matches the acted-on record', () => {
    const fresh = writePidFile();
    removePidFileIfMatches({ pid: process.pid, startedAt: 'Thu Jan  1 00:00:00 1970' });
    expect(readPidRecord()).toEqual(fresh);
  });

  it('removes the pid file when it still holds the acted-on record', () => {
    const record = writePidFile();
    removePidFileIfMatches(record);
    expect(existsSync(pidFilePath())).toBe(false);
  });

  it('tolerates the file already being gone', () => {
    expect(() =>
      removePidFileIfMatches({ pid: process.pid, startedAt: '' }),
    ).not.toThrow();
  });

  it('falls back to pid-only matching when a side recorded no start time', () => {
    writePidFile();
    removePidFileIfMatches({ pid: process.pid, startedAt: '' });
    expect(existsSync(pidFilePath())).toBe(false);
  });

  it('runningRecord returns the validated record and still cleans stale files', () => {
    const record = writePidFile();
    expect(runningRecord()).toEqual(record);
    writeFileSync(
      pidFilePath(),
      JSON.stringify({ pid: process.pid, startedAt: 'Thu Jan  1 00:00:00 1970' }),
    );
    expect(runningRecord()).toBeNull();
    expect(existsSync(pidFilePath())).toBe(false);
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

describe('startup failure exit status', () => {
  // KeepAlive{SuccessfulExit:false} relaunches any non-zero exit. A failure
  // that relaunching cannot fix (already running, missing helper) must exit 0
  // under launchd or the agent retries forever; a manual run keeps exit 1.
  it('is 0 under the launch agent and 1 otherwise', () => {
    const previous = process.env.CLEANCOPY_LAUNCHD;
    try {
      process.env.CLEANCOPY_LAUNCHD = '1';
      expect(startupFailureExitCode()).toBe(0);
      delete process.env.CLEANCOPY_LAUNCHD;
      expect(startupFailureExitCode()).toBe(1);
    } finally {
      if (previous === undefined) delete process.env.CLEANCOPY_LAUNCHD;
      else process.env.CLEANCOPY_LAUNCHD = previous;
    }
  });
});

describe('fatal shutdown status', () => {
  it('records the exit code before its unrefed grace-period timer can be skipped', () => {
    const previous = process.exitCode;
    const timer = scheduleProcessExit(1, 60_000, (() => {
      throw new Error('test exit callback should not run');
    }) as (code: number) => never);
    try {
      expect(process.exitCode).toBe(1);
    } finally {
      clearTimeout(timer);
      process.exitCode = previous;
    }
  });
});
