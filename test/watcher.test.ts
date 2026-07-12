import { describe, it, expect } from 'vitest';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clean } from '../src/engine';
import { decide, MAX_TEXT_LENGTH } from '../src/watcher/decide';
import { parseHelperMessage, serializeNodeMessage } from '../src/watcher/protocol';
import { isTerminalApp } from '../src/watcher/terminals';
import { startWatcher } from '../src/watcher/watcher';

// The watcher's policy is a pure function (decide), so the safety rules —
// only terminal copies, only when the engine actually changes something —
// are tested here without a helper process or a real clipboard.

const TERMINAL = 'com.googlecode.iterm2';

// Fixture 01 is wrapped prose the engine is guaranteed to reflow.
const wrappedProse = readFileSync(
  join(__dirname, 'fixtures', '01-wrapped-paragraph', 'input.txt'),
  'utf8',
);
// Fixture 02 is code the engine is guaranteed to leave alone.
const codeBlock = readFileSync(
  join(__dirname, 'fixtures', '02-code-block', 'input.txt'),
  'utf8',
);

describe('decide — the watcher policy', () => {
  it('discards copies from non-terminal apps before looking at the text', () => {
    expect(decide({ bundleId: 'com.apple.Safari', text: wrappedProse })).toEqual({
      action: 'ignore',
      reason: 'not-terminal',
    });
    expect(decide({ bundleId: '', text: wrappedProse })).toEqual({
      action: 'ignore',
      reason: 'not-terminal',
    });
  });

  it('rewrites a wrapped-prose terminal copy with the cleaned text', () => {
    const decision = decide({ bundleId: TERMINAL, text: wrappedProse });
    expect(decision.action).toBe('write');
    if (decision.action === 'write') {
      expect(decision.text).toBe(clean(wrappedProse) + '\n');
      // The summary is content-free: line counts only.
      expect(decision.summary).toMatch(/^\d+ lines -> \d+$/);
      expect(decision.summary).not.toContain('cleanup engine');
    }
  });

  it('leaves a code copy alone even though it came from a terminal', () => {
    expect(decide({ bundleId: TERMINAL, text: codeBlock })).toEqual({
      action: 'ignore',
      reason: 'already-clean',
    });
  });

  it('preserves the trailing newline a terminal copy carries', () => {
    const withNewline = decide({ bundleId: TERMINAL, text: wrappedProse });
    const withoutNewline = decide({ bundleId: TERMINAL, text: wrappedProse.replace(/\n$/, '') });
    if (withNewline.action !== 'write' || withoutNewline.action !== 'write') {
      throw new Error('expected both decisions to be writes');
    }
    expect(withNewline.text.endsWith('\n')).toBe(true);
    expect(withoutNewline.text.endsWith('\n')).toBe(false);
  });

  it('ignores empty and whitespace-only copies', () => {
    expect(decide({ bundleId: TERMINAL, text: '' })).toEqual({
      action: 'ignore',
      reason: 'empty',
    });
    expect(decide({ bundleId: TERMINAL, text: '  \n\n ' })).toEqual({
      action: 'ignore',
      reason: 'empty',
    });
  });

  it('ignores copies too large to be reflow-worthy prose', () => {
    const huge = 'a'.repeat(MAX_TEXT_LENGTH + 1);
    expect(decide({ bundleId: TERMINAL, text: huge })).toEqual({
      action: 'ignore',
      reason: 'too-large',
    });
  });

  it('is a no-op on its own output (no clean-write loops)', () => {
    const first = decide({ bundleId: TERMINAL, text: wrappedProse });
    if (first.action !== 'write') throw new Error('expected a write');
    expect(decide({ bundleId: TERMINAL, text: first.text })).toEqual({
      action: 'ignore',
      reason: 'already-clean',
    });
  });

  it('honours extra terminal bundle ids', () => {
    const event = { bundleId: 'com.example.myterm', text: wrappedProse };
    expect(decide(event).action).toBe('ignore');
    expect(decide(event, ['com.example.myterm']).action).toBe('write');
  });
});

describe('terminal allowlist', () => {
  it('knows the common terminals and nothing else', () => {
    expect(isTerminalApp('com.apple.Terminal')).toBe(true);
    expect(isTerminalApp('com.googlecode.iterm2')).toBe(true);
    expect(isTerminalApp('com.mitchellh.ghostty')).toBe(true);
    expect(isTerminalApp('com.apple.Safari')).toBe(false);
    // Editors with built-in terminals are deliberately excluded.
    expect(isTerminalApp('com.microsoft.VSCode')).toBe(false);
  });
});

describe('helper protocol', () => {
  it('round-trips a clipboard event with newlines and unicode intact', () => {
    const text = 'line one\nline two\t"quoted"​';
    const line = JSON.stringify({
      type: 'clipboard',
      bundleId: TERMINAL,
      appName: 'iTerm2',
      text,
      changeCount: 42,
    });
    expect(parseHelperMessage(line)).toEqual({
      type: 'clipboard',
      bundleId: TERMINAL,
      appName: 'iTerm2',
      text,
      changeCount: 42,
    });
  });

  it('rejects malformed lines instead of throwing', () => {
    expect(parseHelperMessage('')).toBeNull();
    expect(parseHelperMessage('not json')).toBeNull();
    expect(parseHelperMessage('42')).toBeNull();
    expect(parseHelperMessage('{"type":"clipboard"}')).toBeNull(); // no text
    expect(parseHelperMessage('{"type":"mystery"}')).toBeNull();
    expect(parseHelperMessage('{"type":"write-failed"}')).toEqual({ type: 'write-failed' });
  });

  it('parses hotkey presses and registration failures', () => {
    expect(parseHelperMessage('{"type":"hotkey","id":"revert"}')).toEqual({
      type: 'hotkey',
      id: 'revert',
    });
    expect(parseHelperMessage('{"type":"hotkey-failed","id":"clean"}')).toEqual({
      type: 'hotkey-failed',
      id: 'clean',
    });
    expect(parseHelperMessage('{"type":"hotkey"}')).toBeNull(); // no id
  });

  it('parses the changeCount a wrote ack carries', () => {
    expect(parseHelperMessage('{"type":"wrote","changeCount":9}')).toEqual({
      type: 'wrote',
      changeCount: 9,
    });
    expect(parseHelperMessage('{"type":"wrote"}')).toEqual({ type: 'wrote' });
  });

  it('parses the content-free dropped message', () => {
    expect(parseHelperMessage('{"type":"dropped","reason":"too-large"}')).toEqual({
      type: 'dropped',
      reason: 'too-large',
    });
    expect(parseHelperMessage('{"type":"dropped"}')).toEqual({
      type: 'dropped',
      reason: 'unknown',
    });
  });

  it('serializes node messages as a single line', () => {
    const serialized = serializeNodeMessage({ type: 'write', text: 'a\nb' });
    expect(serialized.endsWith('\n')).toBe(true);
    expect(serialized.slice(0, -1)).not.toContain('\n');
    expect(JSON.parse(serialized)).toEqual({ type: 'write', text: 'a\nb' });
  });
});

describe('startWatcher — event to write, end to end', () => {
  // A fake helper (plain Node script) stands in for the Swift binary: it
  // emits scripted clipboard events and records every message the watcher
  // sends back, so the whole helper→decide→write loop is exercised without
  // a pasteboard or a frontmost app.
  it('cleans a terminal copy and silently discards a non-terminal one', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cleancopy-watcher-'));
    const inputPath = join(dir, 'input.txt');
    const outPath = join(dir, 'received.jsonl');
    writeFileSync(inputPath, wrappedProse);

    const fakeHelper = join(dir, 'fake-helper.js');
    writeFileSync(
      fakeHelper,
      `#!/usr/bin/env node
const fs = require('fs');
const text = fs.readFileSync(${JSON.stringify(inputPath)}, 'utf8');
console.log(JSON.stringify({ type: 'ready' }));
console.log(JSON.stringify({ type: 'clipboard', bundleId: 'com.apple.Safari', appName: 'Safari', text, changeCount: 6 }));
console.log(JSON.stringify({ type: 'clipboard', bundleId: 'com.googlecode.iterm2', appName: 'iTerm2', text, changeCount: 7 }));
process.stdin.on('data', (d) => fs.appendFileSync(${JSON.stringify(outPath)}, d));
process.stdin.on('end', () => process.exit(0));
`,
    );
    chmodSync(fakeHelper, 0o755);

    const logLines: string[] = [];
    const watcher = startWatcher({ helperPath: fakeHelper, log: (l) => logLines.push(l) });
    try {
      const deadline = Date.now() + 3000;
      while (!existsSync(outPath) && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 25));
      }
      const received = readFileSync(outPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));

      // Exactly one write — for the terminal copy, with the engine's output,
      // echoing the event's changeCount so the helper can refuse stale writes.
      expect(received).toEqual([
        { type: 'write', text: clean(wrappedProse) + '\n', expectedChangeCount: 7 },
      ]);

      // The log knows what happened but never what the text was — and the
      // discarded non-terminal copy left no trace at all.
      expect(logLines.join('\n')).toContain('cleaned copy from iTerm2');
      expect(logLines.join('\n')).not.toContain('Safari');
      expect(logLines.join('\n')).not.toContain('cleanup engine'); // words from the copied text
    } finally {
      watcher.stop();
    }
  });

  it('in manual mode, cleans only when the clean hotkey fires', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cleancopy-manual-'));
    const outPath = join(dir, 'received.jsonl');

    // Ready → a Safari copy (must vanish) → a terminal copy (must wait) →
    // the clean hotkey. Argv is recorded so the hotkey flags are checkable.
    const fakeHelper = join(dir, 'fake-helper.js');
    writeFileSync(
      fakeHelper,
      `#!/usr/bin/env node
const fs = require('fs');
const text = ${JSON.stringify(wrappedProse)};
fs.appendFileSync(${JSON.stringify(outPath)}, JSON.stringify({ argv: process.argv.slice(2) }) + '\\n');
console.log(JSON.stringify({ type: 'ready' }));
console.log(JSON.stringify({ type: 'clipboard', bundleId: 'com.apple.Safari', appName: 'Safari', text, changeCount: 4 }));
console.log(JSON.stringify({ type: 'clipboard', bundleId: 'com.googlecode.iterm2', appName: 'iTerm2', text, changeCount: 5 }));
setTimeout(() => console.log(JSON.stringify({ type: 'hotkey', id: 'clean' })), 150);
process.stdin.on('data', (d) => fs.appendFileSync(${JSON.stringify(outPath)}, d));
process.stdin.on('end', () => process.exit(0));
`,
    );
    chmodSync(fakeHelper, 0o755);

    const logLines: string[] = [];
    const watcher = startWatcher({
      helperPath: fakeHelper,
      log: (l) => logLines.push(l),
      mode: 'manual',
      hotkeys: { clean: 'cmd+ctrl+c', revert: 'cmd+ctrl+z' },
    });
    try {
      const deadline = Date.now() + 3000;
      while (
        !logLines.some((l) => l.startsWith('cleaned copy')) &&
        Date.now() < deadline
      ) {
        await new Promise((r) => setTimeout(r, 25));
      }
      const received = readFileSync(outPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));

      // Both hotkeys were passed to the helper (manual mode registers both)...
      expect(received[0].argv).toEqual([
        '--hotkey', 'clean:cmd+ctrl+c',
        '--hotkey', 'revert:cmd+ctrl+z',
      ]);
      // ...and exactly one write happened — for the terminal copy, only after
      // the hotkey, pinned to that copy's changeCount.
      expect(received.slice(1)).toEqual([
        { type: 'write', text: clean(wrappedProse) + '\n', expectedChangeCount: 5 },
      ]);

      // The terminal copy was noted (with the hotkey to press) before it was
      // cleaned; the Safari copy left no trace at all.
      const noted = logLines.findIndex((l) => l.includes('terminal copy from iTerm2 noted'));
      const cleaned = logLines.findIndex((l) => l.startsWith('cleaned copy from iTerm2'));
      expect(noted).toBeGreaterThanOrEqual(0);
      expect(cleaned).toBeGreaterThan(noted);
      expect(logLines[noted]).toContain('press cmd+ctrl+c');
      expect(logLines.join('\n')).not.toContain('Safari');
    } finally {
      watcher.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('in auto mode, registers only the revert hotkey and reverts on it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cleancopy-revert-'));
    const outPath = join(dir, 'received.jsonl');

    // A terminal copy is auto-cleaned; the wrote ack carries the changeCount
    // the write produced (8); the revert hotkey then fires. The revert must
    // write the ORIGINAL text pinned to that post-clean changeCount.
    const fakeHelper = join(dir, 'fake-helper.js');
    writeFileSync(
      fakeHelper,
      `#!/usr/bin/env node
const fs = require('fs');
const readline = require('readline');
const text = ${JSON.stringify(wrappedProse)};
fs.appendFileSync(${JSON.stringify(outPath)}, JSON.stringify({ argv: process.argv.slice(2) }) + '\\n');
console.log(JSON.stringify({ type: 'ready' }));
console.log(JSON.stringify({ type: 'clipboard', bundleId: 'com.googlecode.iterm2', appName: 'iTerm2', text, changeCount: 7 }));
let writes = 0;
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  fs.appendFileSync(${JSON.stringify(outPath)}, line + '\\n');
  if (JSON.parse(line).type !== 'write') return;
  writes += 1;
  console.log(JSON.stringify({ type: 'wrote', changeCount: 7 + writes }));
  if (writes === 1) console.log(JSON.stringify({ type: 'hotkey', id: 'revert' }));
});
process.stdin.on('end', () => process.exit(0));
`,
    );
    chmodSync(fakeHelper, 0o755);

    const logLines: string[] = [];
    const watcher = startWatcher({
      helperPath: fakeHelper,
      log: (l) => logLines.push(l),
      mode: 'auto',
      hotkeys: { clean: 'cmd+ctrl+c', revert: 'cmd+ctrl+z' },
    });
    try {
      const deadline = Date.now() + 3000;
      while (
        !logLines.some((l) => l.startsWith('reverted')) &&
        Date.now() < deadline
      ) {
        await new Promise((r) => setTimeout(r, 25));
      }
      const received = readFileSync(outPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));

      // Auto mode has no use for the clean hotkey; only revert is registered.
      expect(received[0].argv).toEqual(['--hotkey', 'revert:cmd+ctrl+z']);
      expect(received.slice(1)).toEqual([
        { type: 'write', text: clean(wrappedProse) + '\n', expectedChangeCount: 7 },
        { type: 'write', text: wrappedProse, expectedChangeCount: 8 },
      ]);
      expect(logLines.join('\n')).toContain('reverted: the clipboard holds the original copy again');
    } finally {
      watcher.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does nothing on hotkeys with nothing to act on', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cleancopy-hotkey-idle-'));
    const outPath = join(dir, 'received.jsonl');

    const fakeHelper = join(dir, 'fake-helper.js');
    writeFileSync(
      fakeHelper,
      `#!/usr/bin/env node
const fs = require('fs');
console.log(JSON.stringify({ type: 'ready' }));
console.log(JSON.stringify({ type: 'hotkey', id: 'clean' }));
console.log(JSON.stringify({ type: 'hotkey', id: 'revert' }));
process.stdin.on('data', (d) => fs.appendFileSync(${JSON.stringify(outPath)}, d));
process.stdin.on('end', () => process.exit(0));
`,
    );
    chmodSync(fakeHelper, 0o755);

    const logLines: string[] = [];
    const watcher = startWatcher({
      helperPath: fakeHelper,
      log: (l) => logLines.push(l),
      mode: 'manual',
      hotkeys: { clean: 'cmd+ctrl+c', revert: 'cmd+ctrl+z' },
    });
    try {
      const deadline = Date.now() + 3000;
      while (
        !logLines.some((l) => l.includes('no cleaned copy to revert')) &&
        Date.now() < deadline
      ) {
        await new Promise((r) => setTimeout(r, 25));
      }
      expect(logLines.join('\n')).toContain('no terminal copy to clean');
      expect(logLines.join('\n')).toContain('no cleaned copy to revert');
      expect(existsSync(outPath)).toBe(false); // not a single write
    } finally {
      watcher.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('forgets the revertible original once a newer copy lands', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cleancopy-revert-expired-'));
    const outPath = join(dir, 'received.jsonl');

    // Clean a terminal copy, then let ANY new copy land (here a non-terminal
    // one), then press revert: the original belongs to a clipboard state
    // that no longer exists, so nothing may be written.
    const fakeHelper = join(dir, 'fake-helper.js');
    writeFileSync(
      fakeHelper,
      `#!/usr/bin/env node
const fs = require('fs');
const readline = require('readline');
const text = ${JSON.stringify(wrappedProse)};
console.log(JSON.stringify({ type: 'ready' }));
console.log(JSON.stringify({ type: 'clipboard', bundleId: 'com.googlecode.iterm2', appName: 'iTerm2', text, changeCount: 7 }));
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  fs.appendFileSync(${JSON.stringify(outPath)}, line + '\\n');
  if (JSON.parse(line).type !== 'write') return;
  console.log(JSON.stringify({ type: 'wrote', changeCount: 8 }));
  console.log(JSON.stringify({ type: 'clipboard', bundleId: 'com.apple.Safari', appName: 'Safari', text: 'something else', changeCount: 9 }));
  console.log(JSON.stringify({ type: 'hotkey', id: 'revert' }));
});
process.stdin.on('end', () => process.exit(0));
`,
    );
    chmodSync(fakeHelper, 0o755);

    const logLines: string[] = [];
    const watcher = startWatcher({
      helperPath: fakeHelper,
      log: (l) => logLines.push(l),
      hotkeys: { revert: 'cmd+ctrl+z' },
    });
    try {
      const deadline = Date.now() + 3000;
      while (
        !logLines.some((l) => l.includes('no cleaned copy to revert')) &&
        Date.now() < deadline
      ) {
        await new Promise((r) => setTimeout(r, 25));
      }
      const received = readFileSync(outPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
      // Only the clean was written; the revert press wrote nothing.
      expect(received).toEqual([
        { type: 'write', text: clean(wrappedProse) + '\n', expectedChangeCount: 7 },
      ]);
    } finally {
      watcher.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('survives a reply racing helper death instead of crashing on EPIPE', async () => {
    // The helper emits a large terminal copy, never reads stdin, and dies.
    // The watcher's cleaned-text reply (bigger than the 64KB pipe buffer)
    // is still pending when the helper's fds close, so the write errors
    // with EPIPE. Unhandled, that is an uncaught stream error that kills
    // the entire daemon instead of letting it restart the helper.
    const dir = mkdtempSync(join(tmpdir(), 'cleancopy-epipe-'));
    const fakeHelper = join(dir, 'dead-pipe-helper.js');
    writeFileSync(
      fakeHelper,
      `#!/usr/bin/env node
const block = ${JSON.stringify(wrappedProse.trim())};
const text = Array(1500).fill(block).join('\\n\\n');
console.log(JSON.stringify({ type: 'ready' }));
console.log(JSON.stringify({ type: 'clipboard', bundleId: 'com.googlecode.iterm2', appName: 'iTerm2', text, changeCount: 3 }));
setTimeout(() => process.exit(0), 300);
`,
    );
    chmodSync(fakeHelper, 0o755);

    const logLines: string[] = [];
    const watcher = startWatcher({
      helperPath: fakeHelper,
      log: (line) => logLines.push(line),
      restartDelayMs: 10_000, // no respawn during the test window
    });
    try {
      const deadline = Date.now() + 3000;
      while (
        !logLines.some((line) => line.startsWith('helper stdin error')) &&
        Date.now() < deadline
      ) {
        await new Promise((r) => setTimeout(r, 25));
      }
      // The reply was attempted (the copy was judged cleanable)...
      expect(logLines.join('\n')).toContain('cleaned copy from iTerm2');
      // ...and the broken pipe became a log line, not a daemon crash.
      expect(logLines.some((line) => line.startsWith('helper stdin error'))).toBe(true);
    } finally {
      watcher.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('gives up when a helper repeatedly says ready and then crashes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cleancopy-crash-loop-'));
    const fakeHelper = join(dir, 'ready-then-crash.js');
    writeFileSync(
      fakeHelper,
      `#!/usr/bin/env node
console.log(JSON.stringify({ type: 'ready' }));
setTimeout(() => process.exit(1), 5);
`,
    );
    chmodSync(fakeHelper, 0o755);

    const logLines: string[] = [];
    let fatal: (error: Error) => void;
    const fatalError = new Promise<Error>((resolve) => {
      fatal = resolve;
    });
    const watcher = startWatcher({
      helperPath: fakeHelper,
      log: (line) => logLines.push(line),
      restartDelayMs: 10,
      maxConsecutiveCrashes: 2,
      onFatal: (error) => fatal(error),
    });

    try {
      const error = await Promise.race([
        fatalError,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('watcher never gave up')), 2000),
        ),
      ]);
      expect(error.message).toBe('helper crashed 2 times in a row; giving up');
      expect(logLines.filter((line) => line === 'helper ready, watching clipboard')).toHaveLength(2);
    } finally {
      watcher.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
