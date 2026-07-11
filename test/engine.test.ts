import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { clean, inferWrapWidth, stripCommonMargin } from '../src/engine';

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

  it('keeps the indent of an isolated nested-list fragment', () => {
    expect(clean('  - child item one\n  - child item two')).toBe(
      '  - child item one\n  - child item two',
    );
  });

  it('survives a block of 200k lines (spread-into-Math.max overflows the stack)', () => {
    const huge = Array.from({ length: 200_000 }, () => 'aa').join('\n');
    expect(() => clean(huge)).not.toThrow();
  });
});

describe('stripCommonMargin — literal prefix, never a character count', () => {
  it('strips a shared space margin', () => {
    expect(stripCommonMargin('  a\n  b')).toBe('a\nb');
  });

  it('strips a shared tab margin', () => {
    expect(stripCommonMargin('\ta\n\tb')).toBe('a\nb');
  });

  it('keeps relative indentation beyond the margin', () => {
    expect(stripCommonMargin('  a\n    b')).toBe('a\n  b');
  });

  it('strips nothing when one line is tab-indented and another space-indented', () => {
    const makefile = '    build:\n\tgo build ./...';
    expect(stripCommonMargin(makefile)).toBe(makefile);
  });

  it('keeps a tab that sits beyond a shared space margin (Makefile recipe)', () => {
    expect(stripCommonMargin('  build:\n  \tgo build ./...')).toBe('build:\n\tgo build ./...');
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
