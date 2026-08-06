import { LIST_ITEM } from './classify';
import { stripCommonMargin } from './normalize';
import type { Block, Classification, JoinReport } from './types';

// Step 4 of the pipeline: turn a judged block into its cleaned text.
//
// Only prose and lists that the classifier is confident about get reflowed.
// Everything else is returned verbatim (the always-safe normalize step has
// already run on the whole text).

/** Below this confidence, don't reflow — leave the block alone. */
export const REFLOW_THRESHOLD = 0.6;

/**
 * The one reflow gate, shared by transform() and the doc-width inference so
 * they can never disagree about which blocks are reflow candidates. The
 * threshold is a real knob: single-line prose scores 0.5 (below it), loose
 * multi-line prose 0.7, lists 0.8, wrap-shaped prose 0.9.
 */
export function shouldReflow(c: Classification): boolean {
  return c.reflowable && c.confidence >= REFLOW_THRESHOLD;
}

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

// inferWrapWidth only trusts a paste-wide wrap column when the longest line is
// at least a plausible terminal width (so a block of short uniform lines — a
// poem, a signature — can never establish one) and at least this many lines
// hug it (a real wrap column is hit again and again; a lone long line proves
// nothing).
const MIN_DOC_WIDTH = 40;
const MIN_HUGGING_LINES = 3;

/**
 * Infer, from a whole paste, the column it was wrapped at: the right edge that
 * wrapped lines hug. In a terminal copy no line can be wider than the window,
 * so the longest line is a lower bound on the window width — and when several
 * lines run right up to it, it almost certainly *is* the wrap column. Returns
 * undefined when the paste doesn't establish one; callers must then fall back
 * to per-block evidence only.
 *
 * Two deliberate one-directional skews keep estimation errors conservative,
 * and both are invariants — flipping either silently weakens the golden rule:
 * (a) callers must pass only the text of reflowable (prose/list) blocks, never
 *     verbatim ones — log/code lines often share lengths and would establish a
 *     spurious column that could join deliberate breaks near it; and
 * (b) lengths here keep leading indentation while judgeBreak compares against
 *     a trimmed prev line, so any mismatch makes docWidth relatively larger,
 *     which only ever suppresses joins.
 */
export function inferWrapWidth(text: string): number | undefined {
  const lengths = text
    .split('\n')
    .map((l) => l.trimEnd().length)
    .filter((n) => n > 0);
  if (lengths.length === 0) return undefined;

  // reduce, not Math.max(...spread): a paste can run to 100k+ lines, and that
  // many spread arguments overflow the call stack (same in the reflows below).
  const max = lengths.reduce((m, n) => Math.max(m, n), 0);
  if (max < MIN_DOC_WIDTH) return undefined;

  const hugging = lengths.filter((n) => n >= max - NEAR_MAX).length;
  return hugging >= MIN_HUGGING_LINES ? max : undefined;
}

/** Document-level context handed down from clean() to each block's transform. */
export interface TransformContext {
  /** The paste-wide wrap column from {@link inferWrapWidth}, when established. */
  docWidth?: number;
  /** When provided, every break decision is recorded here (for `--explain`). */
  joins?: JoinReport[];
  /** Keep a list block's leading indent when it belongs under a prior list. */
  preserveListIndent?: boolean;
}

export function transform(
  block: Block,
  c: Classification,
  ctx: TransformContext = {},
): string {
  if (shouldReflow(c)) {
    if (c.type === 'list') return reflowList(block.lines, ctx);
    if (c.type === 'prose') return reflowParagraph(block.lines, ctx);
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
function reflowParagraph(lines: string[], ctx: TransformContext = {}): string {
  const trimmed = lines.map(l => l.trim());
  if (trimmed.length === 1) return trimmed[0];

  const width = trimmed.reduce((m, l) => Math.max(m, l.length), 0);
  // A block whose widest line is under WRAP_MIN cannot be width-wrapped prose —
  // no real window is that narrow, so every break in it is the author's
  // (`git branch` output, short assignments, one-command-per-line notes).
  // Return it byte-for-byte: even the space collapsing below could flatten
  // alignment inside lines that were never going to be joined.
  if (width < WRAP_MIN) return lines.join('\n');
  // One longest line is not evidence of a wrap column: it may have been
  // created by an earlier cleanup pass. Require the edge to repeat before it
  // can independently justify removing another break.
  const hugging = trimmed.filter((line) => line.length >= width - NEAR_MAX).length;
  const establishedWidth = hugging >= 2 ? width : undefined;

  const out: string[] = [lines[0]];
  for (let i = 1; i < trimmed.length; i++) {
    const prev = trimmed[i - 1];
    const next = trimmed[i];
    const verdict = judgeBreak(prev, next, establishedWidth, ctx.docWidth);
    ctx.joins?.push({ line: i - 1, ...verdict });
    if (verdict.joined) {
      out[out.length - 1] += ' ' + next; // soft wrap — glue the trimmed text
    } else {
      out.push(lines[i]); // deliberate break — keep the line and its indent
    }
  }
  // Collapse runs of spaces, but only after the first non-space character so
  // a kept line's leading indent (e.g. an indented attribution) survives.
  // Then strip the margin the output lines still share: joining can leave the
  // first line's private indent as the whole block's margin (e.g. a two-line
  // block whose indented first line swallowed the only other line), and a
  // second clean() would strip it in normalize — doing it here keeps
  // clean(clean(x)) === clean(x). Relative indent (the attribution above)
  // survives, exactly as it does in normalize.
  return stripCommonMargin(out.map(l => l.replace(/(\S) {2,}/g, '$1 ').trimEnd()).join('\n'));
}

/** Decide whether the break between prev and next was a soft wrap. */
function judgeBreak(
  prev: string,
  next: string,
  width: number | undefined,
  docWidth?: number,
): Omit<JoinReport, 'line'> {
  // Hard vetoes — breaks that are deliberate by construction, whatever the
  // evidence on either side says.
  if (ENDS_LEADIN.test(prev)) return { joined: false, score: 0, signals: ['veto:lead-in'] };
  if (HEADING.test(prev)) return { joined: false, score: 0, signals: ['veto:heading-above'] };
  if (HEADING.test(next)) return { joined: false, score: 0, signals: ['veto:heading-below'] };
  if (LIST_ITEM.test(next)) return { joined: false, score: 0, signals: ['veto:list-item'] };
  // A marker line whose item is a single word ("* main", "- done") is
  // structured output — branch lists, checkbox summaries — not a wrap: a line
  // that wrapped after its first word would imply a window a few columns wide.
  if (LIST_ITEM.test(prev) && !/\s/.test(prev.replace(LIST_ITEM, '').trim())) {
    return { joined: false, score: 0, signals: ['veto:one-word-item'] };
  }

  const atRightEdge =
    width !== undefined && prev.length >= WRAP_MIN && prev.length >= width - NEAR_MAX;

  let score = 0;
  const signals: string[] = [];
  const add = (n: number, name: string) => {
    score += n;
    signals.push(`${name}${n > 0 ? '+' : ''}${n}`);
  };

  // Strong: the next line picks up mid-sentence.
  if (CONTINUES_SENTENCE.test(next)) add(2, 'continues-sentence');
  // Strong: prev ran to the block's right edge, so it stopped only because it
  // ran out of room.
  if (atRightEdge) add(2, 'at-right-edge');
  // Strong: the next line's first word would not have fit on prev within the
  // paste-wide wrap column — the break sits exactly where a forced wrap would.
  // (This is the wrap invariant: a wrapped line plus the word that follows it
  // always overflows the column; an author breaking early usually doesn't.)
  if (docWidth !== undefined) {
    const firstWord = next.split(/\s+/, 1)[0] ?? '';
    if (firstWord.length > 0 && prev.length + 1 + firstWord.length > docWidth) {
      add(2, 'next-word-cannot-fit');
    }
  }
  // Weak: prev ends on a word that cannot end a clause.
  if (DANGLING_WORD.test(prev)) add(1, 'dangling-word');
  // Weak: prev opened a bracket it never closed on its own line.
  if (hasUnclosedOpener(prev)) add(1, 'unclosed-bracket');
  // Counter-evidence: a finished sentence followed by a fresh capitalized one
  // reads as two deliberate lines — but only when prev stopped short of the
  // edge, where the author had room to continue and chose not to.
  if (!atRightEdge && SENTENCE_END.test(prev) && STARTS_UPPER.test(next)) {
    add(-1, 'sentence-end');
  }

  return { joined: score >= JOIN_SCORE, score, signals };
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

/**
 * Glue each item's wrapped lines together; keep items on their own lines.
 * A continuation line is only glued when the break before it scores as a soft
 * wrap (same evidence as paragraphs) — a deliberate sub-line, e.g. one that
 * follows an item ending in ":", stays on its own line.
 */
function reflowList(lines: string[], ctx: TransformContext = {}): string {
  // A list block can sit indented as a whole, relative to the prose around it.
  // Usually that is copied render margin and can be removed. When it follows
  // another list block, though, the same indent can express a child list split
  // off by a blank line, so keep it intact.
  const block = ctx.preserveListIndent
    ? lines
    : stripCommonMargin(lines.join('\n')).split('\n');
  const width = block.reduce((m, l) => Math.max(m, l.trim().length), 0);
  // Same narrow-block gate as reflowParagraph: items this short were never
  // wrapped, so there is nothing to rejoin and no space run worth collapsing.
  if (width < WRAP_MIN) return block.join('\n');
  const hugging = block.filter((line) => line.trim().length >= width - NEAR_MAX).length;
  const establishedWidth = hugging >= 2 ? width : undefined;
  const out: string[] = [];

  for (let i = 0; i < block.length; i++) {
    const line = block[i];
    if (LIST_ITEM.test(line) || out.length === 0) {
      out.push(line); // new item — keep its nesting indent
      continue;
    }
    const prev = block[i - 1].trim();
    const next = line.trim();
    const verdict = judgeBreak(prev, next, establishedWidth, ctx.docWidth);
    ctx.joins?.push({ line: i - 1, ...verdict });
    if (verdict.joined) {
      out[out.length - 1] += ' ' + next; // wrapped continuation
    } else {
      out.push(line); // deliberate sub-line — keep the break and its indent
    }
  }

  // Collapse runs of spaces, but only after the first non-space character so a
  // kept sub-line's leading indent survives.
  return out.map(i => i.replace(/(\S) {2,}/g, '$1 ').trimEnd()).join('\n');
}
