import { LIST_ITEM } from './classify';

// Step 1 of the pipeline: the always-safe tidy-ups.
//
// These run on EVERY copy, no judgement required, and never change the meaning
// of code, tables, or anything else. They only remove junk that is never wanted.
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
const ANSI = new RegExp(
  '\\u001B(?:' +
    '\\[[0-9;?]*[ -\\/]*[@-~]' + // CSI
    '|\\][^\\u0007\\u001B\\n]*(?:\\u0007|\\u001B\\\\)?' + // OSC
    '|[ -\\/]*[0-~]' + // short escape sequences
    ')',
  'g',
);

export function normalize(input: string): string {
  let text = input;

  // 1. One kind of line ending.
  text = text.replace(/\r\n?/g, '\n');

  // 2. Strip terminal colour / formatting codes if any slipped through.
  text = text.replace(ANSI, '');

  // 3. Remove invisible characters; turn odd spaces into plain spaces.
  text = text.replace(ZERO_WIDTH, '');
  text = text.replace(EXOTIC_SPACES, ' ');

  // 4. Trim whitespace hanging off the end of each line.
  text = text
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/, ''))
    .join('\n');

  // 5. Slide everything back to the left edge: remove the indentation that
  //    EVERY non-blank line shares (the terminal / Claude render margin).
  text = stripRenderMargin(text);

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
  if (isIndentedListFragment(text)) return text;
  const stripped = stripCommonMargin(text);
  return stripped !== text ? stripped : stripTornFirstLineMargin(text);
}

/**
 * The drag-select case stripCommonMargin cannot see: selecting from the first
 * *character* of the text leaves line 1 without its render margin (the drag
 * started inside it) while every wrapped line below keeps it. One flush-left
 * line empties the common prefix, so nothing was stripped and the paste came
 * out lopsided — paragraph 1 flush, everything after it indented.
 *
 * Strip the margin the rest of the lines share when the flush first line is
 * demonstrably torn, not structural:
 *   - it is the ONLY flush-left line (all others share a non-empty margin);
 *   - it runs straight into the next line with no blank between — a heading
 *     or label above an indented example sits in its own block and is left
 *     alone;
 *   - the text spans 2+ blank-separated blocks, so a lone `def foo():` with
 *     its indented body cannot be flattened.
 * Idempotent: the output has 2+ flush-left lines, so a second pass strips
 * nothing — which keeps clean(clean(x)) === clean(x).
 */
function stripTornFirstLineMargin(text: string): string {
  const lines = text.split('\n');
  const nonBlank: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() !== '') nonBlank.push(i);
  }
  if (nonBlank.length < 3) return text;

  const first = nonBlank[0];
  if (/^[ \t]/.test(lines[first])) return text; // first line is not flush
  if (lines[first + 1]?.trim() === '') return text; // first line is its own block

  // 2+ blocks: some blank line between the first and last non-blank lines.
  const last = nonBlank[nonBlank.length - 1];
  let hasBlockBreak = false;
  for (let i = first + 1; i < last; i++) {
    if (lines[i].trim() === '') hasBlockBreak = true;
  }
  if (!hasBlockBreak) return text;

  // Common literal margin of every non-blank line after the first.
  let margin: string | null = null;
  for (const i of nonBlank.slice(1)) {
    const indent = lines[i].match(/^[ \t]*/)?.[0] ?? '';
    if (margin === null) {
      margin = indent;
    } else {
      let j = 0;
      while (j < margin.length && j < indent.length && margin[j] === indent[j]) j++;
      margin = margin.slice(0, j);
    }
    if (margin === '') return text; // another flush line ⇒ not the torn case
  }
  if (!margin) return text;

  const width = margin.length;
  return lines
    .map((line, i) => (i === first || line.trim() === '' ? line : line.slice(width)))
    .join('\n');
}

function isIndentedListFragment(text: string): boolean {
  const lines = text.split('\n').filter((line) => line.trim() !== '');
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
  const lines = text.split('\n');

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
  return lines.map((line) => (line.trim() === '' ? line : line.slice(width))).join('\n');
}
