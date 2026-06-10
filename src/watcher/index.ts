export { startWatcher, type Watcher, type WatcherOptions } from './watcher';
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
