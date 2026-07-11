import type { Block } from './types';

// Step 2 of the pipeline: split the text into blocks.
//
// A run of one or more blank lines marks the boundary between blocks. This
// matters because a single copy is often mixed — a paragraph, then code, then
// another paragraph — and each block must be judged on its own.
//
// Known limitation to revisit: a fenced code block (```) that contains blank
// lines will be split here. Fence-awareness can be added later.
export function segment(text: string): Block[] {
  const blocks: Block[] = [];
  let current: string[] = [];
  let pendingBlankLines = 0;
  let blankLinesBefore = 0;

  const flush = () => {
    if (current.length > 0) {
      blocks.push({ lines: current, text: current.join('\n'), blankLinesBefore });
      current = [];
      blankLinesBefore = 0;
    }
  };

  for (const line of text.split('\n')) {
    if (line.trim() === '') {
      flush();
      pendingBlankLines += 1;
    } else {
      if (current.length === 0) {
        // Leading blank lines are intentionally discarded. Between blocks,
        // retain the exact run so stitching can preserve source structure.
        blankLinesBefore = blocks.length > 0 ? pendingBlankLines : 0;
        pendingBlankLines = 0;
      }
      current.push(line);
    }
  }
  flush();

  return blocks;
}
