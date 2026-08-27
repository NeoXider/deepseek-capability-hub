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

async function main(): Promise<void> {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const packageDir = path.resolve(moduleDir, "../..");
  const catalogPath = path.resolve(argumentValue("--catalog") ?? path.join(packageDir, "data", "catalog.json"));
  const stateDir = path.resolve(argumentValue("--state") ?? path.join(packageDir, "data", "state"));

  const repository = new CatalogRepository(catalogPath, stateDir);
  await repository.load();
  const hub = new CapabilityHub(repository);
  const server = new McpServer({ name: "deepseek-capability-hub", version: "0.1.0" });
  server.server.onclose = () => void hub.close();

  server.registerTool(
    "capability_hub",
    {
      title: "Lazy MCP and skill capability hub",
      description:
        "Search and inspect a compact catalog, enable a trusted MCP only when needed, list its tools, proxy a tool call, or load one skill body. Start with search; avoid includeSchema unless necessary. Third-party proposals require human approval outside this MCP.",
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
