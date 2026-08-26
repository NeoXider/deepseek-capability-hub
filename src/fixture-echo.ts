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

await server.connect(new StdioServerTransport());
