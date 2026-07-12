import { clean } from '../engine';
import { isTerminalApp } from './terminals';
import type { ClipboardEvent } from './protocol';

// The watcher's whole policy, as a pure function so it can be tested without
// a helper process or a real clipboard: given a clipboard event, either
// rewrite the clipboard with cleaned text or leave it alone.

/**
 * Copies longer than this are never reflow-worthy prose; leave them alone.
 * Measured in UTF-16 code units (JS string length). The Swift helper has a
 * transport guard in the same unit at twice this value — raising this limit
 * up to that bound takes effect without rebuilding the helper, and copies
 * the helper withholds are logged via its "dropped" message.
 */
export const MAX_TEXT_LENGTH = 1024 * 1024;

export type Decision =
  | {
      action: 'write';
      text: string;
      /** Content-free description for the event log (line counts only). */
      summary: string;
    }
  | {
      action: 'ignore';
      reason: 'not-terminal' | 'empty' | 'too-large' | 'already-clean';
    };

export function decide(
  event: Pick<ClipboardEvent, 'bundleId' | 'text'>,
  extraTerminals: readonly string[] = [],
): Decision {
  // Privacy gate first: copies from non-terminal apps are discarded before
  // the text is examined in any way.
  if (!isTerminalApp(event.bundleId, extraTerminals)) {
    return { action: 'ignore', reason: 'not-terminal' };
  }
  if (event.text.trim() === '') return { action: 'ignore', reason: 'empty' };
  if (event.text.length > MAX_TEXT_LENGTH) return { action: 'ignore', reason: 'too-large' };

  // clean() preserves the input's trailing-newline state, so the only
  // difference we ever write back is a real cleanup, not newline churn.
  const output = clean(event.text);
  if (output === event.text) return { action: 'ignore', reason: 'already-clean' };

  const before = countLines(event.text);
  const after = countLines(output);
  return { action: 'write', text: output, summary: `${before} lines -> ${after}` };
}

function countLines(text: string): number {
  return text.replace(/\n+$/, '').split('\n').length;
}
