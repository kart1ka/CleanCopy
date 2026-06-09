// Shared types for the cleanup engine.
//
// The engine is pure: text in, text out. Nothing here knows about clipboards,
// macOS, or the filesystem — that keeps it testable in isolation and reusable.

/** What a single block of text was judged to be. */
export type BlockType =
  | 'prose' // flowing sentences — safe to glue wrapped lines together
  | 'list' // bulleted / numbered — reflow within an item, keep items apart
  | 'code' // leave exactly as-is
  | 'table' // aligned columns — leave exactly as-is
  | 'trace' // error / stack trace / log output — leave exactly as-is
  | 'data' // JSON / YAML / XML-shaped — leave exactly as-is
  | 'other'; // unsure — leave exactly as-is

export interface Classification {
  type: BlockType;
  /** Whether wrapped lines in this block may be glued back together. */
  reflowable: boolean;
  /** 0..1. Low confidence means "leave it alone". */
  confidence: number;
  /** Which clues fired, for the `--explain` output and for debugging. */
  signals: string[];
}

export interface Block {
  /** The block's lines, in order, without the blank lines that separate blocks. */
  lines: string[];
  /** The block's text — `lines` joined by "\n". */
  text: string;
}

export interface CleanOptions {
  /** Keep per-block explanations in the result instead of discarding them. */
  explain?: boolean;
}

export interface BlockReport {
  block: Block;
  classification: Classification;
  /** The cleaned text this block produced. */
  output: string;
}

export interface CleanResult {
  /** The final cleaned text. */
  text: string;
  /** One entry per block, in order. Useful for `--explain`. */
  reports: BlockReport[];
}
