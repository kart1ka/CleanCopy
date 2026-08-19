import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { findUnknownArg, packageVersion, parseStopArgs } from '../src/cli';

describe('CLI metadata', () => {
  it('--version is sourced from package.json', () => {
    const packageJson = JSON.parse(
      readFileSync(join(__dirname, '..', 'package.json'), 'utf8'),
    ) as { version: string };
    expect(packageVersion()).toBe(packageJson.version);
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
});
