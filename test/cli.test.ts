import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  findUnknownArg,
  nodeTooOldMessage,
  packageVersion,
  parseAutostartArgs,
  parseStopArgs,
} from '../src/cli';

describe('CLI metadata', () => {
  it('--version is sourced from package.json', () => {
    const packageJson = JSON.parse(
      readFileSync(join(__dirname, '..', 'package.json'), 'utf8'),
    ) as { version: string };
    expect(packageVersion()).toBe(packageJson.version);
  });

  it('names the Node floor instead of dying on a missing modern global', () => {
    // Under Node 16 the first thing reached used to be structuredClone
    // inside config loading, so the version complaint never printed.
    expect(nodeTooOldMessage('16.20.2', 22)).toContain('requires Node.js 22 or later');
    expect(nodeTooOldMessage('16.20.2', 22)).toContain('v16.20.2');
    expect(nodeTooOldMessage('20.18.1', 22)).not.toBeNull();
    expect(nodeTooOldMessage('22.11.0', 22)).toBeNull();
    expect(nodeTooOldMessage('23.3.0', 22)).toBeNull();
  });

  it('rejects arguments a subcommand does not recognize', () => {
    // A typo'd flag must fail loudly, not silently do less than asked:
    // `clean --explian` cleaning without an explanation looks like the
    // flag does nothing.
    expect(findUnknownArg(['--explian'], ['--explain'])).toBe('--explian');
    expect(findUnknownArg(['--explain'], ['--explain'])).toBeUndefined();
    expect(findUnknownArg([])).toBeUndefined();
    expect(findUnknownArg(['now'])).toBe('now');
  });

  it('keeps plain stop temporary and makes disabling autostart explicit', () => {
    expect(parseStopArgs([])).toEqual({ disableAutostart: false });
    expect(parseStopArgs(['--disable-autostart'])).toEqual({ disableAutostart: true });
    expect(() => parseStopArgs(['--forever'])).toThrow('Unknown stop option: --forever');
  });

  it('names login autostart for what it does: on, off, or show the state', () => {
    // `cleancopy install` read as "install what?" one line after
    // `npm install` (F22).
    expect(parseAutostartArgs([])).toBe('show');
    expect(parseAutostartArgs(['on'])).toBe('on');
    expect(parseAutostartArgs(['off'])).toBe('off');
    expect(() => parseAutostartArgs(['enable'])).toThrow('Unknown autostart option: enable');
    expect(() => parseAutostartArgs(['on', '--now'])).toThrow('Unknown autostart option: --now');
  });
});
