import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Where CleanCopy keeps its runtime files (pid file, event log). Contents are
// events only — never clipboard text.

export function stateDir(): string {
  const override = process.env.CLEANCOPY_STATE_DIR;
  // resolve() makes each process's view deterministic, but it cannot make a
  // RELATIVE override coherent across commands — `start` in one directory and
  // `stop` in another still resolve to different places. That is inherent to
  // a relative env var, so the CLI warns about relative overrides at startup,
  // and `install` bakes the resolved absolute path into the launchd plist.
  return override ? path.resolve(override) : path.join(os.homedir(), '.cleancopy');
}

export function ensureStateDir(): string {
  const dir = stateDir();
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function pidFilePath(): string {
  return path.join(stateDir(), 'cleancopy.pid');
}

export function logFilePath(): string {
  return path.join(stateDir(), 'cleancopy.log');
}

/**
 * Find the Swift helper binary. Checked in order:
 *   1. CLEANCOPY_HELPER env var (explicit override)
 *   2. helper/bin/cleancopy-helper — the prebuilt binary shipped in the
 *      npm package (and where `npm run build:helper` puts a local build)
 *   3. helper/.build/release/cleancopy-helper — a raw `swift build` output
 */
export function resolveHelperBinary(): string {
  const packageRoot = path.resolve(__dirname, '..', '..');
  const candidates = [
    process.env.CLEANCOPY_HELPER,
    path.join(packageRoot, 'helper', 'bin', 'cleancopy-helper'),
    path.join(packageRoot, 'helper', '.build', 'release', 'cleancopy-helper'),
  ].filter((p): p is string => Boolean(p));

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error(
    'cleancopy-helper binary not found. Build it with `npm run build:helper` ' +
      '(requires Xcode command-line tools), or point CLEANCOPY_HELPER at it.\n' +
      `Looked in:\n  ${candidates.join('\n  ')}`,
  );
}
