import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

/**
 * Original Pi-native stdio test fixture. It advertises the `tools` capability
 * and serves a single `current_directory` tool whose description is the
 * process working directory, mirroring the reference behavior without reusing
 * its source.
 */
const server = new Server({ name: "mcp-pi-code-stdio", version: "1.0.0" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, () =>
  Promise.resolve({
    tools: [
      {
        name: "current_directory",
        description: process.cwd(),
        inputSchema: { type: "object", properties: {} },
      },
    ],
  }),
);

await server.connect(new StdioServerTransport());