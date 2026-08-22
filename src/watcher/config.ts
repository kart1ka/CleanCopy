import * as fs from 'fs';
import * as path from 'path';
import { ensureStateDir, stateDir } from './paths';

// User configuration: how the watcher reacts to a terminal copy, and which
// global hotkeys it registers. Lives as JSON next to the pid file and log so
// CLEANCOPY_STATE_DIR relocates all of it together.
//
//   ~/.cleancopy/config.json
//   {
//     "mode": "manual",
//     "hotkeys": { "revert": "cmd+ctrl+z" }
//   }
//
// Manual mode is triggered by the double-copy gesture (copy the same text
// twice in quick succession), detected from the pasteboard alone — so there
// is no clean hotkey, and revert is the only hotkey that exists. A
// "hotkeys.clean" key left over in an old config file is silently unread.
//
// A broken or hand-mangled config must never keep the watcher from starting:
// loadConfig() falls back to defaults field by field and reports what it had
// to ignore, in the same spirit as the engine's golden rule.

export type CleanMode = 'auto' | 'manual';

export interface Hotkeys {
  /** Restores the pre-clean original of the last cleaned copy. */
  revert: string | null;
}

export interface Config {
  /** auto: clean every terminal copy as it lands. manual: only on the hotkey. */
  mode: CleanMode;
  /** Hotkey combos, or null to leave a hotkey unregistered. */
  hotkeys: Hotkeys;
}

export const DEFAULT_CONFIG: Config = {
  mode: 'auto',
  hotkeys: { revert: 'cmd+ctrl+z' },
};

export function configFilePath(): string {
  return path.join(stateDir(), 'config.json');
}

// --- hotkey combos -----------------------------------------------------------

// The Swift helper parses the same grammar (modifiers joined by '+', one key
// last). Everything accepted here must be accepted there; keep the two tables
// in sync (helper/Sources/cleancopy-helper/main.swift).

const MODIFIER_ALIASES: Record<string, string> = {
  cmd: 'cmd',
  command: 'cmd',
  ctrl: 'ctrl',
  control: 'ctrl',
  // Canonical is `opt`: this is a macOS-only tool and Apple's name for the
  // key is Option (⌥) — echoing back `alt` for a user who typed `option`
  // creates the "did it understand me?" moment the aliases exist to prevent.
  // `alt` stays accepted (many non-US keycaps print it, and it is the common
  // cross-platform spelling); the Swift parser accepts all three spellings.
  opt: 'opt',
  option: 'opt',
  alt: 'opt',
  shift: 'shift',
};

/** Canonical modifier order, so equal combos normalize to equal strings. */
const MODIFIER_ORDER = ['cmd', 'ctrl', 'opt', 'shift'] as const;

const NAMED_KEYS = new Set([
  'space', 'tab', 'return', 'escape', 'delete',
  'left', 'right', 'up', 'down',
  'f1', 'f2', 'f3', 'f4', 'f5', 'f6', 'f7', 'f8', 'f9', 'f10', 'f11', 'f12',
]);

function isKeyName(part: string): boolean {
  return /^[a-z0-9]$/.test(part) || NAMED_KEYS.has(part);
}

/**
 * Validate a hotkey combo and return its canonical form (e.g. "shift+CMD+C"
 * becomes "cmd+shift+c"). Throws with a human-readable reason when the combo
 * is not one the helper can register.
 */
export function normalizeHotkey(spec: string): string {
  const parts = spec.toLowerCase().split('+').map((p) => p.trim());
  if (parts.some((p) => p === '')) {
    throw new Error(`invalid hotkey "${spec}": empty part`);
  }
  const modifiers = new Set<string>();
  let key: string | null = null;
  for (const part of parts) {
    const modifier = MODIFIER_ALIASES[part];
    if (modifier) {
      modifiers.add(modifier);
    } else if (!isKeyName(part)) {
      throw new Error(
        `invalid hotkey "${spec}": unknown key "${part}" ` +
          '(use a letter, digit, f1-f12, space, tab, return, escape, delete, or an arrow)',
      );
    } else if (key !== null) {
      throw new Error(`invalid hotkey "${spec}": more than one non-modifier key`);
    } else {
      key = part;
    }
  }
  if (key === null) throw new Error(`invalid hotkey "${spec}": no key, only modifiers`);
  if (modifiers.size === 0) {
    throw new Error(
      `invalid hotkey "${spec}": a global hotkey needs at least one modifier ` +
        '(cmd, ctrl, opt, shift) or it would swallow ordinary typing',
    );
  }
  const ordered = MODIFIER_ORDER.filter((m) => modifiers.has(m));
  return [...ordered, key].join('+');
}

// --- load / save -------------------------------------------------------------

export interface LoadedConfig {
  config: Config;
  /** What loadConfig had to ignore and replace with a default. */
  warnings: string[];
}

function readHotkey(
  value: unknown,
  name: keyof Hotkeys,
  fallback: string | null,
  warnings: string[],
): string | null {
  if (value === undefined) return fallback;
  if (value === null || value === false || value === 'off') return null;
  if (typeof value === 'string') {
    try {
      return normalizeHotkey(value);
    } catch (err) {
      warnings.push(`${(err as Error).message} — hotkeys.${name} disabled`);
      return null;
    }
  }
  warnings.push(`hotkeys.${name} must be a string or null — hotkey disabled`);
  return null;
}

/** Read the config file, falling back to defaults field by field. */
export function loadConfig(): LoadedConfig {
  const warnings: string[] = [];
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(configFilePath(), 'utf8'));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      warnings.push(`could not read ${configFilePath()} (${(err as Error).message}) — using defaults`);
    }
    return { config: structuredClone(DEFAULT_CONFIG), warnings };
  }
  if (typeof raw !== 'object' || raw === null) {
    warnings.push(`${configFilePath()} is not a JSON object — using defaults`);
    return { config: structuredClone(DEFAULT_CONFIG), warnings };
  }

  const record = raw as Record<string, unknown>;
  let mode: CleanMode = DEFAULT_CONFIG.mode;
  if (record.mode !== undefined) {
    if (record.mode === 'auto' || record.mode === 'manual') {
      mode = record.mode;
    } else {
      warnings.push(`mode must be "auto" or "manual" — using "${DEFAULT_CONFIG.mode}"`);
    }
  }

  let hotkeysRecord: Record<string, unknown> = {};
  if (record.hotkeys !== undefined) {
    if (typeof record.hotkeys === 'object' && record.hotkeys !== null) {
      hotkeysRecord = record.hotkeys as Record<string, unknown>;
    } else {
      warnings.push('hotkeys must be an object — using defaults');
    }
  }

  return {
    config: {
      mode,
      hotkeys: {
        revert: readHotkey(hotkeysRecord.revert, 'revert', DEFAULT_CONFIG.hotkeys.revert, warnings),
      },
    },
    warnings,
  };
}

export function saveConfig(config: Config): void {
  ensureStateDir();
  fs.writeFileSync(configFilePath(), JSON.stringify(config, null, 2) + '\n');
}
