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
// ANSI colour / formatting escape sequences (usually stripped on copy, but just in case).
const ANSI = new RegExp('\\u001B\\[[0-9;?]*[ -\\/]*[@-~]', 'g');

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
  //    EVERY non-blank line shares (the terminal / Claude render margin). This
  //    is safe even for code — the block just shifts left, its inner shape kept.
  text = stripCommonMargin(text);

  return text;
}

/** Remove the largest run of leading whitespace common to all non-blank lines. */
export function stripCommonMargin(text: string): string {
  const lines = text.split('\n');

  let min = Infinity;
  for (const line of lines) {
    if (line.trim() === '') continue; // blank lines don't count
    const indent = line.match(/^[ \t]*/)?.[0].length ?? 0;
    if (indent < min) min = indent;
    if (min === 0) break;
  }

  if (!Number.isFinite(min) || min === 0) return text;
  return lines.map((line) => (line.trim() === '' ? line : line.slice(min))).join('\n');
}
