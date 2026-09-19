import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RULE_IDS } from '../src/engine';

const cli = join(__dirname, '..', 'src', 'cli', 'index.ts');
let dir: string;
const paragraph = '  The quick brown fox jumped clear over\n  the lazy dog down by the river';

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'cleancopy-rule-cli-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function run(args: string[], input = '') {
  return spawnSync(process.execPath, ['--require', 'tsx/cjs', cli, ...args], {
    input, encoding: 'utf8', timeout: 5000,
    env: { ...process.env, CLEANCOPY_STATE_DIR: dir },
  });
}

describe('formatting configuration through the CLI', () => {
  it('lists every rule and persists a complete config when changing one', () => {
    const result = run(['config', 'rule', 'removeSharedMargin', 'off']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('removeSharedMargin: off');
    const saved = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8'));
    expect(Object.keys(saved.rules).sort()).toEqual([...RULE_IDS].sort());
    expect(saved.rules.removeSharedMargin).toBe(false);
    expect(saved.rules.reflowProse).toBe(true);
    const listing = run(['config', 'rules']);
    expect(listing.status).toBe(0);
    for (const rule of RULE_IDS) expect(listing.stdout).toContain(`${rule}: `);
    expect(listing.stdout).toContain('protections always apply');
    expect(run(['clean'], '  word  \r\n').stdout).toBe('  word\n');
  });

  it('turns all formatting off and back on', () => {
    expect(run(['config', 'rules', 'off']).status).toBe(0);
    const input = '\r\n \t\r\n\x1b[31m  word\u00a0\u200b  \r\n \t';
    const raw = run(['clean'], input);
    expect(raw.status).toBe(0);
    expect(raw.stdout).toBe(input);
    expect(run(['config', 'rules', 'on']).status).toBe(0);
    const cleaned = run(['clean'], '  word  \r\n');
    expect(cleaned.status).toBe(0);
    expect(cleaned.stdout).toBe('word\n');
  });

  it('applies one-off overrides after saved settings without changing the file', () => {
    expect(run(['config', 'rule', 'reflowProse', 'off']).status).toBe(0);
    const saved = readFileSync(join(dir, 'config.json'), 'utf8');
    expect(run(['clean'], paragraph).stdout).toBe(paragraph.replace(/^  /gm, ''));
    const override = run(['clean', '--enable-rule', 'reflowProse', '--disable-rule', 'removeSharedMargin'], paragraph);
    expect(override.status).toBe(0);
    expect(override.stdout).toBe('  The quick brown fox jumped clear over the lazy dog down by the river');
    expect(readFileSync(join(dir, 'config.json'), 'utf8')).toBe(saved);
  });

  it('uses defaults with --no-config, then applies explicit overrides', () => {
    writeFileSync(join(dir, 'config.json'), 'broken json');
    const result = run(['clean', '--no-config', '--disable-rule', 'reflowProse'], paragraph);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(paragraph.replace(/^  /gm, ''));
    expect(result.stderr).toBe('');
  });

  it('keeps config warnings and explanations out of formatted stdout', () => {
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ rules: { typo: false, reflowProse: false } }));
    const result = run(['clean', '--explain'], paragraph);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(paragraph.replace(/^  /gm, ''));
    expect(result.stderr).toContain('unknown rule rules.typo');
    expect(result.stderr).toContain('reflowProse=off');
    expect(result.stderr).toContain('[prose] reflow=false');
  });

  it('reports usage for missing rule arguments without writing settings', () => {
    for (const args of [['config', 'rule'], ['config', 'rule', 'reflowProse']]) {
      const result = run(args);
      expect(result.status).toBe(1);
      expect(result.stderr.split('\n')[0]).toBe('expected rule <name> on|off, or rules on|off');
      expect(result.stdout).toBe('');
      expect(existsSync(join(dir, 'config.json'))).toBe(false);
    }
  });

  it('rejects bad setters and overrides without changing settings or producing text', () => {
    writeFileSync(join(dir, 'config.json'), '{}\n');
    for (const args of [
      ['config', 'rule', 'typo', 'off'],
      ['config', 'rule', 'toString', 'off'],
      ['config', 'rule', 'reflowProse', 'false'],
      ['config', 'rule', 'reflowProse', 'off', 'extra'],
      ['config', 'rules', 'off', 'extra'],
      ['clean', '--disable-rule'],
      ['clean', '--disable-rule', 'protectCode'],
      ['clean', '--disable-rule', 'reflowProse', '--enable-rule', 'reflowProse'],
    ]) {
      const result = run(args, paragraph);
      expect(result.status, args.join(' ')).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr.length).toBeGreaterThan(0);
      expect(readFileSync(join(dir, 'config.json'), 'utf8')).toBe('{}\n');
    }
  });

  it.each(['auto', 'manual'])('passes saved rules through daemon startup in %s mode', async (mode) => {
    writeFileSync(join(dir, 'config.json'), JSON.stringify({
      mode, hotkeys: { revert: null }, rules: { reflowProse: false, normalizeLineEndings: false },
    }));
    const helper = join(dir, 'helper.js');
    const received = join(dir, 'received.jsonl');
    const input = paragraph.replace(/\n/g, '\r\n');
    writeFileSync(helper, `#!/usr/bin/env node
const fs = require('fs');
const event = { type: 'clipboard', bundleId: 'com.googlecode.iterm2', appName: 'iTerm2', text: ${JSON.stringify(input)}, changeCount: 1 };
console.log(JSON.stringify({ type: 'ready' }));
console.log(JSON.stringify(event));
${mode === 'manual' ? "setTimeout(() => console.log(JSON.stringify({ ...event, changeCount: 2 })), 250);" : ''}
process.stdin.on('data', data => fs.appendFileSync(${JSON.stringify(received)}, data));
process.stdin.on('end', () => process.exit(0));
`);
    chmodSync(helper, 0o755);
    const child = spawn(process.execPath, ['--require', 'tsx/cjs', cli, 'run'], {
      env: { ...process.env, CLEANCOPY_STATE_DIR: dir, CLEANCOPY_HELPER: helper, CLEANCOPY_LAUNCHD: '' },
      stdio: 'pipe',
    });
    let logs = '';
    child.stdout.on('data', (data) => { logs += data; });
    child.stderr.on('data', (data) => { logs += data; });
    const exited = new Promise((resolve) => child.on('exit', resolve));
    try {
      await expect.poll(() => existsSync(received) ? readFileSync(received, 'utf8').trim() : '', {
        timeout: 3500,
      }).toContain('"type":"write"');
      const messages = readFileSync(received, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      expect(messages, logs).toEqual([{
        type: 'write', text: 'The quick brown fox jumped clear over\r\nthe lazy dog down by the river',
        expectedChangeCount: mode === 'manual' ? 2 : 1,
      }]);
      const pipe = run(['clean'], input);
      expect(pipe.status).toBe(0);
      expect(pipe.stdout).toBe('The quick brown fox jumped clear over\r\nthe lazy dog down by the river');
    } finally {
      child.kill('SIGTERM');
      await exited;
    }
  });
});
