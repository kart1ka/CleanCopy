# 1.0 compatibility contract

This is the intended public contract for `1.0.0`. Intentional changes to this
contract will be recorded in the changelog and versioned using Semantic
Versioning.

## Supported systems

| Surface | 1.0 contract |
| --- | --- |
| Operating system | macOS 12 Monterey or later |
| Mac architecture | Apple Silicon (`arm64`) and Intel (`x86_64`) |
| Node.js | 22 or later |
| npm package | Public, unscoped package published on the `latest` tag |
| Installation | Global npm install of the CLI |

The CLI and bundled Swift helper are macOS-only. The internal cleanup engine is
not a supported package API.

## CLI surface

Version 1.0 supports these commands:

- `clean [--explain]`
- `start`, `stop [--disable-autostart]`, `status`, and `doctor`
- `install` for enabling login autostart
- `run` for foreground diagnostics
- `config mode auto|manual`
- `config hotkey clean|revert <combo>|off`
- `--help` and `--version`

`stop` stops the watcher for the current session. With
`--disable-autostart`, it also removes login autostart. Removing the npm package
and optional user state is documented in the README.

## Configuration and state

The default state directory is `~/.cleancopy` and can be relocated with
`CLEANCOPY_STATE_DIR`. Its public files are:

- `config.json`: mode and hotkey settings;
- `cleancopy.pid`: daemon identity; and
- `cleancopy.log`: content-free event summaries.

The 1.0 configuration shape is:

```json
{
  "mode": "auto",
  "hotkeys": {
    "clean": "cmd+ctrl+c",
    "revert": "cmd+ctrl+z"
  }
}
```

Invalid fields fall back safely and produce warnings. Config changes require a
watcher restart.

## Behavior and privacy promises

- Only copies made while a supported terminal is frontmost are candidates for
  automatic cleanup.
- Text that cannot be classified confidently is left unchanged.
- Code, logs, tables, structured data, commands, and traces are preserved.
- Clipboard text is processed locally and is never logged or sent over the
  network.
- Concealed or transient pasteboard items are never read.
- A clean or revert never overwrites a clipboard item that arrived later.

## Versioning

Releases use Semantic Versioning and npm's `latest` tag. Any intentional
breaking change to the CLI, config schema, supported systems, or privacy
boundary must be called out in the changelog and released as a new major
version.
