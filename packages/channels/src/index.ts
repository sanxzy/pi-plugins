export {
  channelConfigFile,
  channelLogFile,
  channelLogsDir,
  channelOwnerFile,
  lastConnectionFile,
} from "./shared/paths.ts";
export {
  privateFileMode,
  readChannelConfig,
  readLastConnection,
  writeChannelConfig,
  writeLastConnection,
  writePrivateJson,
  type ChannelConfig,
  type LastConnection,
  type LastConnectionState,
  type PairingRequest,
  type StateResult,
} from "./state.ts";
export {
  createChannelLogger,
  type ChannelLogger,
  type ChannelLogOptions,
  type ChannelLogResult,
} from "./logger.ts";
export {
  canonicalProjectRoot,
  createChannelManager,
  type ChannelConnectionState,
  type ChannelConnectionStatus,
  type ChannelManager,
  type ChannelManagerDeps,
  type ChannelPoller,
} from "./manager.ts";
export {
  createChannelOwner,
  isProcessAlive,
  type ChannelOwner,
  type ChannelOwnerRecord,
  type OwnerRead,
} from "./ownership.ts";
