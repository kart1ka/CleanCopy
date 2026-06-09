import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { clean } from '../src/engine';

// Fixture-driven golden tests. Each directory under test/fixtures/ holds an
// input.txt and the expected.txt it should clean to. This corpus IS the
// product's quality bar — grow it with every real-world example, especially
// any case where code/logs/tables were wrongly treated as prose.

const fixturesDir = join(__dirname, 'fixtures');

const cases = readdirSync(fixturesDir, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .sort();

function read(name: string, file: string): string {
  return readFileSync(join(fixturesDir, name, file), 'utf8');
}

/** Fixture files carry a trailing newline from the editor; clean() does not. */
function stripFinalNewline(s: string): string {
  return s.replace(/\n$/, '');
}

describe('cleanup engine — fixtures', () => {
  for (const name of cases) {
    it(name, () => {
      expect(clean(read(name, 'input.txt'))).toBe(stripFinalNewline(read(name, 'expected.txt')));
    });
  }
});

describe('cleanup engine — properties', () => {
  for (const name of cases) {
    it(`${name}: cleaning twice changes nothing the second time`, () => {
      const once = clean(read(name, 'input.txt'));
      expect(clean(once)).toBe(once);
    });
  }

  it('empty input stays empty', () => {
    expect(clean('')).toBe('');
  });
});
