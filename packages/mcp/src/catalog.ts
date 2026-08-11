import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { RequestOptions } from "@modelcontextprotocol/sdk/shared/protocol.js";
import {
  PromptListChangedNotificationSchema,
  ResourceListChangedNotificationSchema,
  ToolListChangedNotificationSchema,
  type Prompt,
  type Resource,
  type ResourceTemplate,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";

export const MAX_LIST_PAGES = 1_000;

/** A server catalog assembled during discovery. */
export interface ServerCatalog {
  tools: Tool[];
  prompts: Prompt[];
  resources: Resource[];
  resourceTemplates: ResourceTemplate[];
  /** Last change notification observed, or undefined if none arrived. */
  listChanged?: "tools" | "prompts" | "resources";
}

export const EMPTY_CATALOG: ServerCatalog = { tools: [], prompts: [], resources: [], resourceTemplates: [] };

/** Follow MCP cursor pages while rejecting loops and pathological servers. */
export async function paginate<T>(
  list: (cursor?: string) => Promise<{ items: T[]; nextCursor?: string }>,
  maxPages = MAX_LIST_PAGES,
): Promise<T[]> {
  const items: T[] = [];
  const cursors = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < maxPages; page += 1) {
    const result = await list(cursor);
    items.push(...result.items);
    if (result.nextCursor === undefined) return items;
    if (cursors.has(result.nextCursor)) throw new Error(`MCP catalog/list returned duplicate cursor: ${result.nextCursor}`);
    cursors.add(result.nextCursor);
    cursor = result.nextCursor;
  }
  throw new Error(`MCP catalog/list exceeded ${maxPages} pages`);
}

/** Backward-compatible tool-only pagination helper. */
export function paginateTools(
  list: (cursor?: string) => Promise<{ tools: Tool[]; nextCursor?: string }>,
): Promise<Tool[]> {
  return paginate(async (cursor) => {
    const result = await list(cursor);
    return { items: result.tools, nextCursor: result.nextCursor };
  });
}

/** Discover the catalogs a server advertises, gated on its capabilities. */
export async function discoverCatalog(client: Client, timeout: number, signal?: AbortSignal): Promise<ServerCatalog> {
  const requestOptions: RequestOptions = {
    timeout,
    resetTimeoutOnProgress: true,
    ...(signal ? { signal } : {}),
  };
  const capabilities = client.getServerCapabilities();
  const catalog: ServerCatalog = { ...EMPTY_CATALOG };

  if (capabilities?.tools) {
    catalog.tools = await paginate<Tool>(async (cursor) => {
      const result = await client.listTools(cursor === undefined ? undefined : { cursor }, requestOptions);
      return { items: result.tools, nextCursor: result.nextCursor };
    });
  }
  if (capabilities?.prompts) {
    catalog.prompts = await paginate<Prompt>(async (cursor) => {
      const result = await client.listPrompts(cursor === undefined ? undefined : { cursor }, requestOptions);
      return { items: result.prompts, nextCursor: result.nextCursor };
    });
  }
  if (capabilities?.resources) {
    catalog.resources = await paginate<Resource>(async (cursor) => {
      const result = await client.listResources(cursor === undefined ? undefined : { cursor }, requestOptions);
      return { items: result.resources, nextCursor: result.nextCursor };
    });
    catalog.resourceTemplates = await paginate<ResourceTemplate>(async (cursor) => {
      const result = await client.listResourceTemplates(cursor === undefined ? undefined : { cursor }, requestOptions);
      return { items: result.resourceTemplates, nextCursor: result.nextCursor };
    });
  }
  return catalog;
}

/** Wire list-changed notifications to bump a change flag on the catalog. */
export function wireListChangedHandlers(client: Client, catalog: ServerCatalog): void {
  client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
    catalog.listChanged = "tools";
  });
  client.setNotificationHandler(PromptListChangedNotificationSchema, () => {
    catalog.listChanged = "prompts";
  });
  client.setNotificationHandler(ResourceListChangedNotificationSchema, () => {
    catalog.listChanged = "resources";
  });
}