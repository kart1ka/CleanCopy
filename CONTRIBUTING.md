# Contributing to CleanCopy

CleanCopy's first responsibility is to leave uncertain text unchanged. A missed
cleanup is less harmful than damaged code, logs, commands, or structured data.
Contributions should preserve that bias.

## Useful contributions

- A reproducible example of prose that should have been cleaned but was not.
- A reproducible example of code, logs, tables, or other text that CleanCopy
  changed incorrectly.
- macOS watcher, hotkey, autostart, or packaging bugs.
- Focused documentation improvements.

Do not include passwords, tokens, private messages, customer data, or other
sensitive clipboard contents. Reduce reports to synthetic examples that still
reproduce the behavior.

## Development setup

Development requires Node.js 22 or later. Building the native helper requires
Xcode command-line tools.

```bash
npm install
npm test
npm run typecheck
npm run build
npm run build:helper
```

The native-helper integration tests use a private named pasteboard and never
the real clipboard.

## Add a cleanup fixture

Most cleanup changes should begin with a small regression fixture:

```text
test/fixtures/<short-name>/input.txt
test/fixtures/<short-name>/expected.txt
```

`input.txt` is the copied text before cleaning. `expected.txt` is the exact
desired result. Both are compared byte-for-byte, and every fixture is also
checked for idempotence: cleaning it twice must produce the same result as
cleaning it once.

Run `cleancopy clean --explain` when investigating why a block was or was not
changed. The explanation is written to stderr; clipboard text is never logged
by the watcher.

## Pull requests

Keep changes focused. Explain the user-visible problem, include a regression
test, and note any privacy or compatibility implications. Before opening a pull
request, run:

```bash
npm test
npm run typecheck
npm run release:check
```

Do not include generated build directories, local state, logs, or credentials.

## Security reports

Do not open a public issue for a suspected vulnerability. Follow
[SECURITY.md](SECURITY.md) and use a private GitHub security advisory.
