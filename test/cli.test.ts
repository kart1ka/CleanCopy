import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { packageVersion, parseStopArgs } from '../src/cli';

describe('CLI metadata', () => {
  it('--version is sourced from package.json', () => {
    const packageJson = JSON.parse(
      readFileSync(join(__dirname, '..', 'package.json'), 'utf8'),
    ) as { version: string };
    expect(packageVersion()).toBe(packageJson.version);
  });

  it('keeps plain stop temporary and makes disabling autostart explicit', () => {
    expect(parseStopArgs([])).toEqual({ disableAutostart: false });
    expect(parseStopArgs(['--disable-autostart'])).toEqual({ disableAutostart: true });
    expect(() => parseStopArgs(['--forever'])).toThrow('Unknown stop option: --forever');
  });
});
