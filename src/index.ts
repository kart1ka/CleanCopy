// Library entry point: the cleanup engine (pure, platform-agnostic) and the
// clipboard watcher (spawns the bundled Swift helper; macOS only).
export * from './engine';
export * as watcher from './watcher';
