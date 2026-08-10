/**
 * Structured `details` payloads returned by the four pi-code tools.
 *
 * These types stay at the shared host boundary and are intentionally kept free
 * of PI SDK session handles and raw filesystem paths.
 */

/** Current lifecycle status of a job, mirroring the domain status union. */
export type JobStatus =
  | "created"
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted";

/** Public summary of a single job, as exposed to the model. */
export interface JobSummary {
  jobId: string;
  status: JobStatus;
  description: string;
  subagentType: string;
  parentJobId?: string;
  rootJobId: string;
  depth: number;
  createdAt: string;
  updatedAt: string;
}

/** Details payload for the `agent` tool. */
export interface AgentDetails {
  jobId: string;
  status: JobStatus;
  result?: string;
}

/** Edge-case outcome from the `agent` tool. */
export interface AgentErrorDetails {
  jobId?: string;
  reason: string;
}

/** Details payload for the `agent_status` tool. */
export interface StatusDetails {
  status: JobStatus;
  job?: JobSummary;
  controllable?: boolean;
  reason?: string;
}

/** Details payload for the `agent_jobs` tool. */
export interface JobsDetails {
  jobs: JobSummary[];
}

/** Public summary of an available agent definition. */
export interface AgentListEntry {
  name: string;
  description: string;
}

/** Details payload for the `agent_list` tool. */
export interface AgentListDetails {
  agents: AgentListEntry[];
}

/** Details payload for the `question` tool. */
export interface QuestionDetails {
  question: string;
  options: string[];
  answer: string | null;
  wasCustom?: boolean;
  index?: number;
}

/** Details payload for the `agent_cancel` tool. */
export interface CancelDetails {
  jobId: string;
  success: boolean;
  status?: JobStatus;
  reason?: string;
  allowed?: boolean;
}

/** Details payload for the parent-only Telegram communication tool. */
export interface TelegramChatDetails {
  action: "send_text" | "react";
  sent: boolean;
  chatId: string;
  message?: string;
  messageId?: number;
  emoji?: string;
  chunks?: number;
  messageIds?: number[];
  sentChunks?: number;
  failedChunks?: number;
  error?: string;
  category?: string;
}
