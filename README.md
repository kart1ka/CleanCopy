# CleanCopy

Clean up text copied from a terminal so it pastes neatly into other apps.

Terminal copies often arrive with a stray left margin, sentences split at the
window width, uneven spacing, and invisible characters. CleanCopy fixes those
problems while deliberately leaving code, tables, error output, and commands
alone.

CleanCopy is a macOS command-line app. It ships a native clipboard helper for
both Apple Silicon and Intel Macs, plus a pure TypeScript cleanup engine.

## Requirements

- macOS 12 (Monterey) or later
- Node.js 22 or later

The automatic clipboard watcher is macOS-only. The package refuses installation
on other operating systems rather than installing a command that cannot work.

## Install

```bash
npm install --global cleancopy
```

Confirm the installed version and check that the native helper, configuration,
and state directory are ready:

```bash
cleancopy --version
cleancopy doctor
```

## Use it

### Clean terminal copies automatically

```bash
cleancopy start     # start the background watcher
cleancopy status    # show watcher, helper, log, and autostart status
cleancopy stop      # stop the background watcher
```

With the watcher running, copies made while a supported terminal is frontmost
are cleaned in place. Copy, then paste as usual. If a clean ever goes wrong,
press `cmd+ctrl+z` and the original copy is back (the revert hotkey, below).

The default `auto` mode cleans eligible terminal copies as they land. To clean
only when you ask, switch to `manual` mode:

```bash
cleancopy config mode manual
```

In manual mode the gesture is a double copy: press Cmd+C twice in quick
succession, like a double-click, with the same text selected. The first press
copies the text raw; the second cleans it. That second copy is the entire
trigger. There is no extra hotkey to learn
and no macOS permission to grant, because CleanCopy detects the repeat from
the clipboard itself. A near-instant second copy (under about 150 ms, faster
than a person presses twice) is deliberately ignored, so clipboard utilities
that rewrite every copy the moment it lands cannot trigger cleans you never
asked for.

Changed settings apply immediately: if the watcher is running, `cleancopy
config` restarts it for you.

The revert hotkey works in both modes. It (default `cmd+ctrl+z`; change it
with `cleancopy config hotkey revert <combo>`, or disable it with `off`)
restores the original text only when the cleaned copy is still current; it
never overwrites a newer clipboard item.

If the revert hotkey does nothing when pressed, another app probably owns that
combo already. macOS gives the keystroke to whichever app registered it first
and reports no conflict to anyone, so CleanCopy cannot warn you — pick a
different combo (`cleancopy config hotkey revert cmd+ctrl+shift+z`). Run
`cleancopy config` to see the active mode and hotkey.

To start CleanCopy automatically when you log in:

```bash
cleancopy autostart on
cleancopy autostart off   # stop it and remove login autostart later
```

`cleancopy autostart` on its own shows whether login autostart is enabled.

### Clean text once, without the watcher

Copy something from a terminal, then run:

```bash
pbpaste | cleancopy clean | pbcopy
```

Your clipboard now holds the cleaned version; paste it anywhere.

### Debugging

`cleancopy run` starts the watcher in the foreground and prints event lines.
To see why a copy was cleaned the way it was, save it to a file and ask for an
explanation — the verdict for each block goes to stderr, so the cleaned text on
stdout stays pipeable:

```bash
pbpaste > copied.txt
cleancopy clean --explain < copied.txt
```

`cleancopy --help` lists every command.

## Uninstall

Remove the background process, login autostart, and global npm package:

```bash
cleancopy stop --disable-autostart
npm uninstall --global cleancopy
```

Plain `cleancopy stop` stops the current watcher but keeps login autostart, so
it can start again after your next login. The `--disable-autostart` option also
removes that login configuration. Your settings and the content-free event log
remain in `~/.cleancopy`; delete that directory yourself if you do not want to
keep them.

## Safety and privacy

CleanCopy only considers copies made when a supported terminal is frontmost:
Terminal, iTerm2, Alacritty, kitty, WezTerm, Warp, Hyper, Ghostty, Termius,
and a few common variants. Everything else is discarded before its text is
read. Editors with built-in terminals are intentionally excluded, because
their copies may be source code from an editor pane.

Add an unsupported terminal by bundle identifier:

```bash
export CLEANCOPY_TERMINALS=com.example.my-terminal
cleancopy start
```

For a login-started watcher, set that environment variable before running
`cleancopy autostart on`; the launch agent preserves it. Re-run
`cleancopy autostart on` after changing the variable or after switching Node
installations.

Nothing leaves your machine. Clipboard contents are never written to disk. The
event log at `~/.cleancopy/cleancopy.log` records content-free summaries such
as `cleaned copy from iTerm2 (12 lines -> 4)`. Pasteboard items marked
concealed or transient, such as password-manager items, are never read.

The bundled native helper is a small open-source Swift binary (`helper/` in
this repository), compiled in CI and shipped inside the npm package. It is
**not code-signed or notarized**: files installed through npm do not carry the
macOS quarantine attribute, so Gatekeeper does not block it, but you are
trusting the npm package rather than an Apple-verified signature. The npm
release is published with provenance, so you can verify the package was built
from this repository — or build the helper yourself with
`npm run build:helper`.

## How it works

The cleanup engine is a pure text transformation with four stages:

1. **Normalize** whitespace, invisible characters, exotic spaces, and a
   shared left margin.
2. **Segment** the text into blocks at blank lines.
3. **Classify** each block as prose, list, code, table, trace, data, or unsure.
4. **Transform** only confidently identified prose and lists; preserve
   everything else verbatim.

The golden rule is simple: when unsure, CleanCopy leaves a block unchanged.

## Development

Developing, testing, and using the published CLI requires Node.js 22 or later.

```bash
npm install
npm test
npm run typecheck
npm run build
npm run build:helper
npm run release:check
```

`release:check` builds the universal native helper, runs the full suite, and
shows the exact npm tarball contents. The helper integration tests run after a
helper build and use a private pasteboard, never your real clipboard.

Security issues should be reported privately as described in
[SECURITY.md](SECURITY.md).

## Contributing

Real-world terminal output makes the cleanup engine safer. Add a fixture:

```
test/fixtures/<short-name>/input.txt
test/fixtures/<short-name>/expected.txt
```

Then run `npm test`. In particular, fixtures that protect code, logs, and
tables from accidental prose reflow are valuable.

## License

[MIT](LICENSE)
