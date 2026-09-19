import { LIST_ITEM } from './classify';
import { resolveRules, type Rules } from './rules';

// Configured normalization runs before content classification.
//
// The regexes are built from \u escape strings (pure ASCII) on purpose: writing
// the invisible characters literally into the source is fragile and easy to
// corrupt.

// Zero-width / invisible characters: ZWSP, word-joiner, BOM. ZWNJ (‌) and
// ZWJ (‍) are deliberately NOT here: they look like junk but carry
// meaning — ZWJ composes emoji ("👩‍💻" is woman + ZWJ + laptop) and ZWNJ is the
// half-space that Persian/Farsi spelling requires. Stripping them corrupts the
// user's text.
const ZERO_WIDTH = new RegExp('[\\u200B\\u2060\\uFEFF]', 'g');
// Unusual space characters: NBSP, Ogham space, en/em spaces, narrow & medium
// NBSP, ideographic space.
const EXOTIC_SPACES = new RegExp('[\\u00A0\\u1680\\u2000-\\u200A\\u202F\\u205F\\u3000]', 'g');
// Terminal escape sequences (usually stripped on copy, but just in case).
// Three shapes: CSI (colours/formatting, ESC [ … final), OSC (hyperlinks and
// window titles, ESC ] … terminated by BEL or ESC \ — or by end of *line* when
// truncated: an OSC payload never legally contains a newline, and letting the
// match cross one would mean a stray unterminated ESC ] silently deletes the
// entire rest of the copy), and the remaining short escapes (ESC = keypad
// mode, ESC 7 save cursor, …: optional intermediates then one final byte).
// The unterminated-OSC form additionally requires an OSC-shaped payload
// (leading digit or ';'): without that, a stray "ESC ]" manufactured by
// stripping a doubled escape would swallow the visible rest of the line on a
// second pass. A bare ESC that fits no form is stripped alone (last branch),
// so stripping can never leave an ESC behind to combine with following text —
// which is what keeps this step idempotent.
const ANSI = new RegExp(
  '\\u001B(?:' +
    '\\[[0-9;?]*[ -\\/]*[@-~]' + // CSI
    '|\\][0-9;][^\\u0007\\u001B\\r\\n]*(?:\\u0007|\\u001B\\\\)?' + // OSC
    '|\\][^\\u0007\\u001B\\r\\n]*(?:\\u0007|\\u001B\\\\)' + // OSC, terminated
    '|[ -\\/]*[0-~]' + // short escape sequences
    '|' + // bare ESC that fits no sequence
    ')',
  'g',
);

/** Map line contents without changing their original separators. */
function mapLines(text: string, map: (line: string) => string): string {
  return text.replace(/[^\r\n]+/g, map);
}

export function normalize(input: string, rules: Rules = resolveRules()): string {
  let text = input;
  if (rules.normalizeLineEndings) text = text.replace(/\r\n?/g, '\n');
  if (rules.stripAnsi) text = text.replace(ANSI, '');
  if (rules.removeInvisibleCharacters) text = text.replace(ZERO_WIDTH, '');
  if (rules.normalizeSpaces) text = text.replace(EXOTIC_SPACES, ' ');
  if (rules.trimTrailingWhitespace) {
    text = mapLines(text, (line) => line.replace(/[ \t]+$/, ''));
  }
  if (rules.removeSharedMargin) text = stripRenderMargin(text);
  return text;
}

/**
 * The margin-strip normalize applies, reusable on clean()'s stitched output:
 * remove the indentation every non-blank line shares — unless the text is an
 * indented list fragment, whose margin may be the list's nesting level and is
 * preserved rather than flattened. Running the SAME guarded strip on the
 * output makes it a fixed point of normalize, which is what keeps
 * clean(clean(x)) === clean(x) when a join absorbs the only flush-left line.
 */
export function stripRenderMargin(text: string): string {
  return isIndentedListFragment(text) ? text : stripCommonMargin(text);
}

function isIndentedListFragment(text: string): boolean {
  const lines = text.split(/\r\n|\r|\n/).filter((line) => line.trim() !== '');
  if (lines.length === 0 || !LIST_ITEM.test(lines[0])) return false;

  const firstIndent = lines[0].match(/^[ \t]*/)?.[0] ?? '';
  if (firstIndent === '') return false;
  const continuationIndent = firstIndent.length + 2;

  // A wrapped list item continues at an indent, while sibling items carry a
  // marker. Anything else means this is not safely recognizable as one list.
  return lines.every((line) => {
    if (LIST_ITEM.test(line)) return true;
    const indent = line.match(/^[ \t]*/)?.[0] ?? '';
    return indent.length >= continuationIndent && /\S/.test(line);
  });
}

/**
 * Remove the leading whitespace shared by all non-blank lines. The margin is
 * the longest common *literal* prefix, not a character count: counting would
 * treat a tab and a space as interchangeable and slice different whitespace
 * off different lines — turning a Makefile's required recipe tab into nothing
 * and breaking relative indentation. Mixed margins (one line tab-indented,
 * another space-indented) share no prefix, so nothing is stripped.
 */
export function stripCommonMargin(text: string): string {
  const lines = text.split(/\r\n|\r|\n/);

  let margin: string | null = null;
  for (const line of lines) {
    if (line.trim() === '') continue; // blank lines don't count
    const indent = line.match(/^[ \t]*/)?.[0] ?? '';
    if (margin === null) {
      margin = indent;
    } else {
      let i = 0;
      while (i < margin.length && i < indent.length && margin[i] === indent[i]) i++;
      margin = margin.slice(0, i);
    }
    if (margin === '') return text;
  }

  if (!margin) return text;
  const width = margin.length;
  return mapLines(text, (line) => line.trim() === '' ? line : line.slice(width));
}
