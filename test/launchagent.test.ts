import { describe, it, expect } from 'vitest';
import {
  buildPlist,
  currentConfig,
  LAUNCH_AGENT_LABEL,
  plistPath,
  type LaunchAgentConfig,
} from '../src/cli/launchagent';

const base: LaunchAgentConfig = {
  label: 'com.cleancopy',
  programArguments: ['/usr/local/bin/node', '/opt/app/cli.js', 'run'],
  env: {},
  stdoutPath: '/Users/me/.cleancopy/cleancopy.log',
  stderrPath: '/Users/me/.cleancopy/cleancopy.log',
};

describe('buildPlist', () => {
  it('emits each program argument as its own <string>', () => {
    const plist = buildPlist(base);
    expect(plist).toContain('<string>/usr/local/bin/node</string>');
    expect(plist).toContain('<string>/opt/app/cli.js</string>');
    expect(plist).toContain('<string>run</string>');
    expect(plist).toContain('<key>Label</key>\n  <string>com.cleancopy</string>');
  });

  it('starts at login and restarts only on a non-clean exit', () => {
    const plist = buildPlist(base);
    expect(plist).toContain('<key>RunAtLoad</key>\n  <true/>');
    // KeepAlive{SuccessfulExit:false} = restart on crash, not after `stop`.
    expect(plist).toMatch(
      /<key>KeepAlive<\/key>\s*<dict>\s*<key>SuccessfulExit<\/key>\s*<false\/>/,
    );
  });

  it('points stdout and stderr at the event log', () => {
    const plist = buildPlist(base);
    expect(plist).toContain(
      '<key>StandardOutPath</key>\n  <string>/Users/me/.cleancopy/cleancopy.log</string>',
    );
    expect(plist).toContain(
      '<key>StandardErrorPath</key>\n  <string>/Users/me/.cleancopy/cleancopy.log</string>',
    );
  });

  it('forwards set env vars and omits the dict entirely when none are set', () => {
    const withEnv = buildPlist({
      ...base,
      env: { CLEANCOPY_STATE_DIR: '/tmp/state', CLEANCOPY_PASTEBOARD: 'test-pb' },
    });
    expect(withEnv).toContain('<key>EnvironmentVariables</key>');
    expect(withEnv).toContain('<key>CLEANCOPY_STATE_DIR</key>\n    <string>/tmp/state</string>');
    expect(withEnv).toContain('<key>CLEANCOPY_PASTEBOARD</key>\n    <string>test-pb</string>');

    expect(buildPlist(base)).not.toContain('EnvironmentVariables');
  });

  it('escapes XML metacharacters in paths and values', () => {
    const plist = buildPlist({
      ...base,
      programArguments: ['/bin/n', '/Tom & Jerry/<cli>.js', 'run'],
      env: { CLEANCOPY_STATE_DIR: '/a&b/<c>' },
    });
    expect(plist).toContain('<string>/Tom &amp; Jerry/&lt;cli&gt;.js</string>');
    expect(plist).toContain('<string>/a&amp;b/&lt;c&gt;</string>');
    expect(plist).not.toMatch(/Tom & Jerry/);
  });

  it('is valid-ish: declares the plist DOCTYPE and balances its tags', () => {
    const plist = buildPlist(base);
    expect(plist).toContain('<!DOCTYPE plist PUBLIC');
    // root dict + the KeepAlive dict; an env dict would make a third.
    expect(plist.match(/<dict>/g)?.length).toBe(2);
    expect(plist.match(/<\/dict>/g)?.length).toBe(2);
    expect(plist.match(/<dict>/g)?.length).toBe(
      buildPlist({ ...base, env: { X: '1' } }).match(/<dict>/g)!.length - 1,
    );
  });
});

describe('currentConfig', () => {
  it('re-execs this same CLI with `run` using absolute node + script', () => {
    const cfg = currentConfig();
    expect(cfg.label).toBe(LAUNCH_AGENT_LABEL);
    expect(cfg.programArguments[0]).toBe(process.execPath);
    expect(cfg.programArguments).toContain('run');
    expect(cfg.programArguments.at(-1)).toBe('run');
  });

  it('marks the agent invocation so startup failures do not loop KeepAlive', () => {
    expect(currentConfig().env.CLEANCOPY_LAUNCHD).toBe('1');
  });

  it('forwards CLEANCOPY_* env vars that are set, and only those', () => {
    const prevState = process.env.CLEANCOPY_STATE_DIR;
    const prevPb = process.env.CLEANCOPY_PASTEBOARD;
    process.env.CLEANCOPY_STATE_DIR = '/tmp/cc-state';
    delete process.env.CLEANCOPY_PASTEBOARD;
    try {
      const cfg = currentConfig();
      expect(cfg.env.CLEANCOPY_STATE_DIR).toBe('/tmp/cc-state');
      expect(cfg.env).not.toHaveProperty('CLEANCOPY_PASTEBOARD');
    } finally {
      if (prevState === undefined) delete process.env.CLEANCOPY_STATE_DIR;
      else process.env.CLEANCOPY_STATE_DIR = prevState;
      if (prevPb !== undefined) process.env.CLEANCOPY_PASTEBOARD = prevPb;
    }
  });
});

describe('plistPath', () => {
  it('lives in ~/Library/LaunchAgents and is named for the label', () => {
    expect(plistPath()).toMatch(/\/Library\/LaunchAgents\/com\.cleancopy\.plist$/);
  });
});
