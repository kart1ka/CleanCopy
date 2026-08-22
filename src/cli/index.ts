#!/usr/bin/env node
import * as fs from 'fs';
import * as path from 'path';
import { cleanWithReport } from '../engine';
import { configCommand } from './config';
import { install, runForeground, start, status, stop } from './daemon';
import { doctor, requiredNodeMajor } from './doctor';

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
                                 manual cleans only on double-copy — copy the
                                 same text twice, quickly (cmd+c cmd+c)
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

/**
 * The first argument the command does not recognize, or undefined when they
 * are all known. Every subcommand runs this before doing anything (for
 * `clean`, before stdin is read, so a typo fails fast instead of after a 2 MB
 * paste): a mistyped `--explian` silently cleaning without an explanation
 * looks like the flag does nothing. Pre-1.0 is the only cheap moment to make
 * this strict — after publish, tightening it would break callers.
 */
export function findUnknownArg(args: string[], allowed: string[] = []): string | undefined {
  return args.find((arg) => !allowed.includes(arg));
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

/**
 * The too-old-Node message, or null when this Node will do. npm's `engines`
 * is advisory — installing on old Node only warns — so this gate is the real
 * floor. It must run before any command logic: under Node 16 the first thing
 * doctor used to reach was `structuredClone` inside config loading, so the
 * command whose job is to say "your Node is too old" died with
 * "structuredClone is not defined" instead.
 */
export function nodeTooOldMessage(nodeVersion: string, requiredMajor: number): string | null {
  const major = Number.parseInt(nodeVersion.split('.')[0] ?? '', 10);
  if (Number.isInteger(major) && major >= requiredMajor) return null;
  return (
    `cleancopy requires Node.js ${requiredMajor} or later; this is v${nodeVersion}.\n` +
    'Upgrade Node (e.g. `nvm install ' + String(requiredMajor) + '`) and try again.\n'
  );
}

export async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];

  const tooOld = nodeTooOldMessage(process.versions.node, requiredNodeMajor());
  if (tooOld !== null) {
    process.stderr.write(tooOld);
    process.exitCode = 1;
    return;
  }

  // Unknown-option rejection, uniform across subcommands (F5): the same
  // treatment `stop` has always given `--force`, extended everywhere.
  const rejectUnknown = (name: string, rest: string[], allowed: string[] = []): boolean => {
    const unknown = findUnknownArg(rest, allowed);
    if (unknown === undefined) return false;
    process.stderr.write(`Unknown ${name} option: ${unknown}\n\n${HELP}`);
    process.exitCode = 1;
    return true;
  };

  // A relative state-dir override resolves against each command's cwd, so
  // `start` here and `stop` there would track different pid files. Warn once,
  // up front — resolving cannot fix this, only an absolute path can.
  const stateOverride = process.env.CLEANCOPY_STATE_DIR;
  if (stateOverride && !path.isAbsolute(stateOverride)) {
    process.stderr.write(
      `warning: CLEANCOPY_STATE_DIR is relative ("${stateOverride}") — commands run ` +
        'from different directories will use different state. Use an absolute path.\n',
    );
  }

  if (!command || command === '--help' || command === '-h' || command === 'help') {
    process.stdout.write(HELP);
    return;
  }

  if (command === '--version' || command === '-v' || command === 'version') {
    process.stdout.write(`${packageVersion()}\n`);
    return;
  }

  if (command === 'clean') {
    if (rejectUnknown('clean', args.slice(1), ['--explain'])) return;
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
    if (rejectUnknown('run', args.slice(1))) return;
    runForeground();
    return;
  }
  if (command === 'start') {
    if (rejectUnknown('start', args.slice(1))) return;
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
    if (rejectUnknown('status', args.slice(1))) return;
    status();
    return;
  }
  if (command === 'doctor') {
    if (rejectUnknown('doctor', args.slice(1))) return;
    process.exitCode = doctor(packageVersion());
    return;
  }
  if (command === 'install') {
    if (rejectUnknown('install', args.slice(1))) return;
    await install();
    return;
  }
  if (command === 'config') {
    await configCommand(args.slice(1));
    return;
  }

  process.stderr.write(`Unknown command: ${command}\n\n${HELP}`);
  process.exit(1);
}

if (require.main === module) {
  // When the reader of our output goes away first — `cleancopy status |
  // head -1`, `doctor | grep -q ready`, quitting `less` mid-page — further
  // writes fail with EPIPE. Unhandled, that becomes a 25-line Node crash dump
  // from exactly the commands a worried user pipes into things. The output
  // the reader wanted was already delivered; ending quietly is the only
  // right behaviour. Handled on both streams: stderr can be piped too.
  for (const stream of [process.stdout, process.stderr]) {
    stream.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EPIPE') process.exit(0);
      throw err;
    });
  }

  // A thrown startup error (e.g. the helper binary missing from a broken
  // install) must surface as its one-line message, not an unhandled-rejection
  // stack trace — this is the first thing a user with a broken install sees.
  main().catch((err: unknown) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  });
}
