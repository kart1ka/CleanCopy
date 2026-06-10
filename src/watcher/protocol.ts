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
}

export type HelperMessage =
  | ClipboardEvent
  | { type: 'ready' }
  | { type: 'wrote' }
  | { type: 'pong' };

export type NodeMessage = { type: 'write'; text: string } | { type: 'ping' };

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
    case 'wrote':
    case 'pong':
      return { type: msg.type };
    case 'clipboard':
      if (typeof msg.text !== 'string') return null;
      return {
        type: 'clipboard',
        bundleId: typeof msg.bundleId === 'string' ? msg.bundleId : '',
        appName: typeof msg.appName === 'string' ? msg.appName : '',
        text: msg.text,
      };
    default:
      return null;
  }
}

export function serializeNodeMessage(message: NodeMessage): string {
  return JSON.stringify(message) + '\n';
}
