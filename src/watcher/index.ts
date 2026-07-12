export { startWatcher, type Watcher, type WatcherOptions } from './watcher';
export {
  configFilePath,
  DEFAULT_CONFIG,
  loadConfig,
  normalizeHotkey,
  saveConfig,
  type CleanMode,
  type Config,
  type Hotkeys,
  type LoadedConfig,
} from './config';
export { decide, MAX_TEXT_LENGTH, type Decision } from './decide';
export { isTerminalApp, extraTerminalsFromEnv } from './terminals';
export {
  parseHelperMessage,
  serializeNodeMessage,
  type ClipboardEvent,
  type HelperMessage,
  type NodeMessage,
} from './protocol';
export {
  stateDir,
  ensureStateDir,
  pidFilePath,
  logFilePath,
  resolveHelperBinary,
} from './paths';
