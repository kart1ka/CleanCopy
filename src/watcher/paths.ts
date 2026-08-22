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
  // An explicit override is a statement of intent: silently running a
  // different binary than the one named hides the user's typo and, in a
  // debugging session, sends them chasing behaviour from a helper they
  // thought they had replaced. A mis-set CLEANCOPY_HELPER baked into a
  // LaunchAgent plist would otherwise never surface anywhere.
  const override = process.env.CLEANCOPY_HELPER;
  if (override && !fs.existsSync(override)) {
    throw new Error(
      `CLEANCOPY_HELPER is set to ${override}, which does not exist. ` +
        'Fix or unset it to use the bundled helper.',
    );
  }
  const candidates = [
    override,
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
