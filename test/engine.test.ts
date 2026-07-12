import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  clean,
  cleanWithReport,
  inferWrapWidth,
  REFLOW_THRESHOLD,
  stripCommonMargin,
} from '../src/engine';

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

describe('cleanup engine — fixtures', () => {
  // Byte-for-byte: input.txt and expected.txt both end with a newline, and
  // clean() preserves the input's trailing-newline state.
  for (const name of cases) {
    it(name, () => {
      expect(clean(read(name, 'input.txt'))).toBe(read(name, 'expected.txt'));
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
    expect(clean('\n\n')).toBe('');
  });

  it('preserves the presence and absence of a final newline', () => {
    expect(clean('word another word\n')).toBe('word another word\n');
    expect(clean('word another word')).toBe('word another word');
    expect(clean('word another word\n\n\n')).toBe('word another word\n');
  });

  it('keeps the indent of an isolated nested-list fragment', () => {
    expect(clean('  - child item one\n  - child item two')).toBe(
      '  - child item one\n  - child item two',
    );
  });

  it('keeps the indent of a deliberately kept line inside a prose block', () => {
    const quote = 'It has been a while.\n        Herman Melville';
    expect(clean(quote)).toBe(quote);
  });

  it('still drops the indent of a line it glues into the sentence', () => {
    expect(clean('The quick brown fox jumped over\n    the lazy dog by the river')).toBe(
      'The quick brown fox jumped over the lazy dog by the river',
    );
  });

  it('survives a block of 200k lines (spread-into-Math.max overflows the stack)', () => {
    const huge = Array.from({ length: 200_000 }, () => 'aa').join('\n');
    expect(() => clean(huge)).not.toThrow();
  });
});

describe('list markers are recognized consistently across the pipeline', () => {
  // normalize (keep an indented fragment's margin), classify (call it a
  // list), and transform (find item starts) share one LIST_ITEM regex; every
  // marker must behave identically in all three or sibling items get glued.
  const markers = ['- ', '* ', '+ ', '• ', '1. ', '1) '];
  for (const marker of markers) {
    it(`keeps "${marker.trim()}" items apart and joins their wrapped lines`, () => {
      const wrapped = `${marker}first item text that\ncontinues on a second line\n${marker}second item stays put`;
      expect(clean(wrapped)).toBe(
        `${marker}first item text that continues on a second line\n${marker}second item stays put`,
      );
    });

    it(`keeps the margin of an isolated indented "${marker.trim()}" fragment`, () => {
      const fragment = `  ${marker}alpha item\n  ${marker}beta item`;
      expect(clean(fragment)).toBe(fragment);
    });
  }
});

describe('single-line blocks are below the reflow threshold', () => {
  // One line has no wrap to repair; reflow could only collapse its internal
  // spacing, and a lone line can't prove that spacing isn't alignment.
  it('leaves a copied single table row intact', () => {
    const row = 'NAME    READY   UP-TO-DATE   AVAILABLE';
    expect(clean(row)).toBe(row);
  });

  it('leaves a single prose line with doubled spaces intact', () => {
    const line = 'One sentence.  Another sentence after wide spacing.';
    expect(clean(line)).toBe(line);
  });

  it('scores single-line prose below REFLOW_THRESHOLD', () => {
    const { reports } = cleanWithReport('just a few plain words');
    expect(reports).toHaveLength(1);
    expect(reports[0].classification.type).toBe('prose');
    expect(reports[0].classification.confidence).toBeLessThan(REFLOW_THRESHOLD);
  });
});

describe('trace keywords freeze blocks only in log-line position', () => {
  it('leaves bracketed log-level lines verbatim', () => {
    const log = '[ERROR] connection refused\n[WARN] retrying in 5s';
    expect(clean(log)).toBe(log);
  });

  it('leaves line-leading log levels verbatim', () => {
    const log = 'ERROR connection refused after three attempts and\nWARN retrying in five seconds';
    expect(clean(log)).toBe(log);
  });

  it('leaves timestamp-prefixed log levels verbatim', () => {
    const log = '12:00:01 ERROR could not reach the host on the\n12:00:02 TRACE giving up until the next retry';
    expect(clean(log)).toBe(log);
  });

  it('leaves exception headers verbatim', () => {
    const log = 'java.lang.NullPointerException: boom went the\nservice before it could finish the request';
    expect(clean(log)).toBe(log);
    const thread = 'Exception in thread "main" something quite long\nhappened before the stack frames were printed';
    expect(clean(thread)).toBe(thread);
  });

  it('reflows prose that merely mentions a log level mid-sentence', () => {
    expect(
      clean('When the build breaks you will find a WARNING in the\noutput and a summary right at the very end of it.'),
    ).toBe(
      'When the build breaks you will find a WARNING in the output and a summary right at the very end of it.',
    );
  });
});

describe('terminal escape sequences are stripped', () => {
  const ESC = '\u001B';
  const BEL = '\u0007';

  it('strips CSI colour codes', () => {
    expect(clean(`${ESC}[31merror text${ESC}[0m and more words here`)).toBe(
      'error text and more words here',
    );
  });

  it('strips OSC 8 hyperlinks (ls --hyperlink, iTerm2 shell integration)', () => {
    expect(clean(`${ESC}]8;;file:///tmp/a.txt${BEL}a.txt${ESC}]8;;${BEL}`)).toBe('a.txt');
  });

  it('strips ST-terminated OSC sequences (window title)', () => {
    expect(clean(`${ESC}]0;my window title${ESC}\\prompt $`)).toBe('prompt $');
  });

  it('strips an OSC sequence truncated by the end of the copy', () => {
    expect(clean(`before ${ESC}]8;;file:///tmp`)).toBe('before');
  });

  it('strips short escapes like keypad mode and save/restore cursor', () => {
    expect(clean(`${ESC}=text${ESC}7 more${ESC}8`)).toBe('text more');
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
