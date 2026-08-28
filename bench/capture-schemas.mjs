#!/usr/bin/env node
// Captures the FULL tool definitions of the benchmark servers, not just their token
// cost. `measure.mjs` only needs the cost, so its snapshots store `{name, cost}`.
// The accuracy benchmark has to put the real definitions in front of a real model,
// so it needs `{name, description, inputSchema}` verbatim.
//
// Written once, committed, and read offline afterwards, so the accuracy run is
// reproducible without network access and without re-downloading four npm packages.
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const benchDir = path.dirname(fileURLToPath(import.meta.url));
const outFile = path.join(benchDir, "snapshots", "full-tools.json");
const npx = process.platform === "win32" ? "npx.cmd" : "npx";

// Same pinned versions as measure.mjs, so both halves describe the same servers.
const SERVERS = [
  { name: "everything", package: "@modelcontextprotocol/server-everything@2026.8.18" },
  { name: "memory", package: "@modelcontextprotocol/server-memory@2026.7.4" },
  { name: "sequential-thinking", package: "@modelcontextprotocol/server-sequential-thinking@2026.7.4" },
  { name: "playwright", package: "@playwright/mcp@0.0.79" },
];

async function listTools(pkg) {
  const transport = new StdioClientTransport({
    command: npx,
    args: ["-y", pkg],
    env: { ...process.env },
    stderr: "ignore",
  });
  const client = new Client({ name: "capability-hub-schema-capture", version: "1.0.0" });
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
  for (const server of SERVERS) {
    process.stderr.write(`capturing ${server.name}...\n`);
    servers[server.name] = { package: server.package, tools: await listTools(server.package) };
    process.stderr.write(`  ${servers[server.name].tools.length} tools\n`);
  }
  mkdirSync(path.dirname(outFile), { recursive: true });
  writeFileSync(outFile, `${JSON.stringify({ servers }, null, 2)}\n`, "utf8");
  const total = Object.values(servers).reduce((sum, s) => sum + s.tools.length, 0);
  console.log(`wrote ${total} full tool definitions to ${outFile}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
