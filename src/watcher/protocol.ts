// Wire protocol between the Node watcher and the Swift helper binary:
// one JSON object per line, in both directions, over stdin/stdout.

/** Helper → Node: the pasteboard changed and held plain text. */
export interface ClipboardEvent {
  type: 'clipboard';
  /** Bundle id of the frontmost app at poll time (e.g. "com.googlecode.iterm2"). */
  bundleId: string;
  /** Human name of that app (e.g. "iTerm2") — used only for event logging. */
  appName: string;
  text: string;
  /**
   * NSPasteboard.changeCount at the moment this event was read. Echoed back in
   * the write that answers it, so the helper can refuse to overwrite a newer
   * copy that landed in between.
   */
  changeCount?: number;
}

export type HelperMessage =
  | ClipboardEvent
  | { type: 'ready' }
  // Ack of a write. changeCount is the pasteboard count the write produced —
  // the revert flow echoes it back so a revert can never clobber a newer copy.
  | { type: 'wrote'; changeCount?: number }
  | { type: 'write-failed' }
  | { type: 'stale' } // a write was skipped because the pasteboard had moved on
  | { type: 'dropped'; reason: string } // a copy withheld at the transport (content-free)
  | { type: 'hotkey'; id: string } // a registered global hotkey was pressed
  | { type: 'hotkey-failed'; id: string } // combo taken by another app; not registered
  | { type: 'pong' };

export type NodeMessage =
  | { type: 'write'; text: string; expectedChangeCount?: number }
  | { type: 'ping' };

/** Parse one line from the helper. Returns null for anything malformed. */
export function parseHelperMessage(line: string): HelperMessage | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null) return null;
  const msg = value as Record<string, unknown>;
  switch (msg.type) {
    case 'ready':
    case 'write-failed':
    case 'stale':
    case 'pong':
      return { type: msg.type };
    case 'wrote':
      return {
        type: 'wrote',
        ...(typeof msg.changeCount === 'number' ? { changeCount: msg.changeCount } : {}),
      };
    case 'dropped':
      return { type: 'dropped', reason: typeof msg.reason === 'string' ? msg.reason : 'unknown' };
    case 'hotkey':
    case 'hotkey-failed':
      if (typeof msg.id !== 'string') return null;
      return { type: msg.type, id: msg.id };
    case 'clipboard':
      if (typeof msg.text !== 'string') return null;
      return {
        type: 'clipboard',
        bundleId: typeof msg.bundleId === 'string' ? msg.bundleId : '',
        appName: typeof msg.appName === 'string' ? msg.appName : '',
        text: msg.text,
        ...(typeof msg.changeCount === 'number' ? { changeCount: msg.changeCount } : {}),
      };
    default:
      return null;
  }
}

export function serializeNodeMessage(message: NodeMessage): string {
  return JSON.stringify(message) + '\n';
}
