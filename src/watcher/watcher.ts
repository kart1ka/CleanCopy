import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import * as readline from 'readline';
import {
  parseHelperMessage,
  serializeNodeMessage,
  type ClipboardEvent,
  type NodeMessage,
} from './protocol';
import { decide } from './decide';
import { extraTerminalsFromEnv, isTerminalApp } from './terminals';
import type { CleanMode, Hotkeys } from './config';

// Orchestration: spawn the Swift helper, listen for clipboard events, run
// each through decide(), and reply with cleaned text or nothing. In manual
// mode a copy is cleaned only on the double-copy gesture — the same text
// copied twice in quick succession (cmd+c copies raw, cmd+c cmd+c cleans) —
// detected from the pasteboard alone, so it needs no hotkey, no permission,
// and no per-terminal support. In both modes the revert hotkey restores the
// original of the last cleaned copy.
//
// PRIVACY: nothing in this file may ever log, store, or transmit clipboard
// text. The log callback receives event descriptions only (app names, line
// counts, reasons). Original text held for the revert hotkey lives only in
// this process's memory and only until the clipboard moves on.

export interface WatcherOptions {
  helperPath: string;
  /** Receives one-line event descriptions. Never clipboard contents. */
  log?: (line: string) => void;
  /** Use a private named pasteboard instead of the real clipboard (tests). */
  pasteboard?: string;
  /** Helper poll interval in seconds. */
  pollInterval?: number;
  /** auto (default): clean every terminal copy. manual: only on double-copy. */
  mode?: CleanMode;
  /** Global hotkeys to register (revert is the only one). */
  hotkeys?: Partial<Hotkeys>;
  /** Extra terminal bundle ids beyond the built-in list. */
  extraTerminals?: readonly string[];
  /** Called when the helper keeps crashing and the watcher gives up. */
  onFatal?: (error: Error) => void;
  /** Restart delay override, primarily for deterministic tests. */
  restartDelayMs?: number;
  /** Crash limit override, primarily for deterministic tests. */
  maxConsecutiveCrashes?: number;
  /** Double-copy gesture window overrides, primarily for deterministic tests. */
  doubleCopyMinGapMs?: number;
  doubleCopyMaxGapMs?: number;
}

// If the helper dies it is restarted, but a helper that can't stay up for
// RESTART_RESET_MS gets only MAX_CONSECUTIVE_CRASHES attempts before the
// watcher gives up (something is genuinely wrong — wrong arch, missing
// pasteboard access — and a tight respawn loop helps nobody).
const RESTART_DELAY_MS = 1000;
const RESTART_RESET_MS = 30_000;
const MAX_CONSECUTIVE_CRASHES = 5;

// The double-copy gesture: in manual mode, the same text copied twice within
// this window means "clean it". The timestamps compared are when the helper's
// poll REPORTED each copy, not when the keys were pressed, so both bounds are
// quantized by the poll interval (100 ms).
//
// The lower bound is a safety guard, not ergonomics: clipboard utilities that
// rewrite every copy instantly (Pure Paste stripping formatting, clipboard
// managers) produce a copy-then-identical-copy pair a few milliseconds apart
// — accepting those would silently turn manual mode into auto mode for their
// users. Tool rewrites are observed ≤ ~1 poll apart; deliberate human
// double-presses almost always ≥ 150 ms. A too-fast pair re-anchors on the
// second copy, so a genuine press right after a tool rewrite still pairs.
const DOUBLE_COPY_MIN_GAP_MS = 130;
const DOUBLE_COPY_MAX_GAP_MS = 600;

export interface Watcher {
  stop(): void;
}

export function startWatcher(options: WatcherOptions): Watcher {
  const log = options.log ?? (() => {});
  const extraTerminals = options.extraTerminals ?? extraTerminalsFromEnv();
  const restartDelayMs = options.restartDelayMs ?? RESTART_DELAY_MS;
  const maxConsecutiveCrashes =
    options.maxConsecutiveCrashes ?? MAX_CONSECUTIVE_CRASHES;
  const mode = options.mode ?? 'auto';
  const revertHotkey = options.hotkeys?.revert ?? null;
  const doubleCopyMinGapMs = options.doubleCopyMinGapMs ?? DOUBLE_COPY_MIN_GAP_MS;
  const doubleCopyMaxGapMs = options.doubleCopyMaxGapMs ?? DOUBLE_COPY_MAX_GAP_MS;

  let child: ChildProcessWithoutNullStreams | null = null;
  let stopping = false;
  let consecutiveCrashes = 0;
  let lastSpawnAt = 0;
  let restartTimer: NodeJS.Timeout | null = null;

  // The original of the last cleaned copy, restorable while the cleaned text
  // is still on the clipboard (guarded by changeCount). In-memory only.
  let revertible: RevertState | null = null;
  // Manual mode: the previous terminal copy, held only to recognize the
  // double-copy gesture (same text again = clean it). In-memory only, and
  // replaced or cleared by whatever copy comes next.
  let doubleCopyAnchor: { text: string; at: number } | null = null;
  // Writes in flight. The helper handles messages serially and answers each
  // write with exactly one wrote/stale/write-failed, in order — so a FIFO
  // queue is enough to know which write an ack belongs to.
  type RevertState = { original: string; changeCount?: number };
  let pendingWrites: Array<
    | { kind: 'clean'; original: string }
    | { kind: 'revert'; state: RevertState }
  > = [];

  function sendToHelper(message: NodeMessage): void {
    child?.stdin.write(serializeNodeMessage(message));
  }

  /** Run the engine over a terminal copy and, if it changed anything, write. */
  function cleanEvent(event: ClipboardEvent): void {
    // An engine bug must never take the whole daemon down: on any throw the
    // copy is simply left as it was (the golden rule, applied to crashes).
    let decision: ReturnType<typeof decide>;
    try {
      decision = decide(event, extraTerminals);
    } catch (err) {
      log(`engine error, left copy unchanged (${(err as Error).message})`);
      return;
    }
    if (decision.action === 'write') {
      pendingWrites.push({ kind: 'clean', original: event.text });
      sendToHelper({
        type: 'write',
        text: decision.text,
        expectedChangeCount: event.changeCount,
      });
      log(`cleaned copy from ${event.appName || event.bundleId} (${decision.summary})`);
    } else if (decision.reason !== 'not-terminal') {
      // Terminal copies left alone are worth a log line; non-terminal copies
      // are discarded without a trace — even "ignored Safari" is metadata.
      log(`left copy from ${event.appName || event.bundleId} unchanged (${decision.reason})`);
    }
  }

  function handleHotkey(id: string): void {
    if (id === 'revert') {
      if (!revertible) {
        log('revert hotkey pressed, but there is no cleaned copy to revert');
        return;
      }
      pendingWrites.push({ kind: 'revert', state: revertible });
      // expectedChangeCount pins the revert to our own cleaned text: if the
      // user copied anything since, the helper refuses instead of clobbering.
      sendToHelper({
        type: 'write',
        text: revertible.original,
        expectedChangeCount: revertible.changeCount,
      });
      revertible = null;
      return;
    }
    log(`ignored unknown hotkey "${id}"`);
  }

  function handleLine(line: string): void {
    const message = parseHelperMessage(line);
    if (!message) return;

    if (message.type === 'ready') {
      log('helper ready, watching clipboard');
      return;
    }
    if (message.type === 'wrote') {
      const answered = pendingWrites.shift();
      if (answered?.kind === 'clean') {
        // Only a changeCount-carrying ack makes a revert safe to offer: with
        // no count to pin it to, a revert could land on a newer copy.
        revertible =
          typeof message.changeCount === 'number'
            ? { original: answered.original, changeCount: message.changeCount }
            : null;
      } else if (answered?.kind === 'revert') {
        log('reverted: the clipboard holds the original copy again');
      }
      return;
    }
    if (message.type === 'stale') {
      pendingWrites.shift();
      log('skipped a write: the clipboard changed again before it could land');
      return;
    }
    if (message.type === 'write-failed') {
      const answered = pendingWrites.shift();
      // The helper clears the pasteboard before writing, so a failed write
      // leaves it EMPTY — whichever kind failed, the user's original text now
      // exists only here. Offer it on the revert hotkey, pinned to the
      // post-clear changeCount the helper reports, so the restore can never
      // land on top of a copy made after the failure.
      const original =
        answered?.kind === 'clean' ? answered.original : answered?.state.original;
      if (original !== undefined && typeof message.changeCount === 'number') {
        revertible = { original, changeCount: message.changeCount };
        // Promise only what is reachable: without a revert hotkey there is no
        // way to trigger the restore, and even with one the restore is
        // refused (not forced) if the clipboard has moved on since.
        log(
          revertHotkey
            ? `a write failed and the clipboard may now be empty — press ${revertHotkey} to restore the original (refused if the clipboard has changed since)`
            : 'a write failed and the clipboard may now be empty; no revert hotkey is configured to restore the original',
        );
      } else {
        // No count to pin a restore to (helper predates the ack field).
        if (answered?.kind === 'revert' && revertible === null) revertible = answered.state;
        log('skipped a write: the native helper could not write to the clipboard');
      }
      return;
    }
    if (message.type === 'dropped') {
      log(`left a copy unchanged: the helper withheld it (${message.reason})`);
      return;
    }
    if (message.type === 'hotkey') {
      handleHotkey(message.id);
      return;
    }
    if (message.type === 'hotkey-failed') {
      // Measured reality (F14): macOS only refuses a duplicate registration
      // within this process — clean and revert set to the same combo. A combo
      // another app owns registers "successfully" and the presses simply go
      // to that app; no failure is reported anywhere, so this message must
      // not claim otherwise.
      log(
        `could not register the ${message.id} hotkey — are clean and revert set to the same combo? ` +
          'check with `cleancopy config`',
      );
      return;
    }
    if (message.type !== 'clipboard') return;

    // Any new copy supersedes what came before it: the last clean is no
    // longer the clipboard's content, and an intervening copy (any app)
    // breaks a double-copy pair — the two halves of the gesture must be
    // consecutive.
    revertible = null;
    const previous = doubleCopyAnchor;
    doubleCopyAnchor = null;

    if (mode === 'manual') {
      // Same privacy gate as decide(): non-terminal copies are discarded
      // before the text is examined or held in any way.
      if (!isTerminalApp(message.bundleId, extraTerminals)) return;
      const now = Date.now();
      if (previous && previous.text === message.text) {
        const gap = now - previous.at;
        if (gap >= doubleCopyMinGapMs && gap <= doubleCopyMaxGapMs) {
          // The double-copy gesture: clean, pinned to the second copy's
          // changeCount. The anchor stays cleared — a third identical copy
          // starts a fresh pair instead of chaining cleans.
          cleanEvent(message);
          return;
        }
      }
      // First copy of a potential pair — or a same-text copy outside the
      // window (too slow: an unrelated re-copy; too fast: a clipboard tool's
      // instant rewrite, which must not count as the gesture). Either way it
      // becomes the new anchor, so the user's next copy is judged against it.
      doubleCopyAnchor = { text: message.text, at: now };
      log(
        `terminal copy from ${message.appName || message.bundleId} noted` +
          ' — copy it again to clean it',
      );
      return;
    }
    cleanEvent(message);
  }

  function spawnHelper(): void {
    const args: string[] = [];
    if (options.pasteboard) args.push('--pasteboard', options.pasteboard);
    if (options.pollInterval) args.push('--interval', String(options.pollInterval));
    if (revertHotkey) args.push('--hotkey', `revert:${revertHotkey}`);

    lastSpawnAt = Date.now();
    child = spawn(options.helperPath, args, { stdio: ['pipe', 'pipe', 'pipe'] });

    const rl = readline.createInterface({ input: child.stdout });
    rl.on('line', handleLine);
    child.stderr.on('data', (chunk: Buffer) => {
      log(`helper stderr: ${chunk.toString().trimEnd()}`);
    });
    // A write can race the helper dying: without a listener, the resulting
    // EPIPE is an unhandled stream error that takes the whole daemon down.
    // Log it and let the 'exit' handler drive the restart.
    child.stdin.on('error', (err) => {
      log(`helper stdin error: ${err.message}`);
    });

    child.on('error', (err) => {
      log(`helper failed to start: ${err.message}`);
      child = null;
      maybeRestart();
    });
    child.on('exit', (code, signal) => {
      rl.close();
      child = null;
      // Acks for in-flight writes died with the helper; a stale queue would
      // misattribute every ack the next helper sends. (revertible and the
      // double-copy anchor survive: they are pasteboard state and wall-clock
      // time, not helper state, so the stale-write guard and the gesture
      // window still protect them.)
      pendingWrites = [];
      if (stopping) return;
      log(`helper exited unexpectedly (code=${code}, signal=${signal})`);
      maybeRestart();
    });
  }

  function maybeRestart(): void {
    if (stopping) return;
    if (Date.now() - lastSpawnAt > RESTART_RESET_MS) consecutiveCrashes = 0;
    consecutiveCrashes += 1;
    if (consecutiveCrashes >= maxConsecutiveCrashes) {
      const error = new Error(
        `helper crashed ${maxConsecutiveCrashes} times in a row; giving up`,
      );
      log(error.message);
      options.onFatal?.(error);
      return;
    }
    restartTimer = setTimeout(spawnHelper, restartDelayMs);
  }

  spawnHelper();

  return {
    stop(): void {
      stopping = true;
      if (restartTimer) clearTimeout(restartTimer);
      if (child) {
        // Closing stdin is the polite shutdown — the helper exits on EOF.
        child.stdin.end();
        const c = child;
        setTimeout(() => c.kill('SIGTERM'), 500).unref();
      }
    },
  };
}
