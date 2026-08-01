import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { logFilePath } from '../watcher';

// The launchd mechanics behind autostart: rendering the LaunchAgent plist and
// loading/unloading it with launchctl. Deliberately free of any daemon import
// so the dependency runs one way (daemon → launchagent); `install` and
// `stop --disable-autostart` orchestrate this with the other lifecycle commands
// in daemon.ts.

export const LAUNCH_AGENT_LABEL = 'com.cleancopy';

/** The per-user LaunchAgents plist this CLI manages. */
export function plistPath(): string {
  return path.join(os.homedir(), 'Library', 'LaunchAgents', `${LAUNCH_AGENT_LABEL}.plist`);
}

/** Config we pass through to the agent so it runs exactly as we were invoked. */
const PASSTHROUGH_ENV = [
  'CLEANCOPY_STATE_DIR',
  'CLEANCOPY_HELPER',
  'CLEANCOPY_PASTEBOARD',
  'CLEANCOPY_TERMINALS',
] as const;

export interface LaunchAgentConfig {
  label: string;
  /** Argv launchd execs — absolute node + script, since it has a bare PATH. */
  programArguments: string[];
  /** EnvironmentVariables dict; only the keys actually set are forwarded. */
  env: Record<string, string>;
  stdoutPath: string;
  stderrPath: string;
}

/** The agent config for the current invocation (paths, env, how to re-exec). */
export function currentConfig(): LaunchAgentConfig {
  const script = process.argv[1] ?? '';
  const env: Record<string, string> = {};
  for (const key of PASSTHROUGH_ENV) {
    const value = process.env[key];
    if (value) env[key] = value;
  }
  // Lets the daemon know launchd is supervising it: permanent startup
  // failures must then exit 0, or KeepAlive would relaunch them forever.
  env.CLEANCOPY_LAUNCHD = '1';
  return {
    label: LAUNCH_AGENT_LABEL,
    // Mirror how `start` re-execs (execArgv carries tsx's loader in dev).
    programArguments: [process.execPath, ...process.execArgv, script, 'run'],
    env,
    stdoutPath: logFilePath(),
    stderrPath: logFilePath(),
  };
}

function escapeXml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Render the LaunchAgent plist. Pure (string in, string out) so it can be
 * unit-tested without touching launchd or the real LaunchAgents directory.
 *
 * KeepAlive is gated on SuccessfulExit=false: launchd restarts the watcher
 * after a crash (non-zero exit) but NOT after a clean `cleancopy stop` (exit 0),
 * so stopping it doesn't fight launchd into an instant relaunch.
 */
export function buildPlist(cfg: LaunchAgentConfig): string {
  const args = cfg.programArguments
    .map((arg) => `    <string>${escapeXml(arg)}</string>`)
    .join('\n');

  const envEntries = Object.entries(cfg.env)
    .map(
      ([key, value]) =>
        `    <key>${escapeXml(key)}</key>\n    <string>${escapeXml(value)}</string>`,
    )
    .join('\n');
  const envBlock = envEntries
    ? `  <key>EnvironmentVariables</key>\n  <dict>\n${envEntries}\n  </dict>\n`
    : '';

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${escapeXml(cfg.label)}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
${envBlock}  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardOutPath</key>
  <string>${escapeXml(cfg.stdoutPath)}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(cfg.stderrPath)}</string>
</dict>
</plist>
`;
}

/** Bail with a clear message off macOS, where there is no launchd to talk to. */
export function ensureDarwin(): void {
  if (process.platform !== 'darwin') {
    process.stderr.write('autostart is only supported on macOS (launchd).\n');
    process.exit(1);
  }
}

/** launchctl domain target for this GUI login session, e.g. `gui/501`. */
function domainTarget(): string {
  return `gui/${process.getuid?.() ?? 0}`;
}

/** Unload any loaded instance; a no-op (not an error) when nothing is loaded. */
function bootout(): void {
  try {
    execFileSync('launchctl', ['bootout', `${domainTarget()}/${LAUNCH_AGENT_LABEL}`], {
      stdio: 'pipe',
    });
  } catch {
    // Not loaded — nothing to unload.
  }
}

/** Whether launchd currently has the agent loaded in this session. */
export function isLaunchAgentLoaded(): boolean {
  if (process.platform !== 'darwin') return false;
  try {
    execFileSync('launchctl', ['print', `${domainTarget()}/${LAUNCH_AGENT_LABEL}`], {
      stdio: 'pipe',
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Write the plist and (re)load it into launchd. Idempotent: any already-loaded
 * instance is dropped first. Throws if launchctl refuses to bootstrap.
 */
export function loadFreshPlist(config: LaunchAgentConfig): void {
  fs.mkdirSync(path.dirname(plistPath()), { recursive: true });
  fs.writeFileSync(plistPath(), buildPlist(config));
  bootout(); // drop any existing instance before loading the fresh plist
  execFileSync('launchctl', ['bootstrap', domainTarget(), plistPath()], { stdio: 'pipe' });
}

/** Unload the agent and delete its plist. Returns whether a plist existed. */
export function removePlist(): boolean {
  bootout();
  const existed = fs.existsSync(plistPath());
  fs.rmSync(plistPath(), { force: true });
  return existed;
}
