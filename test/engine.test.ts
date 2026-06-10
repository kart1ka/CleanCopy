import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { clean, inferWrapWidth } from '../src/engine';

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

  it('survives a block of 200k lines (spread-into-Math.max overflows the stack)', () => {
    const huge = Array.from({ length: 200_000 }, () => 'aa').join('\n');
    expect(() => clean(huge)).not.toThrow();
  });
});

describe('inferWrapWidth — boundaries', () => {
  const line = (n: number) => 'x'.repeat(n);

  it('needs at least three lines hugging the column', () => {
    expect(inferWrapWidth([line(78), line(75)].join('\n'))).toBeUndefined();
    expect(inferWrapWidth([line(78), line(75), line(70)].join('\n'))).toBe(78);
  });

  it('never establishes a column narrower than a plausible terminal', () => {
    expect(inferWrapWidth([line(39), line(38), line(37)].join('\n'))).toBeUndefined();
    expect(inferWrapWidth([line(40), line(39), line(38)].join('\n'))).toBe(40);
  });
});
