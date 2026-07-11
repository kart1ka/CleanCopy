import { describe, it, expect, afterEach } from 'vitest';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import {
  parseHelperMessage,
  type ClipboardEvent,
  type HelperMessage,
} from '../src/watcher/protocol';

// Integration test for the Swift helper binary. Two helper instances share a
// private named pasteboard (never the real clipboard): a write made through
// one must show up as a clipboard event on the other — but never on itself,
// which is the no-clean-loop guarantee.
//
// Skipped when the binary has not been built (`npm run build:helper`).

const helperPath = ['bin', '.build/release']
  .map((dir) => join(__dirname, '..', 'helper', dir, 'cleancopy-helper'))
  .find(existsSync);

class Helper {
  readonly child: ChildProcessWithoutNullStreams;
  readonly messages: HelperMessage[] = [];
  readonly exited: Promise<number | null>;

  constructor(binary: string, pasteboard: string, extraArgs: string[] = []) {
    this.child = spawn(binary, [
      '--pasteboard', pasteboard, '--interval', '0.05', ...extraArgs,
    ]);
    createInterface({ input: this.child.stdout }).on('line', (line) => {
      const message = parseHelperMessage(line);
      if (message) this.messages.push(message);
    });
    this.exited = new Promise((resolve) => this.child.on('exit', resolve));
  }

  send(message: object): void {
    this.child.stdin.write(JSON.stringify(message) + '\n');
  }

  async waitFor(predicate: (m: HelperMessage) => boolean, timeoutMs = 3000): Promise<HelperMessage> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const found = this.messages.find(predicate);
      if (found) return found;
      await sleep(25);
    }
    throw new Error(`timed out waiting for message; saw: ${JSON.stringify(this.messages)}`);
  }

  kill(): void {
    this.child.kill('SIGKILL');
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe.skipIf(!helperPath)('cleancopy-helper (integration, private pasteboard)', () => {
  const helpers: Helper[] = [];
  const launch = (pasteboard: string, extraArgs: string[] = []) => {
    const helper = new Helper(helperPath!, pasteboard, extraArgs);
    helpers.push(helper);
    return helper;
  };

  afterEach(() => {
    for (const helper of helpers.splice(0)) helper.kill();
  });

  it('says ready and answers ping', async () => {
    const helper = launch(`cleancopy-test-${process.pid}-ping`);
    await helper.waitFor((m) => m.type === 'ready');
    helper.send({ type: 'ping' });
    await helper.waitFor((m) => m.type === 'pong');
  });

  it('reports changes made by others, never its own writes', async () => {
    const pasteboard = `cleancopy-test-${process.pid}-${Date.now()}`;
    const observer = launch(pasteboard);
    const writer = launch(pasteboard);
    await observer.waitFor((m) => m.type === 'ready');
    await writer.waitFor((m) => m.type === 'ready');

    writer.send({ type: 'write', text: 'wrapped line one\nwrapped line two\n' });
    await writer.waitFor((m) => m.type === 'wrote');

    // The other instance sees the change, text intact (an external change to
    // this pasteboard is indistinguishable from a copy)...
    const event = await observer.waitFor((m) => m.type === 'clipboard');
    expect(event).toMatchObject({
      type: 'clipboard',
      text: 'wrapped line one\nwrapped line two\n',
    });

    // ...but the writer itself stays silent about its own write: this is what
    // prevents clean → write → observe-own-write → clean loops.
    await sleep(300); // several poll intervals
    expect(writer.messages.filter((m) => m.type === 'clipboard')).toEqual([]);
  });

  it('refuses a stale write instead of destroying a newer copy', async () => {
    const pasteboard = `cleancopy-test-${process.pid}-stale-${Date.now()}`;
    const target = launch(pasteboard);
    const writer = launch(pasteboard);
    await target.waitFor((m) => m.type === 'ready');
    await writer.waitFor((m) => m.type === 'ready');

    // Two copies land in quick succession; target reports both.
    writer.send({ type: 'write', text: 'first copy' });
    const first = (await target.waitFor(
      (m) => m.type === 'clipboard' && m.text === 'first copy',
    )) as ClipboardEvent;
    expect(typeof first.changeCount).toBe('number');

    writer.send({ type: 'write', text: 'second copy' });
    const second = (await target.waitFor(
      (m) => m.type === 'clipboard' && m.text === 'second copy',
    )) as ClipboardEvent;

    // Answering the FIRST event now must not clobber the second copy.
    target.send({ type: 'write', text: 'cleaned first', expectedChangeCount: first.changeCount });
    await target.waitFor((m) => m.type === 'stale');

    // Nothing was written: the writer (which sees others' changes) saw none.
    await sleep(300); // several poll intervals
    expect(writer.messages.filter((m) => m.type === 'clipboard')).toEqual([]);

    // Answering the still-current second event goes through.
    target.send({ type: 'write', text: 'cleaned second', expectedChangeCount: second.changeCount });
    await target.waitFor((m) => m.type === 'wrote');
    await writer.waitFor((m) => m.type === 'clipboard' && m.text === 'cleaned second');
  });

  it('reports a failed write and still observes the next external copy', async () => {
    const pasteboard = `cleancopy-test-${process.pid}-write-failure-${Date.now()}`;
    const target = launch(pasteboard, ['--fail-next-write']);
    const writer = launch(pasteboard);
    await target.waitFor((m) => m.type === 'ready');
    await writer.waitFor((m) => m.type === 'ready');

    target.send({ type: 'write', text: 'this write is forced to fail' });
    await target.waitFor((m) => m.type === 'write-failed');

    writer.send({ type: 'write', text: 'new external copy' });
    await writer.waitFor((m) => m.type === 'wrote');
    await target.waitFor((m) => m.type === 'clipboard' && m.text === 'new external copy');
  });

  it('announces an oversized copy instead of silently swallowing it', async () => {
    const pasteboard = `cleancopy-test-${process.pid}-too-large-${Date.now()}`;
    // The cap is in UTF-16 code units, same unit as decide's policy limit.
    const observer = launch(pasteboard, ['--max-text', '64']);
    const writer = launch(pasteboard);
    await observer.waitFor((m) => m.type === 'ready');
    await writer.waitFor((m) => m.type === 'ready');

    writer.send({ type: 'write', text: 'x'.repeat(65) });
    await writer.waitFor((m) => m.type === 'wrote');
    await observer.waitFor((m) => m.type === 'dropped' && m.reason === 'too-large');
    expect(observer.messages.filter((m) => m.type === 'clipboard')).toEqual([]);

    // A copy within the cap still flows normally afterwards.
    writer.send({ type: 'write', text: 'small enough copy' });
    await observer.waitFor((m) => m.type === 'clipboard' && m.text === 'small enough copy');
  });

  it('exits cleanly when its stdin closes (Node side gone)', async () => {
    const helper = launch(`cleancopy-test-${process.pid}-eof`);
    await helper.waitFor((m) => m.type === 'ready');
    helper.child.stdin.end();
    expect(await helper.exited).toBe(0);
  });
});
