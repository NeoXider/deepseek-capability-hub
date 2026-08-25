#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
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

await server.connect(new StdioServerTransport());
