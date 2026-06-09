# CleanCopy

Cleans up text copied from a terminal so it pastes neatly into other apps.

Terminal copies often arrive with a stray left margin, sentences chopped onto
extra lines by the window width, odd spacing, and invisible characters.
CleanCopy fixes that — **without damaging code, tables, error output, or
commands**.

> Status: early scaffold. The cleanup **engine** and its tests exist and work
> standalone. The background clipboard watcher and the native macOS helper come
> later. See `CLAUDE.md` for the full architecture.

## Try it

```bash
npm install

# clean some text from stdin
pbpaste | npm run -s clean | pbcopy

# see why each block was treated the way it was
npm run -s clean -- --explain < test/fixtures/05-mixed-content/input.txt
```

## Develop

```bash
npm test                 # run the fixture + property tests
npm run test:watch       # re-run on change
npx vitest run -t 03     # run a single fixture by name
npm run typecheck        # type-check only
npm run build            # compile to dist/
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
