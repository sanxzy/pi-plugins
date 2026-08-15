import Type, { type Static } from "typebox";

/**
 * Parameter schemas for the pi-c2 tools.
 *
 * The `agent` schema describes background-only delegation. `agent_id` targets
 * an existing job for steering or background resume.
 */

export const agentParams = Type.Object({
  description: Type.String({ description: "Short description of the delegated work." }),
  prompt: Type.String({ description: "Instruction to run in the subagent." }),
  subagent_type: Type.String({ description: "Name of the agent definition to run." }),
  agent_id: Type.Optional(Type.String({ description: "Existing job id to steer or resume in background. A running job is steered; a finished job is resumed from its stored transcript." })),
});

export const questionOptionSchema = Type.Object({
  label: Type.String({ description: "Display label for the option" }),
  description: Type.Optional(Type.String({ description: "Optional description shown below label" })),
});

export const questionParams = Type.Object({
  question: Type.String({ description: "The question to ask the user" }),
  options: Type.Array(questionOptionSchema, { description: "Options for the user to choose from" }),
});

export const cancelParams = Type.Object({
  job_id: Type.String({ description: "Id of the job to cancel." }),
});

export const statusParams = Type.Object({
  job_id: Type.String({ description: "Id of the job to query." }),
});

export const jobsParams = Type.Object({});

export const agentNoArgsParams = Type.Object({});

const telegramChatId = Type.String({
  pattern: "^\\d+$",
  description: "Explicit approved private chat id to target.",
});

const telegramSendTextAction = Type.Object({
  action: Type.Literal("send_text"),
  chat_id: telegramChatId,
  text: Type.String({ description: "The communication or report text to send to Telegram." }),
  format: Type.Optional(Type.Union([
    Type.Literal("plain"),
    Type.Literal("html"),
    Type.Literal("markdown_v2"),
  ], { description: "Presentation format; plain is the default." })),
  message_id: Type.Optional(Type.Integer({ description: "When supplied, reply to this Telegram message in the approved chat." })),
  link_preview_options: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: "Telegram link-preview overrides, passed only when requested." })),
  disable_notification: Type.Optional(Type.Boolean({ description: "Suppress the notification for this message when explicitly requested." })),
}, { additionalProperties: false });

const telegramChoiceOption = Type.Object({
  label: Type.String({ minLength: 1, maxLength: 64 }),
  value: Type.String({ minLength: 1, maxLength: 1000 }),
}, { additionalProperties: false });

const telegramMediaFileIdSource = Type.Object({
  kind: Type.Literal("file_id"),
  file_id: Type.String({ minLength: 1, maxLength: 256 }),
}, { additionalProperties: false });

const telegramMediaArtifactSource = Type.Object({
  kind: Type.Literal("artifact_id"),
  artifact_id: Type.String({ minLength: 1, maxLength: 128, pattern: "^[A-Za-z0-9][A-Za-z0-9_-]*$" }),
}, { additionalProperties: false });

const telegramMediaHttpsSource = Type.Object({
  kind: Type.Literal("https"),
  url: Type.String({ minLength: 1, maxLength: 2048, format: "uri" }),
}, { additionalProperties: false });

const telegramMediaSource = Type.Union([
  telegramMediaFileIdSource,
  telegramMediaArtifactSource,
  telegramMediaHttpsSource,
]);

const telegramSendMediaAction = Type.Object({
  action: Type.Literal("send_media"),
  chat_id: telegramChatId,
  media_type: Type.Union([Type.Literal("photo"), Type.Literal("document")]),
  source: telegramMediaSource,
  caption: Type.Optional(Type.String({ maxLength: 1024 })),
  filename: Type.Optional(Type.String({ maxLength: 255 })),
}, { additionalProperties: false });

const telegramSendChoicesAction = Type.Object({
  action: Type.Literal("send_choices"),
  chat_id: telegramChatId,
  question: Type.String({ minLength: 1, maxLength: 4000 }),
  choices: Type.Array(telegramChoiceOption, { minItems: 2, maxItems: 10 }),
  message_id: Type.Optional(Type.Integer({ minimum: 1 })),
}, { additionalProperties: false });

const telegramReactAction = Type.Object({
  action: Type.Literal("react"),
  chat_id: telegramChatId,
  message_id: Type.Integer({ minimum: 1, description: "Explicit Telegram message id to react to." }),
  emoji: Type.Union([
    Type.Literal("👍"), Type.Literal("👎"), Type.Literal("❤"), Type.Literal("🔥"), Type.Literal("🥰"),
    Type.Literal("👏"), Type.Literal("😁"), Type.Literal("🤔"), Type.Literal("🤯"), Type.Literal("😱"),
    Type.Literal("🤬"), Type.Literal("😢"), Type.Literal("🎉"), Type.Literal("🤩"), Type.Literal("🤮"),
    Type.Literal("💩"), Type.Literal("🙏"), Type.Literal("👌"), Type.Literal("🥱"), Type.Literal("🥴"),
    Type.Literal("😍"), Type.Literal("🌚"), Type.Literal("🌭"), Type.Literal("💯"), Type.Literal("🤣"),
    Type.Literal("⚡"), Type.Literal("🍌"), Type.Literal("🏆"), Type.Literal("💔"), Type.Literal("🤨"),
    Type.Literal("😐"), Type.Literal("🍓"), Type.Literal("🍾"), Type.Literal("💋"), Type.Literal("😈"),
    Type.Literal("😴"), Type.Literal("😭"), Type.Literal("🤓"), Type.Literal("👻"), Type.Literal("👀"),
    Type.Literal("🎃"), Type.Literal("🙈"), Type.Literal("😇"), Type.Literal("😨"), Type.Literal("🤝"),
    Type.Literal("✍"), Type.Literal("🤗"), Type.Literal("💅"), Type.Literal("🤪"), Type.Literal("🗿"),
    Type.Literal("🆒"), Type.Literal("💘"), Type.Literal("🙉"), Type.Literal("🦄"), Type.Literal("😘"),
    Type.Literal("😎"), Type.Literal("👾"), Type.Literal("🤷"), Type.Literal("😡"),
  ], { description: "A standard Telegram reaction emoji." }),
}, { additionalProperties: false });

export const telegramChatParams = Type.Union([telegramSendTextAction, telegramReactAction, telegramSendChoicesAction, telegramSendMediaAction]);

export const goalCreateParams = Type.Object({
  prompt: Type.String({ description: "Exact goal prompt to deliver on each interval.", maxLength: 1_000_000 }),
  interval: Type.Optional(Type.String({ description: "Optional positive duration such as 30s, 10m, 2h, or 1d; defaults to 10m." })),
});

export const goalPauseParams = Type.Object({
  reason: Type.String({ description: "Exact reason the goal is blocked or paused." }),
});

export const goalNoArgsParams = Type.Object({});
export type QuestionParams = Static<typeof questionParams>;
export type AgentParams = Static<typeof agentParams>;
export type CancelParams = Static<typeof cancelParams>;
export type StatusParams = Static<typeof statusParams>;
export type TelegramChatParams = Static<typeof telegramChatParams>;
export type GoalCreateParams = Static<typeof goalCreateParams>;
export type GoalPauseParams = Static<typeof goalPauseParams>;
