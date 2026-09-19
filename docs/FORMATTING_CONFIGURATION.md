# Formatting configuration

CleanCopy keeps formatting preferences in its existing user configuration and passes them into the pure engine. The watcher and the pipe command use the same rules. The Swift helper and its protocol are unchanged.

See [the rule reference and commands](../README.md#choose-formatting-rules) for usage. This document explains the implementation and its contracts.

## Configuration and defaults

The complete configuration has this shape. Every formatting rule defaults to `true`.

```json
{
  "mode": "auto",
  "hotkeys": { "revert": "cmd+ctrl+z" },
  "rules": {
    "normalizeLineEndings": true,
    "stripAnsi": true,
    "removeInvisibleCharacters": true,
    "normalizeSpaces": true,
    "trimTrailingWhitespace": true,
    "removeSharedMargin": true,
    "reflowProse": true,
    "reflowLists": true,
    "collapseProseSpaces": true,
    "trimOuterBlankLines": true
  }
}
```

The file lives at `~/.cleancopy/config.json`. `CLEANCOPY_STATE_DIR` relocates it with the existing runtime files. Old files need no migration: missing rule keys inherit their defaults. Explicit `false` values remain disabled. Configuration commands save a complete rule map.

[The loader](../src/watcher/config.ts) validates external values and returns resolved settings plus warnings. Invalid maps, nonboolean values, and unknown rule names produce warnings. Known invalid values fall back to defaults. Explicit CLI mistakes fail before reading stdin, saving a file, or restarting the watcher.

Precedence is defaults, then saved settings, then per-command overrides. `--no-config` skips saved settings. Overrides only affect that invocation. Passing both enable and disable for the same rule is an error.

[Configuration commands](../src/cli/config.ts) reuse the existing save-and-restart behavior. Restarting discards the original stored for revert and any pending double-copy gesture. Hand edits require a manual restart. There is no file watcher or hot-reload mechanism.

## Rule ownership

[engine/rules.ts](../src/engine/rules.ts) owns the rule catalog, descriptions, defaults, and types. Rule names used by JSON validation, CLI validation, listing, and explanations come from that catalog. Config loading and engine calls resolve partial settings to a complete `Rules` object.

The engine accepts options through its existing internal entry points:

```ts
clean(input);
clean(input, { rules: { removeSharedMargin: false } });
cleanWithReport(input, { rules: config.rules, explain: true });
```

`CleanResult.rules` records the effective configuration. The engine does not read files or environment variables. These functions remain internal package interfaces, not a new published library API.

Both callers pass formatting settings explicitly:

```text
config.json -> runForeground -> startWatcher -> decide -> clean
config.json + CLI overrides -> cleanWithReport -> stdout
```

Automatic copies and manual double copies converge on the same watcher decision function. Rule settings do not enter the native helper's messages.

## Preserve source separators

The pipeline order remains normalization, segmentation, classification, transformation, and assembly. Every text-changing operation is controlled by a rule, while content classification and safety checks always run.

Previously, segmentation kept only line contents and blank-line counts. That could not preserve CRLF, mixed separators, or whitespace-only blank lines when their cleanup was disabled. [Blocks](../src/engine/types.ts) now retain their offsets in normalized input and the exact separators between their lines.

[Segmentation](../src/engine/segment.ts) recognizes LF, CRLF, and CR without changing them. Classification uses canonical LF between line contents. Transformation retains the separator belonging to each surviving line. Assembly copies untouched inter-block separators directly from normalized input using block offsets.

Consequently, all rules disabled is an exact identity operation, including whitespace-only input, mixed line endings, terminal escapes, and multiple final newlines. No special bypass is needed. `trimOuterBlankLines` controls outer separators and final-newline multiplicity. With that rule enabled, nonempty output retains the separator immediately after the last content line, if present. Separators belonging to discarded blank lines cannot replace it.

## Independent transformations

[Normalization](../src/engine/normalize.ts) applies configured line-ending conversion, ANSI removal, invisible-character removal, Unicode-space conversion, trailing-whitespace cleanup, and shared-margin removal. Operations on line contents preserve separators when line-ending normalization is disabled.

[Transformation](../src/engine/transform.ts) uses one implementation for eligible paragraph and list lines. List-local margin removal happens before optional joining, so disabling list reflow does not disable margin removal. The existing nesting exceptions still apply.

Paragraph and list reflow have separate switches. Space collapsing runs independently in eligible prose and lists, subject to the same content-confidence and minimum-width checks as before. Disabling space collapsing retains repeated spaces even when wraps are joined. Disabling trailing trimming retains whitespace at surviving line ends.

Wrap repair itself replaces a removed line break and its adjacent whitespace with one space. This necessarily removes indentation from a continuation that becomes part of the preceding line. Disabling margin removal preserves leading indentation on surviving lines; retaining every original line's indentation also requires disabling its reflow rule.

Shared-margin removal runs during normalization, list preparation, and final assembly. The final pass removes a common margin newly exposed by joining lines. All three sites use the same switch.

## Mandatory protections and stability

Code, tables, logs, structured data, transcripts, comments, and uncertain text still receive the existing classification and confidence checks. Intentional-break vetoes and the stability check cannot be disabled. An enabled rule permits an operation only where its content guards allow it.

Protection means avoiding prose transformations on recognized protected content. Global normalization can still alter its whitespace or escape sequences. Classification is heuristic, so this is not a promise to recognize every possible code fragment. Exact original bytes for every input are available by disabling all formatting rules.

The pipeline's second pass uses the same resolved rules as the first. If the result would change again, the engine falls back to normalization and configured outer-blank-line cleanup, with block transforms suppressed. This includes list-local margin removal: extracting it from joining does not make it run on forced-verbatim blocks.

Only eligible blocks whose reflow rule is enabled contribute document-width evidence. This keeps disabled transformations and protected content from establishing a width used to join other blocks.

## Design choice

The design review compared direct typed options with a registry of executable rules at fixed stages. Direct options keep the engine's established ordering and content guards in place with fewer interfaces. The implementation borrows the registry's central metadata catalog without adding executable hooks, plan compilation, plugins, or configurable ordering.

Established tools informed the configuration conventions. ESLint uses named settings under a `rules` object. Prettier shares configuration options with its API and normally gives CLI settings precedence. Ruff also supports saved settings and CLI overrides. [ESLint rules](https://eslint.org/docs/latest/use/configure/rules), [Prettier configuration](https://prettier.io/docs/configuration), [Prettier CLI](https://prettier.io/docs/cli), [Ruff configuration](https://docs.astral.sh/ruff/configuration/).

CleanCopy retains user-wide settings because clipboard events contain app identity and text, not a reliable source project directory. Rule IDs and defaults are user-facing contracts. New default-enabled transformations require review as behavior changes. Older versions can erase the new `rules` field when they save configuration; that remains a downgrade limitation of the existing whole-file serializer.

## Verification

The tests cover each rule in isolation, default output compatibility, exact identity with all rules disabled, and stability across all 1,024 configurations on the 67 existing fixtures. Targeted cases cover mixed line endings, retained blank-line contents, independent list margins, independent space cleanup, and mandatory protection of code, tables, logs, and transcripts.

CLI integration tests use temporary state directories. They verify complete saved configuration, listing, all-rule toggles, precedence, `--no-config`, invalid arguments, and stderr-only diagnostics. Fake helpers exercise daemon startup in automatic and manual modes and compare the resulting writes with pipe-command output. They do not use the real clipboard.

Run the complete checks with:

```sh
npm test
npm run typecheck
npm run build
```
