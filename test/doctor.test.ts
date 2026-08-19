import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  configWarnings: [] as string[],
  helperArchitectures: '',
  lipoError: false,
  stateDirectory: '',
  translated: false,
  agentLoaded: false,
  agentProgram: null as string | null,
  agentLastExit: null as number | null,
}));

vi.mock('child_process', () => ({
  execFileSync: vi.fn((file: string) => {
    if (file === '/usr/bin/lipo') {
      if (mocks.lipoError) throw new Error('lipo is unavailable');
      return `${mocks.helperArchitectures}\n`;
    }
    if (file === '/usr/sbin/sysctl') return mocks.translated ? '1\n' : '0\n';
    throw new Error(`unexpected command: ${file}`);
  }),
}));

vi.mock('../src/watcher', () => ({
  loadConfig: () => ({
    config: {
      mode: 'auto',
      hotkeys: { clean: 'cmd+ctrl+c', revert: 'cmd+ctrl+z' },
    },
    warnings: mocks.configWarnings,
  }),
  resolveHelperBinary: () => process.execPath,
  stateDir: () => mocks.stateDirectory,
}));

vi.mock('../src/cli/launchagent', () => ({
  isLaunchAgentLoaded: () => mocks.agentLoaded,
  plistPath: () => path.join(mocks.stateDirectory, 'launchagent.plist'),
  installedProgram: () => mocks.agentProgram,
  lastAgentExitCode: () => mocks.agentLastExit,
}));

vi.mock('../src/cli/daemon', () => ({
  isAlive: () => false,
  processStartedAt: () => null,
  readPidRecord: () => null,
}));

import { doctor } from '../src/cli/doctor';

describe('doctor', () => {
  const nativeNodeArchitecture = process.arch;
  let temporaryDirectory: string;
  let output: string;

  beforeEach(() => {
    temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'cleancopy-doctor-'));
    mocks.stateDirectory = path.join(temporaryDirectory, 'state');
    mocks.configWarnings = [];
    mocks.helperArchitectures = process.arch === 'x64' ? 'x86_64' : process.arch;
    mocks.lipoError = false;
    mocks.translated = false;
    mocks.agentLoaded = false;
    mocks.agentProgram = null;
    mocks.agentLastExit = null;
    output = '';
    vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => {
      output += chunk.toString();
      return true;
    }) as typeof process.stdout.write);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    Object.defineProperty(process, 'arch', {
      configurable: true,
      enumerable: true,
      value: nativeNodeArchitecture,
    });
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  });

  it('accepts a helper built only for the current architecture', () => {
    expect(doctor('test')).toBe(0);
    expect(output).toContain('ok helper architectures:');
    expect(output).toContain('(machine architecture supported)');
    expect(output).toContain('ready: all required checks passed');
  });

  it('treats an unavailable architecture inspection as a warning', () => {
    mocks.lipoError = true;

    expect(doctor('test')).toBe(0);
    expect(output).toContain(
      'warn helper architectures: could not inspect helper binary (lipo is unavailable)',
    );
    expect(output).toContain('ready: all required checks passed (1 warning)');
  });

  it('uses the machine architecture when Node is translated by Rosetta', () => {
    Object.defineProperty(process, 'arch', {
      configurable: true,
      enumerable: true,
      value: 'x64',
    });
    mocks.translated = true;
    mocks.helperArchitectures = 'arm64';

    expect(doctor('test')).toBe(0);
    expect(output).toContain('ok helper architectures: arm64 (machine architecture supported)');
  });

  it('reports recovered configuration problems as non-fatal warnings', () => {
    mocks.configWarnings = ['invalid mode — using default'];

    expect(doctor('test')).toBe(0);
    expect(output).toContain('warn config: invalid mode — using default');
    expect(output).toContain('ready: all required checks passed (1 warning)');
  });

  it('fails when the installed launch agent runs a Node that no longer exists', () => {
    // The pinned-Node caveat: after an nvm/fnm switch launchd fails every
    // launch silently while status still says "enabled". Doctor is the
    // safety net and must say so.
    fs.mkdirSync(mocks.stateDirectory, { recursive: true });
    fs.writeFileSync(path.join(mocks.stateDirectory, 'launchagent.plist'), '<plist/>');
    mocks.agentLoaded = true;
    mocks.agentProgram = path.join(mocks.stateDirectory, 'node-that-was-removed');

    expect(doctor('test')).toBe(1);
    expect(output).toContain('!! autostart: launch agent runs');
    expect(output).toContain('re-run `cleancopy install`');
  });

  it('fails when launchd reports the agent failing to start', () => {
    fs.mkdirSync(mocks.stateDirectory, { recursive: true });
    fs.writeFileSync(path.join(mocks.stateDirectory, 'launchagent.plist'), '<plist/>');
    mocks.agentLoaded = true;
    mocks.agentLastExit = 78; // EX_CONFIG — what a broken spawn records

    expect(doctor('test')).toBe(1);
    expect(output).toContain('!! autostart: launch agent is failing to start (last exit code 78)');
  });

  it('keeps a cleanly stopped installed agent as plain info', () => {
    fs.mkdirSync(mocks.stateDirectory, { recursive: true });
    fs.writeFileSync(path.join(mocks.stateDirectory, 'launchagent.plist'), '<plist/>');
    mocks.agentLoaded = true;
    mocks.agentLastExit = 0; // `cleancopy stop` exits 0 — not a failure

    expect(doctor('test')).toBe(0);
    expect(output).toContain('-- autostart: installed and loaded');
  });

  it('fails when the state-directory path is a regular file', () => {
    fs.writeFileSync(mocks.stateDirectory, 'not a directory');

    expect(doctor('test')).toBe(1);
    expect(output).toContain(`!! state directory: ${mocks.stateDirectory} exists but is not a directory`);
    expect(output).toContain('not ready: 1 required check failed');
  });

  it('fails when an ancestor of the state directory is a regular file', () => {
    const blockingAncestor = path.join(temporaryDirectory, 'not-a-directory');
    fs.writeFileSync(blockingAncestor, 'not a directory');
    mocks.stateDirectory = path.join(blockingAncestor, 'state');

    expect(doctor('test')).toBe(1);
    expect(output).toContain(
      `!! state directory: ${mocks.stateDirectory} has an ancestor that is not a directory`,
    );
    expect(output).toContain('not ready: 1 required check failed');
  });
});
