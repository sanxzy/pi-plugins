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
  validateChannelConfig,
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
  createTelegramSetupController,
  type TelegramSetupController,
  type TelegramSetupControllerOptions,
} from "./setup.ts";
export {
  createTelegramChannelLifecycle,
  type TelegramChannelLifecycle,
  type TelegramChannelLifecycleOptions,
} from "./lifecycle.ts";
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
export {
  createTelegramTransport,
  telegramTokenFingerprint,
  type BotApiLike,
  type BotLike,
  type RunnerHandleLike,
  type TelegramBotFactory,
  type TelegramMessageHandler,
  type TelegramRunnerFactory,
  type TelegramTransportDeps,
} from "./transport.ts";
export {
  createTelegramInbound,
  decodeAcceptedText,
  formatTelegramSignature,
  type TelegramInboundListener,
  type TelegramInboundOptions,
  type TelegramUpdate,
} from "./inbound.ts";
export {
  canSendTelegram,
  createTelegramOutbound,
  sendTelegramMessage,
  sendTextChunks,
  splitTextChunks,
  MAX_TEXT_LENGTH,
  type OutboundTextResult,
  type TelegramOutbound,
  type TelegramOutboundOptions,
  type TelegramSendApi,
} from "./outbound.ts";
