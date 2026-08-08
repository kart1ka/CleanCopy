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
  level: 'pass' | 'info' | 'warning' | 'fail';
  label: string;
  detail: string;
}

class InvalidStatePathError extends Error {}

function nearestExistingDirectory(target: string): string {
  let current = target;
  while (true) {
    try {
      if (!fs.statSync(current).isDirectory()) {
        throw new InvalidStatePathError(`${current} exists but is not a directory`);
      }
      return current;
    } catch (err) {
      if (err instanceof InvalidStatePathError) throw err;
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOTDIR') {
        throw new InvalidStatePathError(
          `${target} has an ancestor that is not a directory`,
        );
      }
      if (code !== 'ENOENT') throw err;
      const parent = path.dirname(current);
      if (parent === current) return current;
      current = parent;
    }
  }
}

interface ArchitectureInspection {
  architectures: string[];
  error: string | null;
}

function helperArchitectures(helperPath: string): ArchitectureInspection {
  try {
    return {
      architectures: execFileSync('/usr/bin/lipo', ['-archs', helperPath], {
        encoding: 'utf8',
      })
        .trim()
        .split(/\s+/)
        .filter(Boolean),
      error: null,
    };
  } catch (err) {
    return {
      architectures: [],
      error: err instanceof Error ? err.message.split('\n')[0] : String(err),
    };
  }
}

function machineArchitecture(): string {
  if (process.arch !== 'x64') return process.arch;
  try {
    const translated = execFileSync(
      '/usr/sbin/sysctl',
      ['-in', 'sysctl.proc_translated'],
      { encoding: 'utf8' },
    ).trim();
    if (translated === '1') return 'arm64';
  } catch {
    // Intel Macs do not expose sysctl.proc_translated.
  }
  return 'x86_64';
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

  // helperPath is only set once the executability check has passed — set any
  // earlier and a resolved-but-not-executable helper would print an "ok"
  // architectures line directly under its own "!!" failure.
  let helperPath: string | null = null;
  try {
    const resolved = resolveHelperBinary();
    fs.accessSync(resolved, fs.constants.X_OK);
    helperPath = resolved;
    checks.push({ level: 'pass', label: 'helper', detail: `${resolved} (executable)` });
  } catch (err) {
    checks.push({
      level: 'fail',
      label: 'helper',
      detail: err instanceof Error ? err.message.split('\n')[0] : String(err),
    });
  }

  if (helperPath && process.platform === 'darwin') {
    const inspection = helperArchitectures(helperPath);
    if (inspection.error !== null) {
      checks.push({
        level: 'warning',
        label: 'helper architectures',
        detail: `could not inspect helper binary (${inspection.error})`,
      });
    } else {
      const architecture = machineArchitecture();
      const universal = inspection.architectures.includes('arm64') &&
        inspection.architectures.includes('x86_64');
      const supportsMachine = inspection.architectures.includes(architecture);
      checks.push({
        level: supportsMachine ? 'pass' : 'fail',
        label: 'helper architectures',
        detail: `${inspection.architectures.join(', ')}${universal
          ? ' (universal)'
          : supportsMachine
            ? ' (machine architecture supported)'
            : ` (${architecture} required)`}`,
      });
    }
  }

  const { config, warnings } = loadConfig();
  checks.push({
    level: warnings.length === 0 ? 'pass' : 'warning',
    label: 'config',
    detail: warnings.length === 0
      ? `${config.mode} mode; clean ${config.hotkeys.clean ?? 'off'}; revert ${config.hotkeys.revert ?? 'off'}`
      : warnings.join('; '),
  });

  const stateDirectory = stateDir();
  try {
    const writableTarget = nearestExistingDirectory(stateDirectory);
    fs.accessSync(writableTarget, fs.constants.R_OK | fs.constants.W_OK);
    checks.push({ level: 'pass', label: 'state directory', detail: stateDirectory });
  } catch (err) {
    checks.push({
      level: 'fail',
      label: 'state directory',
      detail: err instanceof InvalidStatePathError
        ? err.message
        : `${stateDirectory} is not writable`,
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
    const marker = check.level === 'pass'
      ? 'ok'
      : check.level === 'info'
        ? '--'
        : check.level === 'warning'
          ? 'warn'
          : '!!';
    process.stdout.write(`${marker} ${check.label}: ${check.detail}\n`);
  }

  const failures = checks.filter((check) => check.level === 'fail').length;
  const warningCount = checks.filter((check) => check.level === 'warning').length;
  process.stdout.write(
    failures === 0
      ? `ready: all required checks passed${warningCount === 0
        ? ''
        : ` (${warningCount} warning${warningCount === 1 ? '' : 's'})`}\n`
      : `not ready: ${failures} required check${failures === 1 ? '' : 's'} failed\n`,
  );
  return failures === 0 ? 0 : 1;
}
