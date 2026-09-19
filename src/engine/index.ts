import { normalize, stripRenderMargin } from './normalize';
import { segment } from './segment';
import { classify, forcedVerbatim, looksLikeTranscript } from './classify';
import { transform, inferWrapWidth, isReflowEnabled } from './transform';
import { resolveRules, type Rules } from './rules';
import type { BlockReport, CleanOptions, CleanResult, JoinReport } from './types';

export * from './types';
export { RULES, RULE_IDS, isRuleId, resolveRules } from './rules';
export type { RuleId, Rules, RuleOverrides } from './rules';
export { normalize, stripCommonMargin } from './normalize';
export { segment } from './segment';
export { classify } from './classify';
export { transform, inferWrapWidth, REFLOW_THRESHOLD, shouldReflow, isReflowEnabled } from './transform';
export type { TransformContext } from './transform';

/**
 * Clean a piece of copied text. Pure: text in, text out, no side effects.
 *
 * Pipeline:
 *   1. normalize  — configured tidy-ups on the whole text
 *   2. segment    — split into blocks at blank lines
 *   3. classify   — judge each block (prose? code? list? …)
 *   4. transform  — tidy each block according to what it is
 * then the blocks are stitched back together with their original internal
 * blank-line separators.
 *
 * Golden rule: when unsure, a normalized block is not reflowed.
 */
export function clean(input: string, options: CleanOptions = {}): string {
  return cleanWithReport(input, options).text;
}

/**
 * Like {@link clean}, but also returns the per-block classifications.
 *
 * Stability gate: the pipeline runs once more on its own output, and if that
 * second pass would change anything the text has manufactured a new wrap
 * geometry out of its own joins — self-detected ambiguity. The golden rule
 * answers ambiguity with inaction, so the copy is returned normalize-only,
 * which also makes clean() idempotent by construction rather than by hope.
 */
export function cleanWithReport(input: string, options: CleanOptions = {}): CleanResult {
  const rules = resolveRules(options.rules);
  const first = runPipeline(input, rules, options.explain);
  if (runPipeline(first.text, rules).text === first.text) return first;
  return runPipeline(input, rules, options.explain, true);
}

function runPipeline(
  input: string,
  rules: Rules,
  explain = false,
  forceVerbatim = false,
): CleanResult {
  const normalized = normalize(input, rules);
  const blocks = segment(normalized);

  // Copy-level fences, judged before per-block classification because their
  // evidence spans blocks: two shell prompt lines make the whole copy
  // a terminal transcript (all output, no prose to rescue — F21), and a
  // line-start `/*` freezes everything through the closing `*/` even across
  // blank lines, since a bare block comment's interior reads like prose (F20).
  const transcript = looksLikeTranscript(normalized.split(/\r\n|\r|\n/));
  // An opener with no closing `*/` anywhere below is a torn or quoted `/*`:
  // it freezes its own block only, never the whole rest of the copy.
  let lastCloser = -1;
  let ordinal = 0;
  for (const b of blocks) {
    for (const l of b.lines) {
      if (l.includes('*/')) lastCloser = ordinal;
      ordinal++;
    }
  }
  ordinal = 0;
  let inBlockComment = false;
  const inCommentFence = blocks.map((block) => {
    let touched = false;
    for (const line of block.lines) {
      if (inBlockComment) {
        touched = true;
        if (line.includes('*/')) inBlockComment = false;
      } else if (/^\s*\/\*(?=$|[\s*!])/.test(line)) {
        // lookahead: a real opener is `/*` then space/`*`/`!`/EOL — never an
        // alphanumeric, which would be a glob like `/*.log` starting a line
        touched = true;
        inBlockComment =
          !line.slice(line.indexOf('/*') + 2).includes('*/') && lastCloser > ordinal;
      }
      ordinal++;
    }
    return touched;
  });

  const classifications = blocks.map((block, i) => {
    if (forceVerbatim) return forcedVerbatim('other', 'unstable-clean');
    if (transcript) return forcedVerbatim('other', 'terminal-transcript');
    if (inCommentFence[i]) return forcedVerbatim('code', 'block-comment-fence');
    return classify(block);
  });

  // The wrap column is a property of the whole paste — every wrapped block in
  // one copy hugs the same right edge — so it is inferred once and handed to
  // every block's transform. But only lines that can actually wrap get to
  // vouch for it: classification runs first, and verbatim blocks are excluded,
  // because log/code lines often share lengths and would otherwise establish a
  // spurious column that could join deliberate prose breaks near it.
  const inferredWidth = inferWrapWidth(
    blocks
      .filter((_, i) => isReflowEnabled(classifications[i], rules))
      .map((b) => b.text)
      .join('\n'),
  );

  const reports: BlockReport[] = blocks.map((block, i) => {
    const classification = classifications[i];
    const joins: JoinReport[] | undefined = explain ? [] : undefined;
    const output = transform(block, classification, {
      rules,
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

  // Source spans preserve separator contents and mixed line endings even
  // when normalization is disabled and some block lines have been joined.
  const chunks: string[] = [];
  let cursor = 0;
  for (const report of reports) {
    chunks.push(rules.trimOuterBlankLines && cursor === 0
      ? '' : normalized.slice(cursor, report.block.start));
    chunks.push(report.output);
    cursor = report.block.end;
  }
  const finalEnding = normalized.slice(cursor).match(/^(?:\r\n|\r|\n)/)?.[0] ?? '';
  chunks.push(rules.trimOuterBlankLines
    ? (reports.length > 0 ? finalEnding : '')
    : normalized.slice(cursor));
  let text = chunks.join('');
  // Joins can expose a new shared margin; apply the same configured rule.
  if (rules.removeSharedMargin) text = stripRenderMargin(text);
  return { text, reports, inferredWidth, rules };
}
