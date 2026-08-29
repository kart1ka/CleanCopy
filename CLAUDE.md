# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## CleanCopy

CleanCopy cleans up text copied from a terminal so it pastes neatly into other apps (Slack, notes, messaging). Terminal copies arrive with a stray left margin, sentences chopped onto extra lines by the window's width, odd spacing, and invisible characters. CleanCopy fixes that **without ever damaging things it shouldn't** — code, tables, error output, commands.

## Status

The core product works end to end: (1) the cleanup engine, (2) the fixture test corpus, (3) the `cleancopy clean` CLI, and (4) the live clipboard watcher — the Swift helper (`helper/`), the Node orchestration (`src/watcher/`), and the `start`/`stop`/`status`/`run` commands — plus launchd autostart (`autostart on` to enable, `autostart off` or `stop --disable-autostart` to stop and disable) — are all on disk and tested. The npm publish path is also built: `.github/workflows/publish.yml` publishes with provenance when a GitHub release is created, `prepublishOnly` builds the universal helper, and RELEASING.md documents the flow. Not yet done: the first actual publish (repo public, npm environment/token, the v1.0.0 tag) and everything under "Planned later" below.

## Commands

- `npm install` — install dev dependencies (TypeScript, Vitest, tsx).
- `npm test` — run the full Vitest suite once.
- `npm run test:watch` — re-run tests on change while developing the engine.
- `npx vitest run test/engine.test.ts` — run a single test *file*.
- `npx vitest run -t "<name>"` — run a single test by name (e.g. a fixture case name like `03`).
- `npm run clean` — run the CLI in dev via tsx; reads stdin, prints cleaned text to stdout. Typical use: `pbpaste | npm run -s clean | pbcopy`, or `npm run -s clean -- --explain < test/fixtures/<case>/input.txt`.
- `npm run typecheck` — type-check without emitting.
- `npm run build` — compile TypeScript to `dist/` (CommonJS); the published `cleancopy` bin points at `dist/cli/index.js`.
- `npm run build:helper` — compile the Swift clipboard helper (release, native arch) into `helper/bin/cleancopy-helper`. Needs Xcode CLT. The helper integration tests skip themselves when this hasn't been run. `build:helper:universal` builds the arm64+x86_64 fat binary for publishing (`prepublishOnly` runs it).
- `cleancopy config` — view/change settings, stored in `~/.cleancopy/config.json` (same state dir as the pid file/log). `config mode auto|manual` picks between cleaning every terminal copy as it lands (auto, default) and cleaning only on the double-copy gesture (manual): copying the same text twice in quick succession — detected purely from the pasteboard (window ~130–600 ms between the two observed copies; the lower bound rejects clipboard tools that instantly rewrite every copy, which would otherwise turn manual into auto). There is no clean hotkey. `config hotkey revert <combo>|off` sets the one global hotkey: **revert** (default `cmd+ctrl+z`, registered in both modes) restores the pre-clean original of the last cleaned copy. Combos are modifiers+key joined by `+` (validated by `normalizeHotkey` in `src/watcher/config.ts`; the Swift helper parses the same grammar — keep the two tables in sync). Config changes need a watcher restart to apply; the command says so when one is running. A broken config file degrades to defaults with logged warnings — it never stops the watcher.
- `cleancopy start` / `stop` / `status` — manage the background watcher daemon (pid file + event log live in `~/.cleancopy/`, overridable via `CLEANCOPY_STATE_DIR`). Plain `stop` is temporary and preserves login autostart; `stop --disable-autostart` also removes the LaunchAgent so it stays stopped after login. `cleancopy run` runs it in the foreground with events on stdout — use this when debugging. `cleancopy autostart on` registers a launchd LaunchAgent (`~/Library/LaunchAgents/com.cleancopy.plist`) so the watcher starts at login and is restarted on crash; it bakes the current `CLEANCOPY_*` env into the plist and runs the agent as `cleancopy run`, so the pid file, log, and `stop`/`status` keep working. `KeepAlive` is gated on `SuccessfulExit=false`, so a clean `cleancopy stop` (exit 0) is *not* relaunched but a crash is. The plist mechanics (pure `buildPlist`, `launchctl bootstrap`/`bootout`) live in `src/cli/launchagent.ts`; the lifecycle commands sit in `src/cli/daemon.ts` (dependency runs one way, daemon → launchagent). **Caveat:** the plist pins an absolute Node path (`process.execPath`) because launchd runs with a bare PATH and can't resolve a version-managed `node` — so after a Node upgrade/switch (nvm/fnm) the agent silently fails to launch until `cleancopy autostart on` is re-run; `autostart on` prints this warning. A stable install location (the npm-publish path) is the real fix. In dev: `npm run dev -- start` etc. `CLEANCOPY_PASTEBOARD=<name>` points the watcher at a private named pasteboard instead of the real clipboard — use it (plus `CLEANCOPY_STATE_DIR`) for any manual end-to-end poking so the user's actual clipboard is never touched.

## The one principle everything hangs on

**"Copied from a terminal" does NOT mean "safe to reformat."** Most things copied from a terminal are commands, paths, code, logs, and lists — content that must be preserved verbatim. Flowing prose is only a slice. So CleanCopy never trusts the *source*; it inspects the *content* and decides, piece by piece, what is safe to touch.

**The golden rule: when unsure, leave a block exactly as it was.** The cost of mistakes is asymmetric — failing to tidy prose is invisible; mangling someone's code is the bug that gets the tool uninstalled. Bias hard toward doing nothing.

## Architecture (big picture)

Two halves, chosen so the unavoidable native code stays tiny:

- **TypeScript "brain" (this npm package)** — the cleanup engine, the safety decisions, the CLI, config, logging, and the watcher's orchestration logic. This is where nearly all work happens. The watcher side lives in `src/watcher/`: `protocol.ts` (the line-JSON wire format), `terminals.ts` (which bundle ids count as a terminal; extend via `CLEANCOPY_TERMINALS`), `decide.ts` (the whole policy as a pure function — clean it, or leave it — unit-tested without any clipboard), `config.ts` (the user config: auto/manual mode, the revert hotkey combo + `normalizeHotkey` validation, degrade-to-defaults loading), `watcher.ts` (spawns the helper, restarts it with backoff if it crashes; in manual mode holds the previous terminal copy as the double-copy anchor and cleans when the same text is copied again inside the gesture window; holds the pre-clean original in memory for the revert hotkey, pinned to the `changeCount` the helper's `wrote` ack reports so a revert can never clobber a newer copy), `paths.ts` (state dir, helper resolution). Daemon lifecycle (`start`/`stop`/`status` via pid file) is in `src/cli/daemon.ts`.
- **Small Swift helper binary (`helper/`, SwiftPM, ~250 lines, bundled in the npm package)** — the only parts that must touch macOS: polling `NSPasteboard.changeCount` every 100 ms (macOS has no clipboard-change notification; an int compare is the standard cheap approach — and the poll interval is the timing resolution of the double-copy gesture, which is why it is 100 ms rather than 200), reading/writing plain text, reporting which app is frontmost, and registering global hotkeys (`--hotkey <id>:<combo>`, Carbon `RegisterEventHotKey` — the one API that grabs a global hotkey without Accessibility permission; presses stream to Node as `{"type":"hotkey","id":...}`, a combo another app owns yields `hotkey-failed` instead of dying). It streams line-delimited JSON to the Node process over stdin/stdout ("clipboard changed; front app was iTerm2; here is the plain text"); Node replies with the cleaned text or nothing. Nothing leaves the machine. The helper remembers the changeCount of its own writes so it never re-cleans its own output in a loop, skips anything that isn't plain text, and never touches pasteboard items marked concealed/transient (password managers). It exits on stdin EOF, so it can't outlive its Node parent. `--pasteboard <name>` targets a private named pasteboard — how the integration tests exercise it without touching the real clipboard.

Distribution stays `npm install -g cleancopy`; the prebuilt Swift helper ships inside the package. (An all-Swift + Homebrew build was considered and rejected in favor of keeping the engine in TypeScript.)

### The cleanup engine — the heart (`src/engine`)

Pure functions: text in, text out, **no side effects and no macOS/clipboard code**. Keeping the engine isolated makes it safe and easy to test, but it is an internal part of the CLI rather than a published library API. The pipeline (one file per step):

1. **normalize** (`normalize.ts`) — always-safe tidy-ups applied to every copy, no judgement: unify line endings, strip ANSI codes, remove zero-width characters, convert exotic Unicode spaces to plain spaces, trim trailing whitespace, and *strip the common left margin* (the indentation shared by all lines — the terminal/Claude render margin). Stripping the *shared* margin is safe even for code: the block slides left, its inner shape intact.
2. **segment** (`segment.ts`) — split into blocks at blank lines. Critical because one copy is often mixed (prose, then code, then prose); each block is judged on its own.
3. **classify** (`classify.ts`) — judge each block: `prose`, `list`, `code`, `table`, `trace`, `data`, or `other`. Two tiers: hard structural guards force "verbatim" (tabs, aligned columns, stack-trace/log patterns, JSON/YAML/XML shape, code markers like trailing `;`/`{` or `=>`); otherwise a confidence-scored prose check. The strongest "this is prose" signal is line-length uniformity (wrapped paragraphs hug a consistent right edge and break mid-sentence). Returns a confidence and the list of signals that fired (surfaced by `--explain`). **This file is the heart of the product** — tune it against real fixtures.
4. **transform** (`transform.ts`) — tidy each block per its type. Only `prose` and `list` blocks above the confidence threshold (`REFLOW_THRESHOLD`) are reflowed (wrapped lines glued back together; for lists, per item, keeping items separate). Everything else is returned verbatim.

`clean()` / `cleanWithReport()` in `index.ts` run the pipeline and stitch blocks back with a single blank line between them. The engine must be **idempotent**: `clean(clean(x)) === clean(x)`.

### Safe vs. risky operations

- **Always safe** (the normalize step): whitespace cleanup, unicode/zero-width cleanup, collapsing big blank-line gaps, shared-margin removal. Apply to everything, every time.
- **Risky** (gated behind classification + confidence): gluing wrapped lines back into paragraphs. This is the headline feature and the one that corrupts code/tables/logs if misapplied — so it only runs when a block is clearly prose or a list.

### Known residual tradeoffs (accepted, not bugs)

Each of these fails in the invisible direction (prose left untidied or frozen), never the fatal one (verbatim content reflowed). Revisit only with real-world evidence:

- **Wide SQL still reflows.** Lowercase SQL wider than the narrow-block gate (`select … from users` at realistic widths) is joined; protecting it needs keyword heuristics too likely to freeze ordinary prose ("where we went last summer"). Fixture 41-narrow-sql covers only the narrow shape, on purpose.
- **One-marker diff hunks aren't caught.** The diff guard needs two bare `+`/`-` markers or a header line (`@@`, `---`/`+++`, `diff --git`); a single changed line with context and no header slips through. The threshold spares prose with signed tokens — which is also why blocks with two `+1`/`-1`-style line starts freeze as diffs.
- **`- key: value` markdown lists freeze as data.** Postmortem-style label lists classify YAML-ish and stay verbatim; wrapped items still reflow (continuation lines dilute the key-value ratio below the 0.6 bar).

## Testing — where quality actually comes from

The engine is only as good as its examples. Tests are fixture-driven: `test/fixtures/<case>/input.txt` paired with `expected.txt`; the suite runs `clean(input)` and compares.

- The metric that matters most: **never reclassify code/logs/tables as prose.** Missing some prose is acceptable; corrupting verbatim content is not.
- Every real-world misclassification becomes a new permanent fixture, so the corpus only grows and regressions can't return.
- Idempotency is asserted as a property across all fixtures.

## Privacy (a core constraint, not a feature)

CleanCopy reads everything that hits the clipboard, so trust is the whole game: **nothing ever leaves the machine**, copied text is **never saved or logged** (logs only ever record events like "cleaned text from Terminal", never contents), and any clipboard change that is not plain text or not from a terminal is read and immediately discarded.

## Scope decisions

- **v1:** macOS only; automatic cleanup on every terminal copy (or double-copy-triggered cleanup in manual mode — copy the same text twice quickly; chosen over a clean hotkey and over synthesizing Cmd+C, which needs Accessibility permission); a revert hotkey that restores the pre-clean original; mode + the revert hotkey configurable via `cleancopy config`; npm global install; no menu-bar app or window; no cloud; no clipboard history.
- **Planned later (do not build yet unless asked):** a Raycast-style notification HUD shown when a copy is cleaned; further user-configurable behavior beyond mode/hotkeys.

## Prior art & library research (2026-06-09)

A web search was done to decide build-vs-reuse. **Conclusion: no off-the-shelf library does the whole job** (clean terminal-copied text *and* unwrap only the prose while preserving code/tables). The few purpose-built tools (Clean Clode, Terminal Text Cleaner) are closed/GPL web apps, not reusable libraries. **Chosen approach: a hybrid** — keep our own engine + classifier for the hard part, reuse small libs for the boring parts, and use the Raycast extension as a reference to make our classifier more complete.

### The hard part (structure-aware unwrap) — reference, not a dependency
- **Raycast "Wrap/Unwrap" extension `lib/` — the closest match.** Pure dependency-free **TypeScript**, **MIT** licensed, offline. Its `classify.ts` is a real block classifier (prose vs fenced/indented code, pipe tables, bullet/ordered/task lists, nested blockquotes, headings, HR, HTML blocks, link-ref defs, hard breaks) and `unwrap.ts` reflows only the prose groups. Source: `https://github.com/raycast/extensions/tree/main/extensions/wrap-unwrap/src/lib` (files: `classify.ts`, `unwrap.ts`, `inline.ts`, `regex.ts`, `wrap.ts`; **skip `pipeline.ts`** — it's the only Raycast/clipboard-coupled file). Caveats: it is **Markdown-aware, not terminal-aware**, and uses CommonMark's "4-space indent = code" rule — so our dedent (shared-margin strip) MUST run *before* it, or margin-indented prose gets misread as code. It does **not** do ANSI/zero-width/unicode cleanup.
- **Fallbacks / benchmarks (not the engine):** Prettier with `proseWrap: "never"` and Python `mdformat --wrap=no` both genuinely *unwrap* prose while preserving code/tables — but they're full Markdown *reformatters* (rewrite bullets, emphasis, re-fence indented code, assume valid Markdown) and heavy. Useful to compare our output against. **Watch out:** most "text wrap" packages (word-wrap, linewrap, muesli/reflow, Flowmark, fmt/fold) only *add* line breaks — they wrap, they don't unwrap. We need unwrap.

### The boring parts — small libraries we could compose (instead of hand-rolling)
- **`strip-ansi`** (chalk, MIT) — robust ANSI/color-code removal; better than our hand-written regex in `normalize.ts`. (Node 16+ also has built-in `util.stripVTControlCharacters`.)
- **`strip-indent`** (sindresorhus, MIT) — removes the common leading margin while preserving relative indentation. This is exactly what our `stripCommonMargin` does; could be swapped in.
- **Zero-width / unusual-unicode-space cleanup** — no well-maintained library worth adopting; keep our own ~5-line regex (we want to control this anyway).
- **Trailing-whitespace trim / blank-line collapse** — trivial regex, not worth a dependency.
- **Supply-chain note:** strip-ansi / strip-indent were caught in the Sept-2025 npm phishing incident (fixed fast). If adopted, pin exact versions + keep the lockfile + run `npm audit`.

### Existing end-user apps (competitive reference only — none auto-clean terminal copies with structure preservation)
- **TextSoap** (paid, macOS) — *does* turn hard-wrapped text into flowing paragraphs + NBSP/space cleanup, but it's regex-cleaner based, **not** code-vs-prose aware (risks mangling code).
- **Pure Paste** (Sindre Sorhus) — strips invisible chars / rich text on paste; **no unwrap**. Good inspiration for the invisible-char cleanup.
- **WordService** (DEVONtechnologies, free) — has a paragraph-reformat command, not structure-aware.
- Takeaway: our specific niche — *automatic, on every terminal copy, structure-aware* — is not covered by any existing app, so building is justified.

### To resume this thread
A general-purpose research agent (id `a5fbed5dafd84906a`) holds the full findings and can be continued via SendMessage if deeper digging is needed.
