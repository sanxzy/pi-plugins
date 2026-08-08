import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import {
  createChildLiveFeed,
  type ChildLiveEvent,
  type ChildLiveFeed,
  type ChildLiveStatus,
} from "@xzy-ai/core";

/** Extract display text from SDK message content without exposing SDK types. */
function messageText(message: { content?: unknown }): string {
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content
    .map((part) => {
      if (!part || typeof part !== "object") return "";
      const value = part as { type?: unknown; text?: unknown; name?: unknown };
      if (value.type === "text" && typeof value.text === "string") return value.text;
      if (value.type === "toolCall" && typeof value.name === "string") return value.name;
      return "";
    })
    .filter(Boolean)
    .join("");
}

/**
 * Stable identity across SDK message events.
 *
 * The SDK emits a shallow copy (`{ ...partialMessage }`) on `message_start` and
 * every `message_update`, and the accumulated final object on `message_end`, so
 * the start/update/end events for one response never share an object identity.
 * Identity is therefore derived from lineage fields on the message rather than
 * object identity: `responseId` when the provider supplies one (stable across
 * the stream), otherwise the message timestamp (assigned once by the provider
 * and unchanged as the partial message accumulates).
 */
function messageId(message: object & { role?: string; responseId?: string; timestamp?: number }): string {
  const role = message.role ?? "message";
  const lineage = message.responseId ?? (message.timestamp !== undefined ? String(message.timestamp) : "unknown");
  return `${role}-${lineage}`;
}

function resultText(result: unknown): string {
  if (!result || typeof result !== "object") return "";
  const content = (result as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string"
      ? (part as { text: string }).text
      : ""))
    .filter(Boolean)
    .join("");
}

/** Normalize the SDK event subset consumed by the manager. */
export function mapAgentSessionEvent(event: AgentSessionEvent): ChildLiveEvent | undefined {
  switch (event.type) {
    case "message_start":
      if (event.message.role !== "user" && event.message.role !== "assistant") return undefined;
      return {
        type: "message",
        id: messageId(event.message),
        phase: "start",
        role: event.message.role,
        text: messageText(event.message),
      };
    case "message_update":
      if (event.message.role !== "user" && event.message.role !== "assistant") return undefined;
      return {
        type: "message",
        id: messageId(event.message),
        phase: "update",
        role: event.message.role,
        text: messageText(event.message),
      };
    case "message_end":
      if (event.message.role !== "user" && event.message.role !== "assistant") return undefined;
      return {
        type: "message",
        id: messageId(event.message),
        phase: "end",
        role: event.message.role,
        text: messageText(event.message),
      };
    case "tool_execution_start":
      return {
        type: "tool",
        id: event.toolCallId,
        phase: "start",
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        args: event.args,
        text: "",
      };
    case "tool_execution_update":
      return {
        type: "tool",
        id: event.toolCallId,
        phase: "update",
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        args: event.args,
        text: resultText(event.partialResult),
      };
    case "tool_execution_end":
      return {
        type: "tool",
        id: event.toolCallId,
        phase: "end",
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        text: resultText(event.result),
        isError: event.isError,
      };
    case "agent_end":
      return { type: "agent_end", willRetry: event.willRetry };
    case "agent_settled":
      return { type: "settled", status: "completed" };
    default:
      return undefined;
  }
}

/** Derive the terminal live status from the final assistant message. */
export function liveStatusForSession(session: AgentSession): Exclude<ChildLiveStatus, "running"> {
  const messages = session.agent.state.messages;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message?.role !== "assistant") continue;
    const stopReason = (message as { stopReason?: string }).stopReason;
    if (stopReason === "aborted") return "cancelled";
    if (stopReason === "error" || (message as { errorMessage?: string }).errorMessage) return "failed";
    return "completed";
  }
  return "failed";
}

/** Subscribe a normalized feed to one SDK session; disposal is independent of abort. */
export function attachAgentSessionLiveFeed(
  session: AgentSession,
): { feed: ChildLiveFeed; unsubscribe: () => void } {
  const feed = createChildLiveFeed();
  const unsubscribe = session.subscribe((event) => {
    const mapped = mapAgentSessionEvent(event);
    if (!mapped) return;
    if (mapped.type === "settled") {
      feed.emit({ type: "settled", status: liveStatusForSession(session) });
      return;
    }
    feed.emit(mapped);
  });
  return { feed, unsubscribe };
}
