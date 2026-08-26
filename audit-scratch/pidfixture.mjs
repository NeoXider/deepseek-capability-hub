import { appendFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
appendFileSync(process.env.AUDIT_PIDFILE, `${process.pid}\n`);
const server = new McpServer({ name: "audit-pid-fixture", version: "0.1.0" });
server.registerTool("echo", { description: "echo", inputSchema: { text: z.string() } },
  async ({ text }) => ({ content: [{ type: "text", text }] }));
server.registerTool("die", { description: "exit hard", inputSchema: {} },
  async () => { setTimeout(() => process.exit(3), 50); return { content: [{ type: "text", text: "dying" }] }; });
server.registerTool("sleep", { description: "sleep", inputSchema: { ms: z.number() } },
  async ({ ms }) => { await new Promise(r => setTimeout(r, ms)); return { content: [{ type: "text", text: "ok" }] }; });
await server.connect(new StdioServerTransport());
