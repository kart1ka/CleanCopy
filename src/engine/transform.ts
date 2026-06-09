import type { Block, Classification } from './types';

// Step 4 of the pipeline: turn a judged block into its cleaned text.
//
// Only prose and lists that the classifier is confident about get reflowed.
// Everything else is returned verbatim (the always-safe normalize step has
// already run on the whole text).

const LIST_ITEM = /^(\s*)([-*+•]\s+|\d+[.)]\s+)/;

/** Below this confidence, don't reflow — leave the block alone. */
export const REFLOW_THRESHOLD = 0.6;

// When deciding whether a line break is a soft wrap (remove it) or an
// intentional break (keep it):
//   - WRAP_MIN: a line shorter than this is unlikely to be a wrapped line at
//     normal terminal widths, so we never treat it as a soft wrap.
//   - NEAR_MAX: a wrapped line runs nearly to the block's widest line; a line
//     that stops well short of that was almost certainly a deliberate break.
const WRAP_MIN = 45;
const NEAR_MAX = 15;
// A line ending in one of these is a sentence/clause boundary or a lead-in
// (e.g. a label ending in ":"), not a mid-word wrap — never join across it.
const ENDS_INTENTIONAL = /[.!?:;]$/;
// A Markdown ATX heading line. We never merge a heading into the line below it,
// nor the line above into a heading. (Consequence: a heading that genuinely
// wrapped across lines is left as-is rather than rejoined — see note below.)
const HEADING = /^#{1,6}\s/;

export function transform(block: Block, c: Classification): string {
  if (c.reflowable && c.confidence >= REFLOW_THRESHOLD) {
    if (c.type === 'list') return reflowList(block.lines);
    if (c.type === 'prose') return reflowParagraph(block.lines);
  }
  return block.lines.join('\n');
}

/**
 * Glue wrapped lines back into a paragraph — but only at boundaries that look
 * like soft wraps. A break is removed only when the line above it ran nearly to
 * the block's widest line and didn't end on sentence/clause punctuation.
 * Intentional breaks (short lines, lead-ins ending in ":", etc.) are kept.
 */
function reflowParagraph(lines: string[]): string {
  const trimmed = lines.map((l) => l.trim());
  if (trimmed.length === 1) return trimmed[0];

  const width = Math.max(...trimmed.map((l) => l.length));

  let out = trimmed[0];
  for (let i = 1; i < trimmed.length; i++) {
    const prev = trimmed[i - 1];
    const next = trimmed[i];
    const prevLooksWrapped =
      prev.length >= WRAP_MIN &&
      prev.length >= width - NEAR_MAX &&
      !ENDS_INTENTIONAL.test(prev) &&
      !HEADING.test(prev);
    const join = prevLooksWrapped && !LIST_ITEM.test(next) && !HEADING.test(next);
    out += (join ? ' ' : '\n') + next;
  }
  return out.replace(/ {2,}/g, ' ');
}

/** Glue each item's wrapped lines together; keep items on their own lines. */
function reflowList(lines: string[]): string {
  const items: string[] = [];

  for (const line of lines) {
    if (LIST_ITEM.test(line)) {
      items.push(line.trimStart()); // new item — drop its leading indent
    } else if (items.length > 0) {
      items[items.length - 1] += ' ' + line.trim(); // wrapped continuation
    } else {
      items.push(line.trim());
    }
  }

  return items.map((i) => i.replace(/ {2,}/g, ' ').trim()).join('\n');
}
