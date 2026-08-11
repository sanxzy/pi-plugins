import { spawn } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const mode = process.env.MCP_FIXTURE_MODE ?? "tools";

if (mode === "hang") {
  process.stderr.write("fixture startup is intentionally hanging\n");
  await new Promise<void>(() => {
    setInterval(() => undefined, 1_000);
  });
}

if (process.env.MCP_FIXTURE_STDERR === "1") {
  process.stderr.write(`${"stderr-".repeat(4096)}\n`);
}

if (process.env.MCP_FIXTURE_CHILD_PID_FILE) {
  const child = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], {
    detached: false,
    stdio: "ignore",
  });
  writeFileSync(process.env.MCP_FIXTURE_CHILD_PID_FILE, String(child.pid));
}

const fullCatalog = mode === "full-catalog";
const server = new Server(
  { name: "mcp-pi-code-stdio", version: "1.0.0" },
  {
    capabilities: {
      ...(mode === "fail-discovery" || mode === "tools" ? { tools: {} } : {}),
      ...(fullCatalog ? { tools: {}, prompts: { listChanged: true }, resources: { listChanged: true } } : {}),
    },
  },
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  if (mode === "fail-discovery") throw new Error("fixture discovery failed");
  return {
    tools: [
      {
        name: "current_directory",
        description: process.cwd(),
        inputSchema: { type: "object", properties: {} },
      },
    ],
  };
});

if (fullCatalog) {
  server.setRequestHandler(ListPromptsRequestSchema, async (request) =>
    request.params?.cursor
      ? { prompts: [{ name: "second_prompt" }] }
      : { prompts: [{ name: "first_prompt" }], nextCursor: "prompt-2" },
  );
  server.setRequestHandler(ListResourcesRequestSchema, async (request) =>
    request.params?.cursor
      ? { resources: [{ uri: "file:///second", name: "second_resource" }] }
      : { resources: [{ uri: "file:///first", name: "first_resource" }], nextCursor: "resource-2" },
  );
  server.setRequestHandler(ListResourceTemplatesRequestSchema, async (request) =>
    request.params?.cursor
      ? { resourceTemplates: [{ uriTemplate: "file:///second/{id}", name: "second_template" }] }
      : { resourceTemplates: [{ uriTemplate: "file:///first/{id}", name: "first_template" }], nextCursor: "template-2" },
  );
}

if (process.env.MCP_FIXTURE_READY_FILE) {
  appendFileSync(process.env.MCP_FIXTURE_READY_FILE, "ready\n");
}

await server.connect(new StdioServerTransport());