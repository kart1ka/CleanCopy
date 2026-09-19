# Changelog

All notable changes to this project will be documented here. The project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Settings for all ten formatting operations, shared by the watcher and
  `cleancopy clean`. Use `config rules` to list them, `config rule <name> on|off`
  to change one, or `config rules on|off` to change all of them.
- Per-command `--enable-rule`, `--disable-rule`, and `--no-config` options.
  Explanations now include effective rule settings.
- Exact input preservation when all formatting rules are disabled, including
  mixed line endings and whitespace-only blank lines. Code, table, and log
  protections remain mandatory.

## [1.0.2] - 2026-09-11

### Changed

- The published CLI now runs on Node.js 18 or later (previously 22 or later).
  Developing and testing the package still requires Node.js 20 or later.

## [1.0.1] - 2026-09-06

### Changed

- The npm package homepage now points at https://cleancopy.dev.

## [1.0.0] - 2026-09-02

### Added

- Automatic cleanup of copies from supported macOS terminals, or a manual
  mode that cleans only on the double-copy gesture (copy the same text twice,
  quickly).
- A reversible clean operation that refuses to overwrite a newer clipboard
  item.
- A pure TypeScript cleanup engine that preserves code, logs, tables, and other
  uncertain text.
- A global revert hotkey and a local JSON configuration file.
- A universal native helper for Apple Silicon and Intel Macs.
- `cleancopy doctor` and `cleancopy --version` installation diagnostics.

### Security and privacy

- Clipboard contents remain local, are never logged, and are never persisted
  to disk.
- Concealed and transient pasteboard items are ignored.
- npm release preparation includes an exact tarball inspection, clean-install
  smoke test, provenance, and a tokenless trusted-publishing migration path.
