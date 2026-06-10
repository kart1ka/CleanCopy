// Which apps count as "a terminal"? Copies from anything else are discarded
// immediately — the engine never even sees them. Deliberately conservative:
// apps where copied text is sometimes terminal-ish (editors with built-in
// terminals, like VS Code) are excluded, because most copies from them are
// source code from the editor pane.

const TERMINAL_BUNDLE_IDS = new Set([
  'com.apple.Terminal',
  'com.googlecode.iterm2',
  'org.alacritty',
  'io.alacritty',
  'net.kovidgoyal.kitty',
  'com.github.wez.wezterm',
  'dev.warp.Warp-Stable',
  'dev.warp.Warp-Preview',
  'co.zeit.hyper',
  'com.mitchellh.ghostty',
  'com.termius-dmg.mac',
]);

/**
 * Extra bundle ids can be added via the CLEANCOPY_TERMINALS environment
 * variable (comma-separated) until real config support lands.
 */
export function isTerminalApp(bundleId: string, extraBundleIds: readonly string[] = []): boolean {
  if (!bundleId) return false;
  return TERMINAL_BUNDLE_IDS.has(bundleId) || extraBundleIds.includes(bundleId);
}

export function extraTerminalsFromEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  return (env.CLEANCOPY_TERMINALS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}
