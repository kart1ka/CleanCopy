#!/usr/bin/env node
import { cleanWithReport } from '../engine';

// The CLI is deliberately thin. For now it exposes only `clean`, which reads
// text from stdin and prints the cleaned text to stdout — enough to dogfood the
// engine before any background/clipboard machinery exists. start/stop/status
// land later, once the watcher is built.

const HELP = `cleancopy — clean up text copied from the terminal

Usage:
  cleancopy clean [--explain]    read text from stdin, print the cleaned text
  cleancopy --help              show this help

Examples:
  pbpaste | cleancopy clean | pbcopy
  cleancopy clean --explain < sample.txt

--explain prints, per block, what it was judged to be and why (to stderr),
so the cleaned text on stdout stays pipeable.
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

    process.stdout.write(text);
    if (text.length > 0) process.stdout.write('\n');
    return;
  }

  process.stderr.write(`Unknown command: ${command}\n\n${HELP}`);
  process.exit(1);
}

main();
