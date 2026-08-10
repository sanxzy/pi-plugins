export {
  channelConfigFile,
  channelLogFile,
  channelLogsDir,
  channelOwnerFile,
  channelRuntimeFile,
} from "./shared/paths.ts";
export {
  clearChannelConfig,
  privateFileMode,
  readChannelConfig,
  readChannelRuntime,
  validateChannelConfig,
  writeChannelConfig,
  writeChannelRuntime,
  writePrivateJson,
  type ChannelConfig,
  type ChannelRuntimeState,
  type PairingRequest,
  type StateResult,
} from "./state.ts";
export {
  createTelegramSetupController,
  type PairingApprovalResult,
  type PendingPairingView,
  type TelegramSetupController,
  type TelegramSetupControllerOptions,
} from "./setup.ts";
export {
  PAIRING_CODE_ALPHABET,
  PAIRING_CODE_LENGTH,
  PAIRING_PENDING_MAX,
  PAIRING_PENDING_TTL_MS,
  approvePairingAt,
  createPairingCode,
  formatPairingChallenge,
  pruneExpiredPairings,
  upsertPairingRequest,
  type PairingRequestResult,
} from "./pairing.ts";
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
  TELEGRAM_MENU_MAX_COMMANDS,
  TELEGRAM_MENU_MAX_DESCRIPTION,
  TELEGRAM_MENU_COMMAND_PATTERN,
  buildTelegramBotCommands,
  sanitizeTelegramCommandDescription,
  sanitizeTelegramCommandName,
  type TelegramBotCommand,
  type TelegramMenuCommandSource,
} from "./menu.ts";
export {
  discoverTelegramExpansions,
  expandTelegramCommand,
  parseTelegramTemplateArgs,
  readTelegramExpansionFile,
  substituteTelegramTemplateArgs,
  telegramExpansionCommandName,
  telegramExpansionReservedNames,
  type TelegramExpandableSource,
  type TelegramExpansionTarget,
} from "./expansion.ts";
export {
  createTelegramInbound,
  defaultTelegramPairingState,
  decodeAcceptedText,
  extractTelegramChatId,
  extractTelegramMessageOrigin,
  formatTelegramCommandSignature,
  formatTelegramSignature,
  parseTelegramCommand,
  type TelegramCommand,
  type TelegramInboundListener,
  type TelegramInboundOptions,
  type TelegramMessageOrigin,
  type TelegramUpdate,
} from "./inbound.ts";
export {
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
