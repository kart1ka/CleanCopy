import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { clean, cleanWithReport, resolveRules, RULE_IDS, type RuleId } from '../src/engine';

const off = resolveRules(Object.fromEntries(RULE_IDS.map((id) => [id, false])));
const paragraph = 'The quick brown fox jumped clear over\nthe lazy dog down by the river';
const joinedParagraph = 'The quick brown fox jumped clear over the lazy dog down by the river';

const isolated: Array<{ rule: RuleId; input: string; expected: string }> = [
  { rule: 'normalizeLineEndings', input: ' a\r\n b\rc\n', expected: ' a\n b\nc\n' },
  { rule: 'stripAnsi', input: '\x1b[31mred\x1b[0m  \r\n', expected: 'red  \r\n' },
  { rule: 'removeInvisibleCharacters', input: 'a\u200b\u2060\ufeffb\u200d\u200c', expected: 'ab\u200d\u200c' },
  { rule: 'normalizeSpaces', input: 'a\u00a0b\u2003c', expected: 'a b c' },
  { rule: 'trimTrailingWhitespace', input: 'a  \r\nb\t \r\n \t\n', expected: 'a\r\nb\r\n\n' },
  { rule: 'removeSharedMargin', input: '  a\r\n    b', expected: 'a\r\n  b' },
  { rule: 'reflowProse', input: paragraph, expected: joinedParagraph },
  {
    rule: 'reflowLists',
    input: '- first item text that wraps and\r\n  continues onto a second line here\n- second item stays put',
    expected: '- first item text that wraps and continues onto a second line here\n- second item stays put',
  },
  {
    rule: 'collapseProseSpaces',
    input: 'The quick  brown fox jumped clear over\nthe lazy dog down by the river  ',
    expected: 'The quick brown fox jumped clear over\nthe lazy dog down by the river  ',
  },
  { rule: 'trimOuterBlankLines', input: '\r\n \r\na\r\n \n\r\n', expected: 'a\r\n' },
];

describe('independent formatting rules', () => {
  it.each([
    ['foo\n   ', 'foo\n'],
    ['a\r\n\n', 'a\r\n'],
    ['a\n\r\n', 'a\n'],
    ['a\r \t', 'a\r'],
  ])('retains the last content line ending when trimming outer blanks: %j', (input, expected) => {
    const rules = { trimTrailingWhitespace: false, normalizeLineEndings: false };
    expect(clean(input, { rules })).toBe(expected);
    expect(clean(expected, { rules })).toBe(expected);
    expect(clean(input, { rules: { ...rules, trimOuterBlankLines: false } })).toBe(input);
  });

  for (const { rule, input, expected } of isolated) {
    it(`${rule} changes only its own formatting`, () => {
      expect(clean(input, { rules: off })).toBe(input);
      expect(clean(input, { rules: { ...off, [rule]: true } })).toBe(expected);
    });
  }

  it('has an isolation example for every configurable operation', () => {
    expect(isolated.map(({ rule }) => rule).sort()).toEqual([...RULE_IDS].sort());
  });

  it('preserves arbitrary separators and whitespace when every rule is disabled', () => {
    const input = '\r\n \t\r\n\x1b[31m  const x = "\u00a0\u200b"; \r\n \t\r\n  const y = 2;\r \t';
    expect(clean(input, { rules: off })).toBe(input);
    expect(clean('\r\n \t\r \n', { rules: off })).toBe('\r\n \t\r \n');
  });

  it('preserves surviving mixed line endings and trailing spaces during reflow', () => {
    const input = 'The quick brown fox jumped clear over  \r\n   the lazy dog down by the river  \r\n \t\nconst x = 1; \r';
    expect(clean(input, { rules: { ...off, reflowProse: true } })).toBe(
      joinedParagraph + '  \r\n \t\nconst x = 1; \r',
    );
  });

  it('keeps continuation indentation when reflow is disabled, but joins without it when enabled', () => {
    const input = '  The quick brown fox jumped clear over\n    the lazy dog down by the river';
    expect(clean(input, { rules: { ...off, reflowProse: true } })).toBe('  ' + joinedParagraph);
    expect(clean(input, { rules: { ...off, removeSharedMargin: true } })).toBe(
      'The quick brown fox jumped clear over\n  the lazy dog down by the river',
    );
  });

  it('removes a list-local margin with list reflow off', () => {
    const input = 'An introductory sentence.\n\n  - first item text that wraps and\n    continues onto a second line here\n  - second item stays put';
    expect(clean(input, { rules: { ...off, removeSharedMargin: true } })).toBe(
      'An introductory sentence.\n\n- first item text that wraps and\n  continues onto a second line here\n- second item stays put',
    );
  });

  it('never strips a list-local margin when margin removal is disabled', () => {
    const input = 'An introductory sentence.\n\n  - first item text that wraps and\n    continues onto a second line here\n  - second item stays put';
    expect(clean(input, { rules: { ...off, reflowLists: true } })).toBe(
      'An introductory sentence.\n\n  - first item text that wraps and continues onto a second line here\n  - second item stays put',
    );
  });

  it('keeps prose spacing when space cleanup is disabled but wrap repair is enabled', () => {
    expect(clean('The quick  brown fox jumped clear over\nthe lazy dog down by the river', {
      rules: { collapseProseSpaces: false },
    })).toBe('The quick  brown fox jumped clear over the lazy dog down by the river');
  });

  it('does not remove a truncated OSC payload across a retained CR separator', () => {
    expect(clean('before \x1b]8;;file:///tmp\rafter', { rules: { ...off, stripAnsi: true } })).toBe('before \rafter');
  });

  it('reports resolved rules without changing content classification', () => {
    const result = cleanWithReport(paragraph, { explain: true, rules: { reflowProse: false } });
    expect(result.text).toBe(paragraph);
    expect(result.rules.reflowProse).toBe(false);
    expect(result.reports[0].classification.type).toBe('prose');
    expect(result.reports[0].joins).toEqual([]);
  });

  it('keeps code, tables, logs, and transcripts protected when reflow is enabled', () => {
    for (const input of [
      '  const x = 1;  \r\n  const y = 2;  \r\n',
      '| name | value |\n| first | second |',
      'ERROR failed to connect to the remote server\nWARN retrying the connection in five seconds',
      'user@host:path$ first\nSome output that reads like a paragraph and\ncontinues across the next line here\nuser@host:path$ second',
    ]) {
      expect(clean(input, { rules: { ...off, reflowProse: true, reflowLists: true, collapseProseSpaces: true } })).toBe(input);
    }
  });
});

const fixtures = join(__dirname, 'fixtures');
const combinations = Array.from({ length: 2 ** RULE_IDS.length }, (_, mask) => resolveRules(
  Object.fromEntries(RULE_IDS.map((id, bit) => [id, Boolean(mask & (1 << bit))])),
));

describe('configured fixture invariants', () => {
  for (const name of readdirSync(fixtures)) {
    it(`${name}: defaults, identity, and stability for every rule combination`, () => {
      const input = readFileSync(join(fixtures, name, 'input.txt'), 'utf8');
      const expected = readFileSync(join(fixtures, name, 'expected.txt'), 'utf8');
      expect(clean(input)).toBe(expected);
      expect(clean(input, { rules: off })).toBe(input);
      for (const rules of combinations) {
        const once = clean(input, { rules });
        expect(clean(once, { rules }), JSON.stringify(rules)).toBe(once);
      }
    });
  }
});
