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
// intentional break (keep it), one signal is uniformity: a wrapped line runs
// nearly to the block's widest line (NEAR_MAX), because the only reason it
// stopped was running out of room. (The other signal — the next line starting
// mid-sentence — is CONTINUES_SENTENCE below; it doesn't need this width, which
// matters when a paragraph was copied as a tail fragment and the first line is
// short.) A line that falls well short of the edge and isn't continued was
// almost certainly a deliberate break.
//   - NEAR_MAX: how far below the block's widest line still counts as "full".
//   - WRAP_MIN: a low absolute backstop so a block of just a few very short
//     lines (a couple of words each) is never treated as wrapped prose. It is
//     deliberately low enough to admit genuine narrow wraps — prose copied
//     from a split pane or a narrow terminal still reflows.
const WRAP_MIN = 32;
const NEAR_MAX = 15;
// A line ending in one of these is a lead-in (a label or clause introducing
// what follows, e.g. "Steps:"), so the break after it is deliberate even when
// the line runs to the block's edge — never join across it. Sentence-ending
// "." / "!" / "?" are intentionally NOT here: a sentence that ends right at the
// wrap column is a coincidental soft wrap and should still join, while one that
// ends short of the edge is already kept by the uniformity check below.
const ENDS_LEADIN = /[:;]$/;
// A Markdown ATX heading line. We never merge a heading into the line below it,
// nor the line above into a heading. (Consequence: a heading that genuinely
// wrapped across lines is left as-is rather than rejoined — see note below.)
const HEADING = /^#{1,6}\s/;
// A line that begins mid-sentence: a lowercase letter, or a closing/continuation
// mark (")" "]" "}" ",") that can only be finishing something the previous line
// started. When the line *after* a break starts like this, the break is a soft
// wrap — the sentence is still in flight — no matter how short the line before
// it looks. This is what catches a wrapped paragraph copied as a tail fragment,
// where the first line lost its original full width.
const CONTINUES_SENTENCE = /^[a-z)\]},]/;
// A line ending on one of these words cannot be ending a clause — articles,
// conjunctions, prepositions, auxiliaries, and possessives all demand a
// continuation. Weak evidence on its own (weight 1): prose lines do sometimes
// break after them deliberately, but combined with another weak signal it
// tips a break toward "soft wrap".
const DANGLING_WORD =
  /\b(a|an|the|and|or|but|nor|of|to|in|on|at|by|for|with|from|as|into|onto|over|about|after|before|between|during|through|if|that|than|because|while|when|where|so|is|are|was|were|be|been|being|has|have|had|will|would|can|could|should|shall|may|might|must|its|their|his|her|our|your|my)$/i;
// A finished sentence: terminal punctuation, optionally followed by a closing
// quote/bracket. Used only as counter-evidence, and only when the line stopped
// short of the block's right edge — a period that lands exactly at the edge is
// coincidence and says nothing about the break after it.
const SENTENCE_END = /[.!?]["')\]]*$/;
const STARTS_UPPER = /^[A-Z]/;

/** Minimum evidence score before a break is treated as a soft wrap and removed. */
const JOIN_SCORE = 2;

export function transform(block: Block, c: Classification): string {
  if (c.reflowable && c.confidence >= REFLOW_THRESHOLD) {
    if (c.type === 'list') return reflowList(block.lines);
    if (c.type === 'prose') return reflowParagraph(block.lines);
  }
  return block.lines.join('\n');
}

/**
 * Glue wrapped lines back into a paragraph — but only at boundaries that look
 * like soft wraps. The newline itself carries no record of whether it was a
 * width-forced wrap or a deliberate break, so each boundary is judged by
 * accumulating evidence from both sides (see shouldJoin): strong signals score
 * 2, weak ones 1, and the break is only removed when the total reaches
 * JOIN_SCORE. Lead-ins ending in ":"/";", headings, and list items keep their
 * break unconditionally.
 */
function reflowParagraph(lines: string[]): string {
  const trimmed = lines.map(l => l.trim());
  if (trimmed.length === 1) return trimmed[0];

  const width = Math.max(...trimmed.map(l => l.length));

  let out = trimmed[0];
  for (let i = 1; i < trimmed.length; i++) {
    const prev = trimmed[i - 1];
    const next = trimmed[i];
    out += (shouldJoin(prev, next, width) ? ' ' : '\n') + next;
  }
  return out.replace(/ {2,}/g, ' ');
}

/** Decide whether the break between prev and next was a soft wrap. */
function shouldJoin(prev: string, next: string, width: number): boolean {
  // Hard vetoes — breaks that are deliberate by construction, whatever the
  // evidence on either side says.
  if (ENDS_LEADIN.test(prev) || HEADING.test(prev)) return false;
  if (LIST_ITEM.test(next) || HEADING.test(next)) return false;

  const atRightEdge =
    prev.length >= WRAP_MIN && prev.length >= width - NEAR_MAX;

  let score = 0;
  // Strong: the next line picks up mid-sentence.
  if (CONTINUES_SENTENCE.test(next)) score += 2;
  // Strong: prev ran to the block's right edge, so it stopped only because it
  // ran out of room.
  if (atRightEdge) score += 2;
  // Weak: prev ends on a word that cannot end a clause.
  if (DANGLING_WORD.test(prev)) score += 1;
  // Weak: prev opened a bracket it never closed on its own line.
  if (hasUnclosedOpener(prev)) score += 1;
  // Counter-evidence: a finished sentence followed by a fresh capitalized one
  // reads as two deliberate lines — but only when prev stopped short of the
  // edge, where the author had room to continue and chose not to.
  if (!atRightEdge && SENTENCE_END.test(prev) && STARTS_UPPER.test(next)) {
    score -= 1;
  }

  return score >= JOIN_SCORE;
}

/** Whether the line opens a bracket ("(", "[", "{") it never closes. */
function hasUnclosedOpener(line: string): boolean {
  let depth = 0;
  for (const ch of line) {
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    // A stray closer (e.g. a tail fragment that starts mid-bracket) doesn't
    // cancel an opener that comes after it, so clamp at zero.
    else if (ch === ')' || ch === ']' || ch === '}') depth = Math.max(0, depth - 1);
  }
  return depth > 0;
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

  return items.map(i => i.replace(/ {2,}/g, ' ').trim()).join('\n');
}
