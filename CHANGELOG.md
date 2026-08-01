# Changelog

All notable changes to this project will be documented here. The project uses
[Semantic Versioning](https://semver.org/).

## [1.0.0] - Unreleased

### Added

- Automatic and hotkey-triggered cleanup of copies from supported macOS
  terminals.
- A reversible clean operation that refuses to overwrite a newer clipboard
  item.
- A pure TypeScript cleanup engine that preserves code, logs, tables, and other
  uncertain text.
- Global clean and revert hotkeys with a local JSON configuration file.
- A universal native helper for Apple Silicon and Intel Macs.
- `cleancopy doctor` and `cleancopy --version` installation diagnostics.

### Security and privacy

- Clipboard contents remain local, are never logged, and are never persisted
  to disk.
- Concealed and transient pasteboard items are ignored.
- npm release preparation includes an exact tarball inspection, clean-install
  smoke test, provenance, and a tokenless trusted-publishing migration path.
