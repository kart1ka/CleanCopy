#!/usr/bin/env node
import * as fs from 'fs';
import * as path from 'path';
import { cleanWithReport } from '../engine';
import { configCommand } from './config';
import { install, runForeground, start, status, stop } from './daemon';
import { doctor } from './doctor';

// The CLI has two faces: `clean` pipes text through the engine once (the
// dogfooding path), and start/stop/status/run manage the clipboard watcher —
// the Swift helper plus this process deciding what to clean.

const HELP = `cleancopy — clean up text copied from the terminal

Usage:
  cleancopy clean [--explain]    read text from stdin, print the cleaned text
  cleancopy start                start watching the clipboard (background)
  cleancopy stop                 stop the background watcher
  cleancopy stop --disable-autostart
                                 stop it and remove login autostart
  cleancopy status               is the watcher running?
  cleancopy doctor               check whether this installation is ready
  cleancopy install              start automatically at login (launchd)
  cleancopy run                  run the watcher in the foreground (debugging)
  cleancopy config               view or change settings (see below)
  cleancopy --version            show the installed version
  cleancopy --help               show this help

Examples:
  pbpaste | cleancopy clean | pbcopy
  cleancopy clean --explain < sample.txt

--explain prints, per block, what it was judged to be and why (to stderr),
so the cleaned text on stdout stays pipeable.

Settings (cleancopy config …):
  mode auto|manual               auto (default) cleans every terminal copy;
                                 manual cleans only when the clean hotkey
                                 (default cmd+ctrl+c) is pressed after a copy
  hotkey clean <combo>|off       the manual-clean hotkey
  hotkey revert <combo>|off      pressing it (default cmd+ctrl+z) after a
                                 clean puts the original copy back

The watcher cleans terminal copies automatically. Everything stays on this
machine; the event log (~/.cleancopy/cleancopy.log) records only events like
"cleaned copy from iTerm2", never clipboard contents.
`;

/** Read the version from the package that owns this CLI, in source or dist. */
export function packageVersion(): string {
  try {
    const packagePath = path.resolve(__dirname, '..', '..', 'package.json');
    const parsed: unknown = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
    if (typeof parsed === 'object' && parsed !== null) {
      const version = (parsed as Record<string, unknown>).version;
      if (typeof version === 'string' && version.length > 0) return version;
    }
  } catch {
    // A damaged installation is reported as unknown instead of throwing a
    // JSON or filesystem stack trace from the simplest diagnostic command.
  }
  return 'unknown';
}

export function parseStopArgs(args: string[]): { disableAutostart: boolean } {
  const unknown = args.find((arg) => arg !== '--disable-autostart');
  if (unknown) throw new Error(`Unknown stop option: ${unknown}`);
  return { disableAutostart: args.includes('--disable-autostart') };
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve('');
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => (data += chunk));
    process.stdin.on('end', () => resolve(data));
  });
}

export async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command || command === '--help' || command === '-h' || command === 'help') {
    process.stdout.write(HELP);
    return;
  }

  if (command === '--version' || command === '-v' || command === 'version') {
    process.stdout.write(`${packageVersion()}\n`);
    return;
  }

  if (command === 'clean') {
    const explain = args.includes('--explain');
    const input = await readStdin();
    const { text, reports, inferredWidth } = cleanWithReport(input, { explain });

    if (explain) {
      process.stderr.write(`inferred wrap column: ${inferredWidth ?? 'none established'}\n`);
      for (const r of reports) {
        const head = r.block.lines[0] ?? '';
        const preview = head.slice(0, 50) + (head.length > 50 ? '…' : '');
        const c = r.classification;
        process.stderr.write(
          `[${c.type}] reflow=${c.reflowable} conf=${c.confidence} ` +
            `(${c.signals.join(', ')})  "${preview}"\n`,
        );
        for (const j of r.joins ?? []) {
          const verdict = j.joined ? 'join' : 'keep';
          const why = j.signals.length > 0 ? j.signals.join(', ') : 'no evidence';
          process.stderr.write(
            `    block L${j.line + 1}→L${j.line + 2} ${verdict} score=${j.score} [${why}]\n`,
          );
        }
      }
      process.stderr.write('\n');
    }

    // Byte-faithful: clean() preserves the input's trailing-newline state, so
    // the pbpaste | cleancopy clean | pbcopy round-trip is exactly what the
    // watcher would write — no newline added to already-clean content.
    process.stdout.write(text);
    return;
  }

  if (command === 'run') {
    runForeground();
    return;
  }
  if (command === 'start') {
    await start();
    return;
  }
  if (command === 'stop') {
    let options: { disableAutostart: boolean };
    try {
      options = parseStopArgs(args.slice(1));
    } catch (err) {
      process.stderr.write(`${(err as Error).message}\n\n${HELP}`);
      process.exitCode = 1;
      return;
    }
    await stop(options);
    return;
  }
  if (command === 'status') {
    status();
    return;
  }
  if (command === 'doctor') {
    process.exitCode = doctor(packageVersion());
    return;
  }
  if (command === 'install') {
    await install();
    return;
  }
  if (command === 'config') {
    configCommand(args.slice(1));
    return;
  }

  process.stderr.write(`Unknown command: ${command}\n\n${HELP}`);
  process.exit(1);
}

if (require.main === module) {
  void main();
}
