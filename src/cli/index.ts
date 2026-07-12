#!/usr/bin/env node
import { cleanWithReport } from '../engine';
import { install, runForeground, start, status, stop, uninstall } from './daemon';

// The CLI has two faces: `clean` pipes text through the engine once (the
// dogfooding path), and start/stop/status/run manage the clipboard watcher —
// the Swift helper plus this process deciding what to clean.

const HELP = `cleancopy — clean up text copied from the terminal

Usage:
  cleancopy clean [--explain]    read text from stdin, print the cleaned text
  cleancopy start                start watching the clipboard (background)
  cleancopy stop                 stop the background watcher
  cleancopy status               is the watcher running?
  cleancopy install              start automatically at login (launchd)
  cleancopy uninstall            stop starting automatically at login
  cleancopy run                  run the watcher in the foreground (debugging)
  cleancopy --help               show this help

Examples:
  pbpaste | cleancopy clean | pbcopy
  cleancopy clean --explain < sample.txt

--explain prints, per block, what it was judged to be and why (to stderr),
so the cleaned text on stdout stays pipeable.

The watcher cleans terminal copies automatically. Everything stays on this
machine; the event log (~/.cleancopy/cleancopy.log) records only events like
"cleaned copy from iTerm2", never clipboard contents.
`;

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve('');
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => (data += chunk));
    process.stdin.on('end', () => resolve(data));
  });
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command || command === '--help' || command === '-h' || command === 'help') {
    process.stdout.write(HELP);
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
    await stop();
    return;
  }
  if (command === 'status') {
    status();
    return;
  }
  if (command === 'install') {
    await install();
    return;
  }
  if (command === 'uninstall') {
    uninstall();
    return;
  }

  process.stderr.write(`Unknown command: ${command}\n\n${HELP}`);
  process.exit(1);
}

main();
