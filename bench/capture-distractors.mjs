#!/usr/bin/env node
// Captures tool definitions for servers used purely as DISTRACTORS in the scale
// experiment. None of the 28 benchmark tasks is answerable by any tool in here.
//
// The point is to change exactly one variable. The tasks, their ground truth and the four
// answering servers stay identical; only the size of the haystack grows. Any accuracy
// difference between the small and large runs is therefore caused by catalog size and
// nothing else.
//
// Several of these servers want credentials (a GitHub token, a Slack token, a database
// URL). They are never called — only asked for `tools/list` — and a server that refuses
// to start without credentials is simply skipped and reported.
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const benchDir = path.dirname(fileURLToPath(import.meta.url));
const outFile = path.join(benchDir, "snapshots", "distractor-tools.json");
const npx = process.platform === "win32" ? "npx.cmd" : "npx";

const SERVERS = [
  { name: "filesystem", package: "@modelcontextprotocol/server-filesystem@2026.7.10", args: [os.tmpdir()] },
  { name: "github", package: "@modelcontextprotocol/server-github@2025.4.8" },
  { name: "slack", package: "@modelcontextprotocol/server-slack@2025.4.25" },
  { name: "puppeteer", package: "@modelcontextprotocol/server-puppeteer@2025.5.12" },
  { name: "gdrive", package: "@modelcontextprotocol/server-gdrive@2025.1.14" },
  { name: "redis", package: "@modelcontextprotocol/server-redis@2025.4.25" },
  { name: "brave-search", package: "@modelcontextprotocol/server-brave-search@0.6.2" },
  { name: "postgres", package: "@modelcontextprotocol/server-postgres@0.6.2", args: ["postgresql://localhost/postgres"] },
];

// Placeholders so credential-gated servers reach tools/list. Nothing here authenticates
// anything, and no tool from these servers is ever called.
const PLACEHOLDER_ENV = {
  GITHUB_PERSONAL_ACCESS_TOKEN: "bench-placeholder",
  SLACK_BOT_TOKEN: "xoxb-bench-placeholder",
  SLACK_TEAM_ID: "T0000000000",
  BRAVE_API_KEY: "bench-placeholder",
  REDIS_URL: "redis://localhost:6379",
  GDRIVE_CREDENTIALS_PATH: path.join(os.tmpdir(), "bench-gdrive-credentials.json"),
};

async function listTools(server) {
  const transport = new StdioClientTransport({
    command: npx,
    args: ["-y", server.package, ...(server.args ?? [])],
    env: { ...process.env, ...PLACEHOLDER_ENV },
    stderr: "ignore",
  });
  const client = new Client({ name: "capability-hub-distractor-capture", version: "1.0.0" });
  try {
    await client.connect(transport);
    const listed = await client.listTools(undefined, { timeout: 180_000 });
    return listed.tools.map((tool) => ({
      name: tool.name,
      description: tool.description ?? "",
      inputSchema: tool.inputSchema ?? { type: "object" },
    }));
  } finally {
    await client.close().catch(() => {});
  }
}

async function main() {
  if (existsSync(outFile) && !process.argv.includes("--force")) {
    console.log(`${outFile} exists; pass --force to re-capture`);
    return;
  }
  const servers = {};
  const skipped = [];
  for (const server of SERVERS) {
    process.stderr.write(`capturing ${server.name}...\n`);
    try {
      const tools = await listTools(server);
      servers[server.name] = { package: server.package, tools };
      process.stderr.write(`  ${String(tools.length)} tools\n`);
    } catch (error) {
      skipped.push({ name: server.name, reason: String(error instanceof Error ? error.message : error).slice(0, 200) });
      process.stderr.write(`  SKIPPED: ${String(error instanceof Error ? error.message : error).slice(0, 120)}\n`);
    }
  }
  mkdirSync(path.dirname(outFile), { recursive: true });
  writeFileSync(outFile, `${JSON.stringify({ servers, skipped }, null, 2)}\n`, "utf8");
  const total = Object.values(servers).reduce((sum, s) => sum + s.tools.length, 0);
  console.log(`wrote ${String(total)} distractor tools from ${String(Object.keys(servers).length)} servers`);
  if (skipped.length) console.log(`skipped: ${skipped.map((s) => s.name).join(", ")}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
