#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

const server = new McpServer({ name: "capability-hub-echo-fixture", version: "0.1.0" });

server.registerTool(
  "echo",
  {
    description: "Echo a text value. Used to verify lazy child MCP proxying.",
    inputSchema: { text: z.string() },
  },
  async ({ text }) => ({ content: [{ type: "text", text }] }),
);

server.registerTool(
  "add",
  {
    description: "Add two numbers.",
    inputSchema: { a: z.number(), b: z.number() },
  },
  async ({ a, b }) => ({
    content: [{ type: "text", text: String(a + b) }],
    structuredContent: { result: a + b },
  }),
);

server.registerTool(
  "wait",
  {
    description: "Wait for a bounded delay. Used to verify cancellation and child lifecycle cleanup.",
    inputSchema: { delayMs: z.number().int().min(1).max(10_000) },
  },
  async ({ delayMs }, extra) => {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, delayMs);
      extra.signal.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          reject(extra.signal.reason ?? new Error("wait aborted"));
        },
        { once: true },
      );
    });
    return { content: [{ type: "text", text: `waited ${delayMs}ms` }] };
  },
);

server.registerTool(
  "fail",
  {
    description: "Fail deliberately. Used to verify that a failed call does not leak or poison the child lifecycle.",
    inputSchema: {},
  },
  async () => {
    throw new Error("fixture failure");
  },
);

// Two failure shapes that both produce "no tools", for entirely different reasons, and
// which the hub must not confuse with each other or with a healthy server.
//
//   silent    answers tools/list normally with an empty array. This is what a Unity MCP
//             does when its editor is closed: the process is healthy, the list is empty,
//             and before this fixture existed the caller got no hint why.
//   toolless  has no tools/list handler at all and answers -32601 Method not found. A
//             server exposing only prompts or resources is legitimately like this.
//
// The silent handler is set on the underlying Server rather than through registerTool,
// because McpServer only wires tools/list once a first tool is registered — with none it
// would answer -32601 and collapse into the other case.
const mode = process.env.CAPABILITY_HUB_FIXTURE_MODE ?? "normal";

const silentServer = new McpServer(
  { name: "capability-hub-silent-fixture", version: "0.1.0" },
  { capabilities: { tools: {} } },
);
silentServer.server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: [] }));

const toolessServer = new McpServer({ name: "capability-hub-toolless-fixture", version: "0.1.0" });

const selected = mode === "silent" ? silentServer : mode === "toolless" ? toolessServer : server;

await selected.connect(new StdioServerTransport());
