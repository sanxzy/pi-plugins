import { resolveSettingsForProject, type ChannelSettings } from "@xzy-ai/runtime";

/**
 * Resolve one validated channel-settings group for a project root.
 *
 * Channels already depend on `@xzy-ai/runtime`, so this helper is the single
 * seam every channel consumer uses to read validated centralized values while
 * preserving an injectable override for tests.
 */
export function resolveChannelSettings(projectRoot: string): ChannelSettings {
  return resolveSettingsForProject(projectRoot).channels;
}