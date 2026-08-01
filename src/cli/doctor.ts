import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import {
  loadConfig,
  resolveHelperBinary,
  stateDir,
} from '../watcher';
import { isLaunchAgentLoaded, plistPath } from './launchagent';
import { isAlive, processStartedAt, readPidRecord } from './daemon';

interface CheckResult {
  level: 'pass' | 'info' | 'fail';
  label: string;
  detail: string;
}

function nearestExistingParent(target: string): string {
  let current = target;
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) return current;
    current = parent;
  }
  return current;
}

function helperArchitectures(helperPath: string): string[] {
  try {
    return execFileSync('lipo', ['-archs', helperPath], { encoding: 'utf8' })
      .trim()
      .split(/\s+/)
      .filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Print content-safe installation diagnostics. This never reads clipboard
 * contents, creates state, or changes launchd configuration.
 */
export function doctor(version: string): number {
  const checks: CheckResult[] = [];

  checks.push({
    level: process.platform === 'darwin' ? 'pass' : 'fail',
    label: 'platform',
    detail: process.platform === 'darwin' ? `macOS ${process.arch}` : `${process.platform} is unsupported`,
  });

  const nodeMajor = Number.parseInt(process.versions.node.split('.')[0] ?? '', 10);
  checks.push({
    level: nodeMajor >= 22 ? 'pass' : 'fail',
    label: 'Node.js',
    detail: `${process.version}${nodeMajor >= 22 ? '' : ' (22 or later required)'}`,
  });

  let helperPath: string | null = null;
  try {
    helperPath = resolveHelperBinary();
    fs.accessSync(helperPath, fs.constants.X_OK);
    checks.push({ level: 'pass', label: 'helper', detail: `${helperPath} (executable)` });
  } catch (err) {
    checks.push({
      level: 'fail',
      label: 'helper',
      detail: err instanceof Error ? err.message.split('\n')[0] : String(err),
    });
  }

  if (helperPath && process.platform === 'darwin') {
    const architectures = helperArchitectures(helperPath);
    const universal = architectures.includes('arm64') && architectures.includes('x86_64');
    checks.push({
      level: universal ? 'pass' : 'fail',
      label: 'helper architectures',
      detail: architectures.length > 0
        ? `${architectures.join(', ')}${universal ? '' : ' (arm64 and x86_64 required)'}`
        : 'could not inspect helper binary',
    });
  }

  const { config, warnings } = loadConfig();
  checks.push({
    level: warnings.length === 0 ? 'pass' : 'fail',
    label: 'config',
    detail: warnings.length === 0
      ? `${config.mode} mode; clean ${config.hotkeys.clean ?? 'off'}; revert ${config.hotkeys.revert ?? 'off'}`
      : warnings.join('; '),
  });

  const writableTarget = nearestExistingParent(stateDir());
  try {
    fs.accessSync(writableTarget, fs.constants.R_OK | fs.constants.W_OK);
    checks.push({ level: 'pass', label: 'state directory', detail: stateDir() });
  } catch {
    checks.push({
      level: 'fail',
      label: 'state directory',
      detail: `${stateDir()} is not writable`,
    });
  }

  // Unlike `status`, doctor deliberately does not remove a stale pid file:
  // diagnostics should be safe to run while investigating a broken install.
  const record = readPidRecord();
  const pid = record &&
    isAlive(record.pid) &&
    (record.startedAt === '' || processStartedAt(record.pid) === record.startedAt)
    ? record.pid
    : null;
  checks.push({
    level: 'info',
    label: 'watcher',
    detail: pid === null ? 'not running' : `running (pid ${pid})`,
  });

  const installed = fs.existsSync(plistPath());
  checks.push({
    level: 'info',
    label: 'autostart',
    detail: !installed
      ? 'not installed'
      : isLaunchAgentLoaded()
        ? 'installed and loaded'
        : 'installed but not loaded',
  });

  process.stdout.write(`CleanCopy ${version} doctor\n`);
  for (const check of checks) {
    const marker = check.level === 'pass' ? 'ok' : check.level === 'info' ? '--' : '!!';
    process.stdout.write(`${marker} ${check.label}: ${check.detail}\n`);
  }

  const failures = checks.filter((check) => check.level === 'fail').length;
  process.stdout.write(
    failures === 0
      ? 'ready: all required checks passed\n'
      : `not ready: ${failures} required check${failures === 1 ? '' : 's'} failed\n`,
  );
  return failures === 0 ? 0 : 1;
}
