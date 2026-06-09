import type { Block, Classification } from './types';

// Step 4 of the pipeline: turn a judged block into its cleaned text.
//
// Only prose and lists that the classifier is confident about get reflowed.
// Everything else is returned verbatim (the always-safe normalize step has
// already run on the whole text).

const LIST_ITEM = /^(\s*)([-*+•]\s+|\d+[.)]\s+)/;

/** Below this confidence, don't reflow — leave the block alone. */
export const REFLOW_THRESHOLD = 0.6;

export function transform(block: Block, c: Classification): string {
  if (c.reflowable && c.confidence >= REFLOW_THRESHOLD) {
    if (c.type === 'list') return reflowList(block.lines);
    if (c.type === 'prose') return reflowParagraph(block.lines);
  }
  return block.lines.join('\n');
}

/** Glue wrapped lines back into a single paragraph. */
function reflowParagraph(lines: string[]): string {
  return lines
    .map((l) => l.trim())
    .join(' ')
    .replace(/ {2,}/g, ' ')
    .trim();
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
