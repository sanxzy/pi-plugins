import Type, { type Static } from "typebox";

/**
 * Parameter schemas for the four pi-code tools.
 *
 * The `agent` schema mirrors the reference contract
 * `{ description, prompt, subagent_type, background, task_id }`
 * (references/opencode/packages/opencode/src/tool/task.ts), with the resume
 * parameter renamed to `agent_id` to match the tool name.
 */

export const agentParams = Type.Object({
  description: Type.String({ description: "Short description of the delegated work." }),
  prompt: Type.String({ description: "Instruction to run in the subagent." }),
  subagent_type: Type.String({ description: "Name of the agent definition to run." }),
  background: Type.Optional(Type.Boolean({ description: "Run in background and inject the result later (TUI only)." })),
  agent_id: Type.Optional(Type.String({ description: "Existing job id to resume or steer. A running job is steered; a finished job is resumed from its stored transcript." })),
});

export const cancelParams = Type.Object({
  job_id: Type.String({ description: "Id of the job to cancel." }),
});

export const statusParams = Type.Object({
  job_id: Type.String({ description: "Id of the job to query." }),
});

export const jobsParams = Type.Object({});

export type AgentParams = Static<typeof agentParams>;
export type CancelParams = Static<typeof cancelParams>;
export type StatusParams = Static<typeof statusParams>;