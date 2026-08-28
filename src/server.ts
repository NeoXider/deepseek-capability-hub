#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { CatalogRepository } from "./catalog.js";
import { CapabilityHub } from "./manager.js";
import { capabilityEntrySchema, hubInputShape } from "./schema.js";
import type { CapabilityEntry, HubInput, JsonValue } from "./types.js";

interface HubWireInput {
  action: HubInput["action"];
  query?: string;
  kind?: "mcp" | "skill";
  name?: string;
  tool?: string;
  argumentsJson?: string;
  configJson?: string;
  includeSchema?: boolean;
  entryJson?: string;
}

function parseJsonObject(text: string, field: string): Record<string, JsonValue> {
  const value: unknown = JSON.parse(text);
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw new Error(`${field} must contain a JSON object`);
  }
  return value as Record<string, JsonValue>;
}

function decodeWireInput(input: HubWireInput): HubInput {
  return {
    action: input.action,
    ...(input.query === undefined ? {} : { query: input.query }),
    ...(input.kind === undefined ? {} : { kind: input.kind }),
    ...(input.name === undefined ? {} : { name: input.name }),
    ...(input.tool === undefined ? {} : { tool: input.tool }),
    ...(input.argumentsJson === undefined
      ? {}
      : { arguments: parseJsonObject(input.argumentsJson, "argumentsJson") }),
    ...(input.configJson === undefined
      ? {}
      : { config: parseJsonObject(input.configJson, "configJson") }),
    ...(input.includeSchema === undefined ? {} : { includeSchema: input.includeSchema }),
    ...(input.entryJson === undefined
      ? {}
      : { entry: capabilityEntrySchema.parse(JSON.parse(input.entryJson)) as CapabilityEntry }),
  };
}

function argumentValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function errorResult(error: unknown): CallToolResult {
  const message = error instanceof Error ? error.message : String(error);
  return { isError: true, content: [{ type: "text", text: `Error: ${message}` }] };
}

const BASE_DESCRIPTION =
  "Search and inspect a compact catalog, enable a trusted MCP only when needed, list its tools, proxy a tool call, or load one skill body. " +
  'Action "tools" starts a stopped capability by itself, so "enable" is only for starting one deliberately. ' +
  "Avoid includeSchema unless you need the argument shape. Third-party proposals require human approval outside this MCP.";

// Roughly four characters per token; a hard character budget keeps the resident cost
// bounded without dragging a tokenizer into the server's dependencies.
const INLINE_CATALOG_CHAR_BUDGET = 3_000;

// The capability list ships INSIDE the resident description, rather than being something
// the model has to spend a `search` round trip to discover.
//
// This is not a guess. bench/accuracy.mjs measured the same 28 tasks on the same model
// with and without it: 92.9% -> 100% accuracy, and average turns 3.96 -> 2.43, for 223
// extra resident tokens on a four-entry catalog. The failures it removed were the ones
// where the task does not read like a search query, so the model never searched at all
// and simply answered without the capability.
//
// A large catalog would undo the saving this whole project exists for, so the list
// degrades: full descriptions, then names only, then a pointer to `search`.
function describeHub(repository: CatalogRepository): string {
  const entries = repository.all();
  if (entries.length === 0) return BASE_DESCRIPTION;

  const detailed = entries.map((entry) => `${entry.name} (${entry.kind}): ${entry.description}`).join(" | ");
  if (detailed.length <= INLINE_CATALOG_CHAR_BUDGET) {
    return `${BASE_DESCRIPTION}\nAvailable capabilities — ${detailed}`;
  }

  const names = entries.map((entry) => entry.name).join(", ");
  if (names.length <= INLINE_CATALOG_CHAR_BUDGET) {
    return `${BASE_DESCRIPTION}\nAvailable capabilities: ${names}. Use action "search" for descriptions.`;
  }

  return `${BASE_DESCRIPTION}\n${entries.length} capabilities are available; use action "search" to list them.`;
}

async function main(): Promise<void> {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const packageDir = path.resolve(moduleDir, "../..");
  const catalogPath = path.resolve(argumentValue("--catalog") ?? path.join(packageDir, "data", "catalog.json"));
  const stateDir = path.resolve(argumentValue("--state") ?? path.join(packageDir, "data", "state"));

  const repository = new CatalogRepository(catalogPath, stateDir);
  await repository.load();
  const hub = new CapabilityHub(repository);
  const server = new McpServer({ name: "neoxider-mcp-hub", version: "0.1.0" });
  server.server.onclose = () => void hub.close();

  server.registerTool(
    "capability_hub",
    {
      title: "Lazy MCP and skill capability hub",
      description: describeHub(repository),
      inputSchema: hubInputShape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (input, extra) => {
      try {
        return await hub.execute(decodeWireInput(input as HubWireInput), extra.signal);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  // A child that hangs in initialize would otherwise hold the exit for the SDK's full
  // 60s request timeout, so shutdown races a deadline rather than waiting on it.
  const shutdown = async (): Promise<void> => {
    await Promise.race([
      (async () => {
        await hub.close();
        await server.close();
      })(),
      new Promise((resolve) => setTimeout(resolve, 5000).unref()),
    ]);
  };
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"] as const) {
    process.once(signal, () => void shutdown().finally(() => process.exit(0)));
  }
  // StdioServerTransport never listens for end-of-input, so onclose never fires. With no
  // capability running the process happens to exit on its own, but a single live child
  // keeps the event loop alive and the hub lingers forever — one more orphan per host
  // restart. On Windows this is the only path that runs at all: SIGTERM there is
  // TerminateProcess, which no handler observes.
  process.stdin.once("end", () => void shutdown().finally(() => process.exit(0)));
  process.stdin.once("close", () => void shutdown().finally(() => process.exit(0)));

  await server.connect(new StdioServerTransport());
  process.stderr.write(`[capability-hub] ready; catalog=${catalogPath}; entries=${repository.all().length}\n`);
}

main().catch((error) => {
  process.stderr.write(`[capability-hub] fatal: ${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
