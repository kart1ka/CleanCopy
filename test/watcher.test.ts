import { describe, it, expect } from 'vitest';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
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
    const line = JSON.stringify({ type: 'clipboard', bundleId: TERMINAL, appName: 'iTerm2', text });
    expect(parseHelperMessage(line)).toEqual({
      type: 'clipboard',
      bundleId: TERMINAL,
      appName: 'iTerm2',
      text,
    });
  });

  it('rejects malformed lines instead of throwing', () => {
    expect(parseHelperMessage('')).toBeNull();
    expect(parseHelperMessage('not json')).toBeNull();
    expect(parseHelperMessage('42')).toBeNull();
    expect(parseHelperMessage('{"type":"clipboard"}')).toBeNull(); // no text
    expect(parseHelperMessage('{"type":"mystery"}')).toBeNull();
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
console.log(JSON.stringify({ type: 'clipboard', bundleId: 'com.apple.Safari', appName: 'Safari', text }));
console.log(JSON.stringify({ type: 'clipboard', bundleId: 'com.googlecode.iterm2', appName: 'iTerm2', text }));
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

      // Exactly one write — for the terminal copy, with the engine's output.
      expect(received).toEqual([{ type: 'write', text: clean(wrappedProse) + '\n' }]);

      // The log knows what happened but never what the text was — and the
      // discarded non-terminal copy left no trace at all.
      expect(logLines.join('\n')).toContain('cleaned copy from iTerm2');
      expect(logLines.join('\n')).not.toContain('Safari');
      expect(logLines.join('\n')).not.toContain('cleanup engine'); // words from the copied text
    } finally {
      watcher.stop();
    }
  });
});
