import { spawn } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
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
const policyMode = mode === "policy";
const server = new Server(
  { name: "mcp-pi-code-stdio", version: "1.0.0" },
  {
    capabilities: {
      ...(mode === "fail-discovery" || mode === "tools" ? { tools: {} } : {}),
      ...(fullCatalog || policyMode ? { tools: {}, prompts: { listChanged: true }, resources: { listChanged: true } } : {}),
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

if (policyMode) {
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      { name: "protected_read", description: "Protected tool", inputSchema: { type: "object", properties: { value: { type: "string" } } } },
      { name: "allowed_read", description: "Allowed tool", inputSchema: { type: "object", properties: { value: { type: "string" } } } },
      { name: "ask_read", description: "Ask tool", inputSchema: { type: "object", properties: { value: { type: "string" } } } },
    ],
  }));
  server.setRequestHandler(ListPromptsRequestSchema, async () => ({
    prompts: [
      { name: "protected_prompt", description: "Protected prompt", arguments: [{ name: "value" }] },
      { name: "allowed_prompt", description: "Allowed prompt", arguments: [{ name: "value" }] },
      { name: "ask_prompt", description: "Ask prompt", arguments: [{ name: "value" }] },
    ],
  }));
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: [
      { uri: "file:///protected", name: "protected", mimeType: "text/plain" },
      { uri: "file:///allowed", name: "allowed", mimeType: "text/plain" },
      { uri: "file:///ask", name: "ask", mimeType: "text/plain" },
    ],
  }));
  server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({ resourceTemplates: [] }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => ({
    content: [{ type: "text", text: `tool:${request.params.name}:${request.params.arguments?.value ?? ""}` }],
  }));
  server.setRequestHandler(GetPromptRequestSchema, async (request) => ({
    messages: [{ role: "user", content: { type: "text", text: `prompt:${request.params.name}:${request.params.arguments?.value ?? ""}` } }],
  }));
  server.setRequestHandler(ReadResourceRequestSchema, async (request) => ({
    contents: [{ uri: request.params.uri, mimeType: "text/plain", text: `resource:${request.params.uri}` }],
  }));
}

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