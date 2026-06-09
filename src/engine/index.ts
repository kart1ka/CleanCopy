import { normalize } from './normalize';
import { segment } from './segment';
import { classify } from './classify';
import { transform } from './transform';
import type { BlockReport, CleanOptions, CleanResult } from './types';

export * from './types';
export { normalize, stripCommonMargin } from './normalize';
export { segment } from './segment';
export { classify } from './classify';
export { transform, REFLOW_THRESHOLD } from './transform';

/**
 * Clean a piece of copied text. Pure: text in, text out, no side effects.
 *
 * Pipeline:
 *   1. normalize  — always-safe tidy-ups on the whole text
 *   2. segment    — split into blocks at blank lines
 *   3. classify   — judge each block (prose? code? list? …)
 *   4. transform  — tidy each block according to what it is
 * then the blocks are stitched back together with a single blank line between.
 *
 * Golden rule: when unsure, a block is left exactly as it was.
 */
export function clean(input: string): string {
  return cleanWithReport(input).text;
}

/** Like {@link clean}, but also returns the per-block classifications. */
export function cleanWithReport(input: string, _options: CleanOptions = {}): CleanResult {
  const normalized = normalize(input);
  const blocks = segment(normalized);

  const reports: BlockReport[] = blocks.map((block) => {
    const classification = classify(block);
    return { block, classification, output: transform(block, classification) };
  });

  const text = reports
    .map((r) => r.output)
    .join('\n\n')
    .replace(/\n{3,}/g, '\n\n') // collapse any stray big gaps
    .replace(/[ \t]+$/gm, '') // belt-and-braces trailing trim
    .replace(/^\n+|\n+$/g, ''); // no leading / trailing blank lines

  return { text, reports };
}
