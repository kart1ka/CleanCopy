import { normalize } from './normalize';
import { segment } from './segment';
import { classify } from './classify';
import { transform, inferWrapWidth, shouldReflow } from './transform';
import type { BlockReport, CleanOptions, CleanResult, JoinReport } from './types';

export * from './types';
export { normalize, stripCommonMargin } from './normalize';
export { segment } from './segment';
export { classify } from './classify';
export { transform, inferWrapWidth, REFLOW_THRESHOLD, shouldReflow } from './transform';
export type { TransformContext } from './transform';

/**
 * Clean a piece of copied text. Pure: text in, text out, no side effects.
 *
 * Pipeline:
 *   1. normalize  — always-safe tidy-ups on the whole text
 *   2. segment    — split into blocks at blank lines
 *   3. classify   — judge each block (prose? code? list? …)
 *   4. transform  — tidy each block according to what it is
 * then the blocks are stitched back together with their original internal
 * blank-line separators.
 *
 * Golden rule: when unsure, a block is left exactly as it was.
 */
export function clean(input: string): string {
  return cleanWithReport(input).text;
}

/** Like {@link clean}, but also returns the per-block classifications. */
export function cleanWithReport(input: string, options: CleanOptions = {}): CleanResult {
  const normalized = normalize(input);
  // The trailing-newline contract lives here, not in each caller: the output
  // ends with a single newline exactly when the input did, so cleaning never
  // churns a final newline and every consumer (watcher, CLI) sees the same
  // bytes for the same text.
  const endsWithNewline = normalized.endsWith('\n');
  const blocks = segment(normalized);
  const classifications = blocks.map((block) => classify(block));

  // The wrap column is a property of the whole paste — every wrapped block in
  // one copy hugs the same right edge — so it is inferred once and handed to
  // every block's transform. But only lines that can actually wrap get to
  // vouch for it: classification runs first, and verbatim blocks are excluded,
  // because log/code lines often share lengths and would otherwise establish a
  // spurious column that could join deliberate prose breaks near it.
  const inferredWidth = inferWrapWidth(
    blocks
      .filter((_, i) => shouldReflow(classifications[i]))
      .map((b) => b.text)
      .join('\n'),
  );

  const reports: BlockReport[] = blocks.map((block, i) => {
    const classification = classifications[i];
    const joins: JoinReport[] | undefined = options.explain ? [] : undefined;
    const output = transform(block, classification, {
      docWidth: inferredWidth,
      joins,
      // A later indented list block can be a child list separated from its
      // parent by a blank line. Its leading spaces are structure, not margin.
      preserveListIndent:
        classification.type === 'list' &&
        (classifications[i - 1]?.type === 'list' ||
          classifications[i + 1]?.type === 'list' ||
          (blocks.length === 1 && /^[ \t]+/.test(block.lines[0] ?? ''))),
    });
    return { block, classification, output, joins };
  });

  const stitched = reports
    .map((r, i) =>
      i === 0 ? r.output : '\n'.repeat(r.block.blankLinesBefore + 1) + r.output,
    )
    .join('')
    .replace(/[ \t]+$/gm, '') // belt-and-braces trailing trim
    .replace(/^\n+|\n+$/g, ''); // no leading / trailing blank lines
  const text = stitched.length > 0 && endsWithNewline ? stitched + '\n' : stitched;

  return { text, reports, inferredWidth };
}
