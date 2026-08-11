import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";

export const MAX_LIST_PAGES = 1_000;

/** Follow MCP cursor pages while rejecting loops and pathological servers. */
export async function paginateTools(
  list: (cursor?: string) => Promise<{ tools: Tool[]; nextCursor?: string }>,
): Promise<Tool[]> {
  const tools: Tool[] = [];
  const cursors = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
    const result = await list(cursor);
    tools.push(...result.tools);
    if (result.nextCursor === undefined) return tools;
    if (cursors.has(result.nextCursor)) throw new Error(`MCP tools/list returned duplicate cursor: ${result.nextCursor}`);
    cursors.add(result.nextCursor);
    cursor = result.nextCursor;
  }
  throw new Error(`MCP tools/list exceeded ${MAX_LIST_PAGES} pages`);
}

/** List all tools from an initialized client with bounded request timeouts. */
export function listClientTools(client: Client, timeout: number): Promise<Tool[]> {
  return paginateTools(async (cursor) => client.listTools(cursor === undefined ? undefined : { cursor }, { timeout }));
}
