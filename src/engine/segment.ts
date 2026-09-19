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
  let start = 0;
  let end = 0;
  let lineEndings: string[] = [];

  const flush = () => {
    if (current.length > 0) {
      blocks.push({
        lines: current, text: current.join('\n'),
        start, end, lineEndings: lineEndings.slice(0, -1),
      });
      current = [];
      lineEndings = [];
    }
  };

  const parts = text.split(/(\r\n|\r|\n)/);
  let offset = 0;
  for (let i = 0; i < parts.length; i += 2) {
    const line = parts[i];
    const ending = parts[i + 1] ?? '';
    if (line.trim() === '') {
      flush();
    } else {
      if (current.length === 0) start = offset;
      current.push(line);
      lineEndings.push(ending);
      end = offset + line.length;
    }
    offset += line.length + ending.length;
  }
  flush();

  return blocks;
}
