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
- Node.js 18 or later

The automatic clipboard watcher is macOS-only. The package refuses installation
on other operating systems rather than installing a command that cannot work.

## Install

```bash
npm install --global cleancopy
```

Confirm that the native helper is available:

```bash
cleancopy status
```

## Use it

### Clean text once

```bash
pbpaste | cleancopy clean | pbcopy
```

To see how each block was classified without contaminating stdout:

```bash
cleancopy clean --explain < copied-output.txt
```

### Clean terminal copies automatically

```bash
cleancopy start     # start the background watcher
cleancopy status    # show watcher, helper, log, and autostart status
cleancopy stop      # stop the background watcher
```

With the watcher running, copies made while a supported terminal is frontmost
are cleaned in place. Copy, then paste as usual.

To start CleanCopy automatically when you log in:

```bash
cleancopy install
cleancopy uninstall # remove login autostart later
```

`cleancopy run` starts the watcher in the foreground and prints event lines;
it is useful when debugging. `cleancopy --help` lists every command.

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
`cleancopy install`; the launch agent preserves it. Re-run `cleancopy install`
after changing the variable or after switching Node installations.

Nothing leaves your machine. Clipboard contents are never written to disk. The
event log at `~/.cleancopy/cleancopy.log` records content-free summaries such
as `cleaned copy from iTerm2 (12 lines -> 4)`. Pasteboard items marked
concealed or transient, such as password-manager items, are never read.

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

Developing and running the test suite requires Node.js 20 or later. The
published CLI itself continues to support Node.js 18 or later.

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
