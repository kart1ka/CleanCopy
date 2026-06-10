import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import * as readline from 'readline';
import { parseHelperMessage, serializeNodeMessage, type NodeMessage } from './protocol';
import { decide } from './decide';
import { extraTerminalsFromEnv } from './terminals';

// Orchestration: spawn the Swift helper, listen for clipboard events, run
// each through decide(), and reply with cleaned text or nothing.
//
// PRIVACY: nothing in this file may ever log, store, or transmit clipboard
// text. The log callback receives event descriptions only (app names, line
// counts, reasons).

export interface WatcherOptions {
  helperPath: string;
  /** Receives one-line event descriptions. Never clipboard contents. */
  log?: (line: string) => void;
  /** Use a private named pasteboard instead of the real clipboard (tests). */
  pasteboard?: string;
  /** Helper poll interval in seconds. */
  pollInterval?: number;
  /** Extra terminal bundle ids beyond the built-in list. */
  extraTerminals?: readonly string[];
  /** Called when the helper keeps crashing and the watcher gives up. */
  onFatal?: (error: Error) => void;
}

// If the helper dies it is restarted, but a helper that can't stay up for
// RESTART_RESET_MS gets only MAX_CONSECUTIVE_CRASHES attempts before the
// watcher gives up (something is genuinely wrong — wrong arch, missing
// pasteboard access — and a tight respawn loop helps nobody).
const RESTART_DELAY_MS = 1000;
const RESTART_RESET_MS = 30_000;
const MAX_CONSECUTIVE_CRASHES = 5;

export interface Watcher {
  stop(): void;
}

export function startWatcher(options: WatcherOptions): Watcher {
  const log = options.log ?? (() => {});
  const extraTerminals = options.extraTerminals ?? extraTerminalsFromEnv();

  let child: ChildProcessWithoutNullStreams | null = null;
  let stopping = false;
  let consecutiveCrashes = 0;
  let lastSpawnAt = 0;
  let restartTimer: NodeJS.Timeout | null = null;

  function sendToHelper(message: NodeMessage): void {
    child?.stdin.write(serializeNodeMessage(message));
  }

  function handleLine(line: string): void {
    const message = parseHelperMessage(line);
    if (!message) return;

    if (message.type === 'ready') {
      consecutiveCrashes = 0;
      log('helper ready, watching clipboard');
      return;
    }
    if (message.type === 'stale') {
      log('skipped a clean: the clipboard changed again before it could be written');
      return;
    }
    if (message.type !== 'clipboard') return;

    // An engine bug must never take the whole daemon down: on any throw the
    // copy is simply left as it was (the golden rule, applied to crashes).
    let decision: ReturnType<typeof decide>;
    try {
      decision = decide(message, extraTerminals);
    } catch (err) {
      log(`engine error, left copy unchanged (${(err as Error).message})`);
      return;
    }
    if (decision.action === 'write') {
      sendToHelper({
        type: 'write',
        text: decision.text,
        expectedChangeCount: message.changeCount,
      });
      log(`cleaned copy from ${message.appName || message.bundleId} (${decision.summary})`);
    } else if (decision.reason !== 'not-terminal') {
      // Terminal copies left alone are worth a log line; non-terminal copies
      // are discarded without a trace — even "ignored Safari" is metadata.
      log(`left copy from ${message.appName || message.bundleId} unchanged (${decision.reason})`);
    }
  }

  function spawnHelper(): void {
    const args: string[] = [];
    if (options.pasteboard) args.push('--pasteboard', options.pasteboard);
    if (options.pollInterval) args.push('--interval', String(options.pollInterval));

    lastSpawnAt = Date.now();
    child = spawn(options.helperPath, args, { stdio: ['pipe', 'pipe', 'pipe'] });

    const rl = readline.createInterface({ input: child.stdout });
    rl.on('line', handleLine);
    child.stderr.on('data', (chunk: Buffer) => {
      log(`helper stderr: ${chunk.toString().trimEnd()}`);
    });

    child.on('error', (err) => {
      log(`helper failed to start: ${err.message}`);
      child = null;
      maybeRestart();
    });
    child.on('exit', (code, signal) => {
      rl.close();
      child = null;
      if (stopping) return;
      log(`helper exited unexpectedly (code=${code}, signal=${signal})`);
      maybeRestart();
    });
  }

  function maybeRestart(): void {
    if (stopping) return;
    if (Date.now() - lastSpawnAt > RESTART_RESET_MS) consecutiveCrashes = 0;
    consecutiveCrashes += 1;
    if (consecutiveCrashes > MAX_CONSECUTIVE_CRASHES) {
      const error = new Error(
        `helper crashed ${MAX_CONSECUTIVE_CRASHES} times in a row; giving up`,
      );
      log(error.message);
      options.onFatal?.(error);
      return;
    }
    restartTimer = setTimeout(spawnHelper, RESTART_DELAY_MS);
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
