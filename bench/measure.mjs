#!/usr/bin/env node
// Measures what a host actually has to put into a model's context to expose tools.
//
// Classic MCP: every configured server contributes every tool definition to the
// system prompt, permanently. Capability Hub contributes one tool definition, and
// pays instead at runtime for discovery calls. Both sides are measured here the
// same way: start the real server over stdio, ask for tools/list, and count tokens
// of the exact JSON a host injects per tool.
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { encode } from "gpt-tokenizer/encoding/o200k_base";

const benchDir = path.dirname(fileURLToPath(import.meta.url));
const packageDir = path.resolve(benchDir, "..");
const snapshotDir = path.join(benchDir, "snapshots");
const npx = process.platform === "win32" ? "npx.cmd" : "npx";

// Real, published MCP servers. Pinned so the published numbers stay reproducible.
const SERVERS = [
  { name: "everything", package: "@modelcontextprotocol/server-everything@2026.8.18", note: "MCP reference server" },
  { name: "memory", package: "@modelcontextprotocol/server-memory@2026.7.4", note: "Knowledge-graph memory" },
  { name: "sequential-thinking", package: "@modelcontextprotocol/server-sequential-thinking@2026.7.4", note: "Structured reasoning" },
  { name: "playwright", package: "@playwright/mcp@0.0.79", note: "Browser automation" },
];

// The heaviest real server in the catalog, so discovery is measured at its worst.
const DISCOVERY_TARGET = "playwright";

const tokens = (value) => encode(typeof value === "string" ? value : JSON.stringify(value)).length;

// A host injects at least the name, the description and the input schema per tool.
// Titles and annotations are omitted, so this is a conservative floor for the classic side.
const toolCost = (tool) =>
  tokens({ name: tool.name, description: tool.description ?? "", inputSchema: tool.inputSchema ?? {} });

async function withClient(command, args, env, run) {
  const transport = new StdioClientTransport({
    command,
    args,
    env: { ...process.env, ...env },
    stderr: "ignore",
  });
  const client = new Client({ name: "capability-hub-bench", version: "1.0.0" });
  try {
    await client.connect(transport);
    return await run(client);
  } finally {
    await client.close().catch(() => {});
  }
}

async function measureServer(server) {
  const snapshot = path.join(snapshotDir, `${server.name}.json`);
  if (existsSync(snapshot)) {
    const cached = JSON.parse(readFileSync(snapshot, "utf8"));
    return { ...server, ...cached, source: "snapshot" };
  }
  const listed = await withClient(npx, ["-y", server.package], {}, (client) => client.listTools(undefined, { timeout: 180_000 }));
  const tools = listed.tools.map((tool) => ({ name: tool.name, cost: toolCost(tool) }));
  const result = { tools, toolCount: tools.length, totalTokens: tools.reduce((sum, t) => sum + t.cost, 0) };
  mkdirSync(snapshotDir, { recursive: true });
  writeFileSync(snapshot, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  return { ...server, ...result, source: "live" };
}

// The hub is measured exactly like the others: start it, read its real tools/list.
async function measureHub() {
  const args = [
    path.join(packageDir, "dist", "src", "server.js"),
    "--catalog", path.join(benchDir, "catalog.json"),
    "--state", path.join(benchDir, "state"),
  ];
  return withClient(process.execPath, args, {}, async (client) => {
    const listed = await client.listTools(undefined, { timeout: 180_000 });
    const staticTokens = listed.tools.reduce((sum, tool) => sum + toolCost(tool), 0);

    // Runtime discovery: what a task actually spends to find and open one capability.
    const text = async (input) => {
      const result = await client.callTool({ name: "capability_hub", arguments: input }, undefined, { timeout: 180_000 });
      return result.content.map((part) => (part.type === "text" ? part.text : "")).join("");
    };
    const search = await text({ action: "search", query: "browser automation" });
    const inspect = await text({ action: "inspect", name: DISCOVERY_TARGET });
    const enabled = await text({ action: "enable", name: DISCOVERY_TARGET });
    const toolList = await text({ action: "tools", name: DISCOVERY_TARGET });
    await text({ action: "disable", name: DISCOVERY_TARGET });
    // An error string is cheap; counting one as "discovery cost" would fake the result.
    for (const [label, value] of [["search", search], ["inspect", inspect], ["enable", enabled], ["tools", toolList]]) {
      if (/^Error: /.test(value.trim())) throw new Error(`hub ${label} failed: ${value.trim().slice(0, 200)}`);
    }

    return {
      toolCount: listed.tools.length,
      staticTokens,
      discovery: {
        search: tokens(search),
        inspect: tokens(inspect),
        enable: tokens(enabled),
        tools: tokens(toolList),
        total: tokens(search) + tokens(inspect) + tokens(enabled) + tokens(toolList),
      },
    };
  });
}

async function main() {
  const measured = [];
  for (const server of SERVERS) {
    process.stderr.write(`measuring ${server.name}...\n`);
    try {
      measured.push(await measureServer(server));
    } catch (error) {
      process.stderr.write(`  SKIPPED ${server.name}: ${error instanceof Error ? error.message : String(error)}\n`);
      measured.push({ ...server, skipped: true, reason: String(error) });
    }
  }
  process.stderr.write("measuring capability hub...\n");
  const hub = await measureHub();

  const usable = measured.filter((entry) => !entry.skipped);
  const classicTotal = usable.reduce((sum, entry) => sum + entry.totalTokens, 0);
  const classicTools = usable.reduce((sum, entry) => sum + entry.toolCount, 0);
  // A task opens one capability, so it pays the hub schema plus one discovery round trip.
  const hubPerTask = hub.staticTokens + hub.discovery.total;

  const report = {
    measuredAt: process.env.BENCH_TIMESTAMP ?? null,
    encoding: "o200k_base",
    servers: measured,
    classic: { servers: usable.length, tools: classicTools, staticTokens: classicTotal },
    hub: { staticTokens: hub.staticTokens, discovery: hub.discovery, perTaskTokens: hubPerTask },
    savings: {
      staticRatio: Number((classicTotal / hub.staticTokens).toFixed(1)),
      staticPercent: Number((100 * (1 - hub.staticTokens / classicTotal)).toFixed(1)),
      perTaskPercent: Number((100 * (1 - hubPerTask / classicTotal)).toFixed(1)),
      breakEvenTasks: Number((classicTotal / hub.discovery.total).toFixed(1)),
    },
  };

  writeFileSync(path.join(benchDir, "results.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");

  const rows = usable.map((entry) =>
    `| \`${entry.package.split("@").slice(0, -1).join("@")}\` | ${entry.note} | ${entry.toolCount} | ${entry.totalTokens.toLocaleString("en-US")} |`,
  );
  console.log(`| Server | Purpose | Tools | Context tokens |`);
  console.log(`|---|---|---:|---:|`);
  console.log(rows.join("\n"));
  console.log(`| **Total (classic MCP)** | | **${classicTools}** | **${classicTotal.toLocaleString("en-US")}** |`);
  console.log(`| **Capability Hub** | one broker tool | **${hub.toolCount}** | **${hub.staticTokens.toLocaleString("en-US")}** |`);
  console.log("");
  console.log(`Static reduction: ${report.savings.staticPercent}% (${report.savings.staticRatio}x smaller)`);
  console.log(`Discovery cost per task: ${hub.discovery.total} tokens (search ${hub.discovery.search} + inspect ${hub.discovery.inspect} + enable ${hub.discovery.enable} + tools ${hub.discovery.tools})`);
  console.log(`Hub total for a one-capability task: ${hubPerTask} tokens -> ${report.savings.perTaskPercent}% below classic`);
  console.log(`Break-even: the hub stays ahead until about ${report.savings.breakEvenTasks} discovery round trips in one session`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
