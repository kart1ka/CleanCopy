import {
  configFilePath,
  loadConfig,
  normalizeHotkey,
  saveConfig,
  type Config,
} from '../watcher';
import { runningPid } from './daemon';

// `cleancopy config` — read and change the watcher's settings. The settings
// live in a plain JSON file (configFilePath()), so this command is a
// convenience over hand-editing; both roads lead to the same file.

export const CONFIG_HELP = `cleancopy config — view or change settings

Usage:
  cleancopy config                          show current settings
  cleancopy config mode auto                clean every terminal copy (default)
  cleancopy config mode manual              clean only when the clean hotkey is pressed
  cleancopy config hotkey clean <combo>     set the manual-clean hotkey
  cleancopy config hotkey revert <combo>    set the revert-to-original hotkey
  cleancopy config hotkey <which> off       disable that hotkey

A combo is modifiers + one key, joined by "+": e.g. "cmd+ctrl+c",
"cmd+shift+v", "ctrl+alt+f9". At least one modifier is required.
`;

function show(config: Config): void {
  const clean = config.hotkeys.clean ?? 'off';
  const revert = config.hotkeys.revert ?? 'off';
  process.stdout.write(
    config.mode === 'manual'
      ? `mode:   manual — copies are cleaned only when you press the clean hotkey\n`
      : `mode:   auto — terminal copies are cleaned as they land\n`,
  );
  process.stdout.write(`hotkeys:\n`);
  process.stdout.write(`  clean:  ${clean}${config.mode === 'auto' ? ' (only used in manual mode)' : ''}\n`);
  process.stdout.write(
    `  revert: ${revert}${revert === 'off' ? '' : ' — restores the original of the last cleaned copy'}\n`,
  );
  process.stdout.write(`file:   ${configFilePath()}\n`);
}

function saveAndReport(config: Config): void {
  saveConfig(config);
  show(config);
  if (runningPid() !== null) {
    process.stdout.write(
      'the watcher is running with the old settings — restart it to apply:\n' +
        '  cleancopy stop && cleancopy start\n',
    );
  }
}

function fail(message: string): never {
  process.stderr.write(`${message}\n\n${CONFIG_HELP}`);
  process.exit(1);
}

export function configCommand(args: string[]): void {
  const { config, warnings } = loadConfig();
  for (const warning of warnings) process.stderr.write(`warning: ${warning}\n`);

  if (args.length === 0) {
    show(config);
    return;
  }

  if (args[0] === 'mode') {
    const mode = args[1];
    if (mode !== 'auto' && mode !== 'manual') {
      fail(`mode must be "auto" or "manual", got "${mode ?? ''}"`);
    }
    config.mode = mode;
    if (mode === 'manual' && config.hotkeys.clean === null) {
      process.stderr.write(
        'note: manual mode has no clean hotkey set — nothing will trigger a clean.\n' +
          'set one with: cleancopy config hotkey clean cmd+ctrl+c\n',
      );
    }
    saveAndReport(config);
    return;
  }

  if (args[0] === 'hotkey') {
    const which = args[1];
    const combo = args[2];
    if (which !== 'clean' && which !== 'revert') {
      fail(`hotkey must be "clean" or "revert", got "${which ?? ''}"`);
    }
    if (!combo) fail('missing hotkey combo (or "off")');
    if (combo === 'off') {
      config.hotkeys[which] = null;
    } else {
      try {
        config.hotkeys[which] = normalizeHotkey(combo);
      } catch (err) {
        fail((err as Error).message);
      }
    }
    saveAndReport(config);
    return;
  }

  fail(`unknown config subcommand: ${args[0]}`);
}
