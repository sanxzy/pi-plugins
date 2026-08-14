import { resolveSettingsForProject } from "@xzy-ai/runtime";

/** One lock policy shared by channel ownership and root-session cleanup. */
export interface ChannelLockPolicy {
  readonly staleMs: number;
  readonly updateMs: number;
  readonly acquireRetries: number;
}

export interface ChannelLockPolicyOverrides {
  readonly lockStaleMs?: number;
  readonly lockUpdateMs?: number;
  readonly lockAcquireRetries?: number;
}

/** Resolve one validated policy, preserving explicit constructor/test overrides. */
export function resolveChannelLockPolicy(
  projectRoot: string,
  overrides: ChannelLockPolicyOverrides = {},
): ChannelLockPolicy {
  const configured = resolveSettingsForProject(projectRoot).channels;
  return {
    staleMs: overrides.lockStaleMs ?? configured.lockStaleMs,
    updateMs: overrides.lockUpdateMs ?? configured.lockUpdateMs,
    acquireRetries: overrides.lockAcquireRetries ?? configured.lockAcquireRetries,
  };
}
