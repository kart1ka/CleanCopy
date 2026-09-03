# Releasing

The whole flow, for 1.0.0 and every release after it. One rule above all:
never publish from a laptop — the GitHub release triggers the only publish
(and `prepublishOnly` enforces it: outside CI it exits 1 before building,
so a stray local `npm publish` cannot get anywhere; `npm run release:check`
remains the local dry-run)
path.

## 1. Preflight

- CHANGELOG.md: set the release date on the version being shipped.
- `package.json` `version` is the single source of truth. The tag must be
  `v<version>` — the publish workflow verifies this and refuses a mismatch.
- Run `npm run release:check` locally: it builds the universal helper, runs
  the full suite, and prints the exact tarball contents. Read the file list.
- CI must be green on the branch being released.

## 2. Ship

1. Merge the release branch into `main` and push.
2. Wait for CI on `main` to pass.
3. Create a GitHub Release with tag `vX.Y.Z` targeting `main`, not marked as
   a pre-release. Publishing it triggers `.github/workflows/publish.yml`,
   which rebuilds everything from the tag and publishes to npm with
   provenance from the protected `npm` environment.

## 3. Verify

- `npm view cleancopy-cli version` shows the new version.
- On a real machine: `npm install --global cleancopy-cli`, then
  `cleancopy doctor`, then one copy → paste round trip with the watcher on.

## If a release is bad

Fix forward. Never `npm unpublish` a version people may have installed —
publish a patch release instead, and mark the bad version:

```bash
npm deprecate cleancopy-cli@X.Y.Z "broken: <reason> — upgrade to X.Y.Z+1"
```

For a hotfix on an older line: branch from the tag, apply the fix, bump the
patch version, and follow the same steps from Preflight.
