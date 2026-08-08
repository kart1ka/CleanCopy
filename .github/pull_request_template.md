## What does this change, and why?

<!-- A sentence or two. Link the issue if there is one. -->

## Checklist

- [ ] `npm test` and `npm run typecheck` pass.
- [ ] If this changes what the engine does to any text, a fixture in
      `test/fixtures/` captures it (input.txt + expected.txt).
- [ ] The golden rule holds: nothing that used to be left verbatim
      (code, tables, logs, commands) is now reflowed.
- [ ] No code path can log, store, or transmit clipboard contents —
      log lines carry event descriptions only.
- [ ] If the helper's stdin/stdout protocol or hotkey grammar changed,
      both sides changed together (`helper/…/main.swift` and
      `src/watcher/protocol.ts` / `src/watcher/config.ts`).
