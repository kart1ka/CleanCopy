# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## CleanCopy

CleanCopy cleans up text copied from a terminal so it pastes neatly into other apps (Slack, notes, messaging). Terminal copies arrive with a stray left margin, sentences chopped onto extra lines by the window's width, odd spacing, and invisible characters. CleanCopy fixes that **without ever damaging things it shouldn't** — code, tables, error output, commands.

## Status

Early scaffold. On disk right now: `package.json`, `tsconfig.json`, this file, the README, and the cleanup engine with its fixture tests (`src/engine`, `test/`). The build order is: (1) the cleanup engine, (2) a fixture test corpus, (3) a `cleancopy clean` CLI, and only then (4+) the live clipboard watcher and the native macOS layer. Sections below describe both what exists and the agreed target architecture; treat anything not yet on disk as the plan to build toward, not as existing code.

## Commands

- `npm install` — install dev dependencies (TypeScript, Vitest, tsx).
- `npm test` — run the full Vitest suite once.
- `npm run test:watch` — re-run tests on change while developing the engine.
- `npx vitest run test/engine.test.ts` — run a single test *file*.
- `npx vitest run -t "<name>"` — run a single test by name (e.g. a fixture case name like `03`).
- `npm run clean` — run the CLI in dev via tsx; reads stdin, prints cleaned text to stdout. Typical use: `pbpaste | npm run -s clean | pbcopy`, or `npm run -s clean -- --explain < test/fixtures/<case>/input.txt`.
- `npm run typecheck` — type-check without emitting.
- `npm run build` — compile TypeScript to `dist/` (CommonJS); the published `cleancopy` bin points at `dist/cli/index.js`.

## The one principle everything hangs on

**"Copied from a terminal" does NOT mean "safe to reformat."** Most things copied from a terminal are commands, paths, code, logs, and lists — content that must be preserved verbatim. Flowing prose is only a slice. So CleanCopy never trusts the *source*; it inspects the *content* and decides, piece by piece, what is safe to touch.

**The golden rule: when unsure, leave a block exactly as it was.** The cost of mistakes is asymmetric — failing to tidy prose is invisible; mangling someone's code is the bug that gets the tool uninstalled. Bias hard toward doing nothing.

## Architecture (big picture)

Two halves, chosen so the unavoidable native code stays tiny:

- **TypeScript "brain" (this npm package)** — the cleanup engine, the safety decisions, the CLI, config, logging, and the watcher's orchestration logic. This is where nearly all work happens.
- **Small Swift helper binary (planned, bundled in the npm package)** — the only parts that must touch macOS: watching the clipboard efficiently, reading/writing it, and reporting which app is frontmost. It runs continuously and streams simple messages to the Node process over stdin/stdout ("clipboard changed; front app was iTerm2; here is the plain text"); Node replies with the cleaned text or "leave it." Nothing leaves the machine. The helper remembers its own writes so it never re-cleans its own output in a loop.

Distribution stays `npm install -g cleancopy`; the prebuilt Swift helper ships inside the package. (An all-Swift + Homebrew build was considered and rejected in favor of keeping the engine in TypeScript.)

### The cleanup engine — the heart (`src/engine`)

Pure functions: text in, text out, **no side effects and no macOS/clipboard code**. Keeping it platform-agnostic is what lets it be tested in isolation and reused on other OSes later. The pipeline (one file per step):

1. **normalize** (`normalize.ts`) — always-safe tidy-ups applied to every copy, no judgement: unify line endings, strip ANSI codes, remove zero-width characters, convert exotic Unicode spaces to plain spaces, trim trailing whitespace, and *strip the common left margin* (the indentation shared by all lines — the terminal/Claude render margin). Stripping the *shared* margin is safe even for code: the block slides left, its inner shape intact.
2. **segment** (`segment.ts`) — split into blocks at blank lines. Critical because one copy is often mixed (prose, then code, then prose); each block is judged on its own.
3. **classify** (`classify.ts`) — judge each block: `prose`, `list`, `code`, `table`, `trace`, `data`, or `other`. Two tiers: hard structural guards force "verbatim" (tabs, aligned columns, stack-trace/log patterns, JSON/YAML/XML shape, code markers like trailing `;`/`{` or `=>`); otherwise a confidence-scored prose check. The strongest "this is prose" signal is line-length uniformity (wrapped paragraphs hug a consistent right edge and break mid-sentence). Returns a confidence and the list of signals that fired (surfaced by `--explain`). **This file is the heart of the product** — tune it against real fixtures.
4. **transform** (`transform.ts`) — tidy each block per its type. Only `prose` and `list` blocks above the confidence threshold (`REFLOW_THRESHOLD`) are reflowed (wrapped lines glued back together; for lists, per item, keeping items separate). Everything else is returned verbatim.

`clean()` / `cleanWithReport()` in `index.ts` run the pipeline and stitch blocks back with a single blank line between them. The engine must be **idempotent**: `clean(clean(x)) === clean(x)`.

### Safe vs. risky operations

- **Always safe** (the normalize step): whitespace cleanup, unicode/zero-width cleanup, collapsing big blank-line gaps, shared-margin removal. Apply to everything, every time.
- **Risky** (gated behind classification + confidence): gluing wrapped lines back into paragraphs. This is the headline feature and the one that corrupts code/tables/logs if misapplied — so it only runs when a block is clearly prose or a list.

## Testing — where quality actually comes from

The engine is only as good as its examples. Tests are fixture-driven: `test/fixtures/<case>/input.txt` paired with `expected.txt`; the suite runs `clean(input)` and compares.

- The metric that matters most: **never reclassify code/logs/tables as prose.** Missing some prose is acceptable; corrupting verbatim content is not.
- Every real-world misclassification becomes a new permanent fixture, so the corpus only grows and regressions can't return.
- Idempotency is asserted as a property across all fixtures.

## Privacy (a core constraint, not a feature)

CleanCopy reads everything that hits the clipboard, so trust is the whole game: **nothing ever leaves the machine**, copied text is **never saved or logged** (logs only ever record events like "cleaned text from Terminal", never contents), and any clipboard change that is not plain text or not from a terminal is read and immediately discarded.

## Scope decisions

- **v1:** macOS only; automatic cleanup on every terminal copy; npm global install; no menu-bar app or window; no cloud; no clipboard history.
- **Planned later (do not build yet unless asked):** a Raycast-style notification HUD shown when a copy is cleaned; a keyboard shortcut to paste the *original* text when the user dislikes the cleaned version (an undo); a configurable "copy + clean" shortcut as an alternative to auto-clean-on-copy; user-configurable behavior.
