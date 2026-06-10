# CleanCopy

Cleans up text copied from a terminal so it pastes neatly into other apps.

Terminal copies often arrive with a stray left margin, sentences chopped onto
extra lines by the window width, odd spacing, and invisible characters.
CleanCopy fixes that — **without damaging code, tables, error output, or
commands**.

> Status: the cleanup **engine**, its test corpus, the `clean` CLI, and the
> background **clipboard watcher** (a tiny Swift helper + Node orchestration)
> all exist and work. Still to come: install polish (launchd autostart, npm
> publish with a prebuilt helper). See `CLAUDE.md` for the full architecture.

## Try it

```bash
npm install

# clean some text from stdin
pbpaste | npm run -s clean | pbcopy

# see why each block was treated the way it was
npm run -s clean -- --explain < test/fixtures/05-mixed-content/input.txt
```

## Automatic mode (the actual product)

Build the native helper once (needs Xcode command-line tools), then start the
watcher. From then on, anything you copy in a terminal is cleaned in place —
copy, paste, done.

```bash
npm run build:helper     # compile the Swift clipboard helper
npm run build            # compile the CLI

node dist/cli/index.js start    # begin watching the clipboard
node dist/cli/index.js status   # is it running?
node dist/cli/index.js stop     # stop it
node dist/cli/index.js run      # foreground mode, events printed live (debugging)
```

(After `npm install -g` / `npm link`, those become `cleancopy start` etc.)

Only copies made while a known terminal (Terminal, iTerm2, Alacritty, kitty,
WezTerm, Warp, Hyper, Ghostty, …) is frontmost are touched; everything else is
discarded unread the moment it is seen. Set `CLEANCOPY_TERMINALS` to a
comma-separated list of bundle ids to add your terminal.

**Privacy:** nothing ever leaves the machine. Clipboard contents are never
written to disk; the event log (`~/.cleancopy/cleancopy.log`) records only
lines like `cleaned copy from iTerm2 (12 lines -> 4)`. Pasteboard items marked
concealed/transient (password managers) are never read.

## Develop

```bash
npm test                 # run the fixture + property tests (plus helper integration tests, if built)
npm run test:watch       # re-run on change
npx vitest run -t 03     # run a single fixture by name
npm run typecheck        # type-check only
npm run build            # compile to dist/
npm run build:helper     # build the Swift helper into helper/bin/
```

## How the engine works

Pure text in, text out (no clipboard or OS code). Four steps:

1. **normalize** — always-safe tidy-ups (whitespace, invisible characters,
   exotic spaces, and removing the shared left margin).
2. **segment** — split into blocks at blank lines, so mixed copies are handled
   block by block.
3. **classify** — judge each block: prose, list, code, table, trace, data, or
   unsure.
4. **transform** — only reflow blocks that are confidently prose or lists;
   everything else is left verbatim.

**Golden rule:** when unsure, a block is left exactly as it was.

## Adding test cases (this is how quality grows)

Every real-world example you can copy is a potential fixture. To add one:

```
test/fixtures/<short-name>/input.txt      # what you copied
test/fixtures/<short-name>/expected.txt   # what it should become
```

Then run `npm test`. The most important thing the suite protects: code, logs,
and tables must **never** be reflowed as prose. When you hit a case where it
gets that wrong, add it here so it can never regress.
