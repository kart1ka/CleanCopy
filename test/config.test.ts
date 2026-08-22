import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  configFilePath,
  DEFAULT_CONFIG,
  loadConfig,
  normalizeHotkey,
  saveConfig,
} from '../src/watcher/config';

// The config file is user-edited territory: loadConfig must survive anything
// found there and degrade field by field, never keep the watcher from
// starting, and say what it ignored.

let dir: string;
let previousStateDir: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cleancopy-config-'));
  previousStateDir = process.env.CLEANCOPY_STATE_DIR;
  process.env.CLEANCOPY_STATE_DIR = dir;
});

afterEach(() => {
  if (previousStateDir === undefined) delete process.env.CLEANCOPY_STATE_DIR;
  else process.env.CLEANCOPY_STATE_DIR = previousStateDir;
  rmSync(dir, { recursive: true, force: true });
});

describe('normalizeHotkey', () => {
  it('canonicalizes case, aliases, and modifier order', () => {
    expect(normalizeHotkey('cmd+ctrl+c')).toBe('cmd+ctrl+c');
    expect(normalizeHotkey('Shift+CMD+V')).toBe('cmd+shift+v');
    expect(normalizeHotkey('control+command+z')).toBe('cmd+ctrl+z');
    expect(normalizeHotkey('option+ctrl+f9')).toBe('ctrl+opt+f9');
    expect(normalizeHotkey('opt+cmd+space')).toBe('cmd+opt+space');
    // alt remains an accepted alias, normalized to the macOS name
    expect(normalizeHotkey('alt+cmd+space')).toBe('cmd+opt+space');
  });

  it('accepts letters, digits, f-keys, and the named keys', () => {
    expect(normalizeHotkey('cmd+7')).toBe('cmd+7');
    expect(normalizeHotkey('ctrl+f12')).toBe('ctrl+f12');
    for (const key of ['space', 'tab', 'return', 'escape', 'delete', 'left', 'right', 'up', 'down']) {
      expect(normalizeHotkey(`cmd+${key}`)).toBe(`cmd+${key}`);
    }
  });

  it('rejects a combo without any modifier', () => {
    expect(() => normalizeHotkey('c')).toThrow(/at least one modifier/);
  });

  it('rejects a combo without a key', () => {
    expect(() => normalizeHotkey('cmd+shift')).toThrow(/no key/);
  });

  it('rejects unknown keys and multiple keys', () => {
    expect(() => normalizeHotkey('cmd+meh')).toThrow(/unknown key "meh"/);
    expect(() => normalizeHotkey('cmd+c+v')).toThrow(/more than one/);
    expect(() => normalizeHotkey('cmd++c')).toThrow(/empty part/);
  });
});

describe('loadConfig / saveConfig', () => {
  it('returns the defaults when no config file exists, without a warning', () => {
    expect(loadConfig()).toEqual({ config: DEFAULT_CONFIG, warnings: [] });
  });

  it('round-trips through saveConfig', () => {
    const config = {
      mode: 'manual' as const,
      hotkeys: { clean: 'cmd+shift+9', revert: null },
    };
    saveConfig(config);
    expect(loadConfig()).toEqual({ config, warnings: [] });
  });

  it('fills in missing fields from the defaults', () => {
    writeFileSync(configFilePath(), JSON.stringify({ mode: 'manual' }));
    expect(loadConfig()).toEqual({
      config: { mode: 'manual', hotkeys: DEFAULT_CONFIG.hotkeys },
      warnings: [],
    });
  });

  it('treats "off", null, and false as a disabled hotkey', () => {
    for (const off of ['off', null, false]) {
      writeFileSync(configFilePath(), JSON.stringify({ hotkeys: { revert: off } }));
      const { config, warnings } = loadConfig();
      expect(config.hotkeys.revert).toBeNull();
      expect(config.hotkeys.clean).toBe(DEFAULT_CONFIG.hotkeys.clean);
      expect(warnings).toEqual([]);
    }
  });

  it('normalizes hotkeys found in the file', () => {
    writeFileSync(configFilePath(), JSON.stringify({ hotkeys: { clean: 'Shift+CMD+K' } }));
    expect(loadConfig().config.hotkeys.clean).toBe('cmd+shift+k');
  });

  it('downgrades an invalid mode to the default, with a warning', () => {
    writeFileSync(configFilePath(), JSON.stringify({ mode: 'sometimes' }));
    const { config, warnings } = loadConfig();
    expect(config.mode).toBe('auto');
    expect(warnings.some((w) => w.includes('mode'))).toBe(true);
  });

  it('disables an unparseable hotkey instead of failing, with a warning', () => {
    writeFileSync(configFilePath(), JSON.stringify({ hotkeys: { revert: 'z' } }));
    const { config, warnings } = loadConfig();
    expect(config.hotkeys.revert).toBeNull();
    expect(config.hotkeys.clean).toBe(DEFAULT_CONFIG.hotkeys.clean);
    expect(warnings.some((w) => w.includes('hotkeys.revert'))).toBe(true);
  });

  it('falls back to defaults on malformed JSON, with a warning', () => {
    writeFileSync(configFilePath(), '{ not json');
    const { config, warnings } = loadConfig();
    expect(config).toEqual(DEFAULT_CONFIG);
    expect(warnings).toHaveLength(1);
  });

  it('falls back to defaults when the file is not an object', () => {
    writeFileSync(configFilePath(), '"auto"');
    const { config, warnings } = loadConfig();
    expect(config).toEqual(DEFAULT_CONFIG);
    expect(warnings).toHaveLength(1);
  });
});
