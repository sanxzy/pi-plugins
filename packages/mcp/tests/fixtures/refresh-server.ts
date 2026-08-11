import { readFileSync, watch } from "node:fs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  GetPromptRequestSchema,
  ReadResourceRequestSchema,
  ListResourceTemplatesRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

interface State {
  prompts: string[];
  resources: string[];
}

const stateFile = process.env.MCP_REFRESH_STATE_FILE!;
const notifyFile = process.env.MCP_REFRESH_NOTIFY_FILE!;
const state = (): State => JSON.parse(readFileSync(stateFile, "utf8")) as State;

const server = new Server(
  { name: "mcp-refresh-fixture", version: "1.0.0" },
  { capabilities: { prompts: { listChanged: true }, resources: { listChanged: true } } },
);

server.setRequestHandler(ListPromptsRequestSchema, async () => ({
  prompts: state().prompts.map((name) => ({ name, arguments: [{ name: "value" }] })),
}));
server.setRequestHandler(ListResourcesRequestSchema, async () => ({
  resources: state().resources.map((uri) => ({ uri, name: uri.split("/").pop() ?? uri, mimeType: "text/plain" })),
}));
server.setRequestHandler(GetPromptRequestSchema, async (request) => ({
  messages: [{ role: "user", content: { type: "text", text: `${request.params.name}:${request.params.arguments?.value ?? ""}` } }],
}));
server.setRequestHandler(ReadResourceRequestSchema, async (request) => ({
  contents: [{ uri: request.params.uri, mimeType: "text/plain", text: `resource:${request.params.uri}` }],
}));
server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({ resourceTemplates: [] }));

await server.connect(new StdioServerTransport());
watch(notifyFile, () => {
  void server.sendPromptListChanged();
  void server.sendResourceListChanged();
});
