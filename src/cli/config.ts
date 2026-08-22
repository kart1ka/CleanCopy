import {
  configFilePath,
  loadConfig,
  normalizeHotkey,
  saveConfig,
  type Config,
} from '../watcher';
import { runningPid, start, stop } from './daemon';

// `cleancopy config` — read and change the watcher's settings. The settings
// live in a plain JSON file (configFilePath()), so this command is a
// convenience over hand-editing; both roads lead to the same file.

export const CONFIG_HELP = `cleancopy config — view or change settings

Usage:
  cleancopy config                          show current settings
  cleancopy config mode auto                clean every terminal copy (default)
  cleancopy config mode manual              clean only on double-copy (copy the
                                            same text twice, quickly)
  cleancopy config hotkey revert <combo>    set the revert-to-original hotkey
  cleancopy config hotkey revert off        disable it

A combo is modifiers + one key, joined by "+": e.g. "cmd+ctrl+z",
"cmd+shift+v", "ctrl+opt+f9". At least one modifier is required.
`;

function show(config: Config): void {
  const revert = config.hotkeys.revert ?? 'off';
  process.stdout.write(
    config.mode === 'manual'
      ? `mode:   manual — a copy is cleaned only when you copy the same text twice, quickly\n`
      : `mode:   auto — terminal copies are cleaned as they land\n`,
  );
  process.stdout.write(`hotkeys:\n`);
  process.stdout.write(
    `  revert: ${revert}${revert === 'off' ? '' : ' — restores the original of the last cleaned copy'}\n`,
  );
  process.stdout.write(`file:   ${configFilePath()}\n`);
}

async function saveAndReport(config: Config): Promise<void> {
  saveConfig(config);
  show(config);
  // A running watcher reads its settings once at startup, so without this the
  // file and the actual behaviour disagree until the user acts on a notice
  // they may never read ("the config says manual but it still auto-cleans").
  // We already know a watcher is running — restart it ourselves. The restart
  // drops what the old process held in memory: the original held for revert.
  // It is momentary, and the user just changed a setting on purpose; say it
  // anyway.
  if (runningPid() !== null) {
    process.stdout.write('restarting the watcher so the new settings take effect…\n');
    await stop({ disableAutostart: false });
    await start();
    process.stdout.write(
      'settings are live (a revertible original, if any, was discarded by the restart)\n',
    );
  }
}

function fail(message: string): never {
  process.stderr.write(`${message}\n\n${CONFIG_HELP}`);
  process.exit(1);
}

export async function configCommand(args: string[]): Promise<void> {
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
    await saveAndReport(config);
    return;
  }

  if (args[0] === 'hotkey') {
    const which = args[1];
    const combo = args[2];
    if (which !== 'revert') {
      fail(`hotkey must be "revert", got "${which ?? ''}"`);
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
    await saveAndReport(config);
    return;
  }

  fail(`unknown config subcommand: ${args[0]}`);
}
