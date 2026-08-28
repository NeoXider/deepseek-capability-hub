import { z } from "zod";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

const nameSchema = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(80);
const stringList = z.array(z.string().min(1).max(500)).max(100).optional();

const capabilityBaseSchema = z.object({
  kind: z.enum(["mcp", "skill"]),
  name: nameSchema,
  description: z.string().min(1).max(2_000),
  tags: stringList,
  trusted: z.boolean(),
  source: z.string().max(2_000).optional(),
  permissions: stringList,
});

const stdioTransportSchema = z.object({
  type: z.literal("stdio"),
  command: z.string().min(1).max(2_000),
  args: z.array(z.string().max(4_000)).max(200).optional(),
  cwd: z.string().max(2_000).optional(),
  requiredEnv: stringList,
  env: z.record(z.string(), z.string().max(8_000)).optional(),
});

const httpTransportSchema = z.object({
  type: z.literal("streamable-http"),
  // z.url() accepts any scheme, so a catalog entry could name file:// or point plain http
  // at an internal host. Encrypted transport is required, except on loopback where there
  // is no network to intercept and local development would otherwise need certificates.
  url: z
    .url()
    .refine((value) => {
      try {
        const url = new URL(value);
        if (url.protocol === "https:") return true;
        return url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname);
      } catch {
        return false;
      }
    }, "A streamable-http transport must use https, or http on loopback"),
  headersFromEnv: z
    .record(
      z.string(),
      z.object({
        env: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
        prefix: z.string().max(200).optional(),
      }),
    )
    .optional(),
});

export const mcpCapabilitySchema = capabilityBaseSchema.extend({
  kind: z.literal("mcp"),
  transport: z.union([stdioTransportSchema, httpTransportSchema]),
  configurable: stringList,
});

export const skillCapabilitySchema = capabilityBaseSchema.extend({
  kind: z.literal("skill"),
  skill: z.object({
    type: z.literal("file"),
    path: z.string().min(1).max(2_000),
    allowedRoots: stringList,
  }),
});

export const capabilityEntrySchema = z.discriminatedUnion("kind", [
  mcpCapabilitySchema,
  skillCapabilitySchema,
]);

export const proposalDocumentSchema = z.object({
  id: z.uuid(),
  createdAt: z.iso.datetime(),
  entry: capabilityEntrySchema,
});

export const catalogDocumentSchema = z.object({
  version: z.literal(1),
  entries: z.array(capabilityEntrySchema).max(10_000),
});

export const persistedConfigSchema = z.object({
  version: z.literal(1),
  capabilities: z.record(z.string(), z.record(z.string(), z.json())),
});

export const hubInputShape = {
  action: z
    .enum([
      "search",
      "inspect",
      "status",
      "configure",
      "enable",
      "disable",
      "tools",
      "call",
      "skill.load",
      "propose",
      "proposals",
      "catalog.reload",
    ])
    .describe("Operation to perform."),
  query: z.string().max(500).optional().describe("Search text. With action search it filters the catalog; with action tools it filters that server's tool names and descriptions."),
  kind: z.enum(["mcp", "skill"]).optional().describe("Optional capability type filter."),
  name: z.string().max(80).optional().describe("Exact capability name."),
  tool: z.string().max(500).optional().describe("Raw child MCP tool name for call."),
  // One payload field instead of three. `argumentsJson`, `configJson` and `entryJson`
  // were mutually exclusive — no action ever read more than one — yet every host paid
  // for all three schemas in every prompt. A measured decomposition of the 466-token
  // resident cost put 288 of it in this input schema, more than the catalog listing and
  // the description put together, which made the redundancy the largest target left.
  //
  // This is a breaking change with no compatibility shim, because the MCP SDK strips
  // unknown keys against this shape before the handler ever runs — a shim could not fire.
  payloadJson: z
    .string()
    .max(200_000)
    .optional()
    .describe(
      'JSON object for the action: arguments for call (e.g. {"url":"https://example.com"}), non-secret whitelisted configuration for configure and enable, or a capability proposal for propose.',
    ),
  includeSchema: z
    .boolean()
    .optional()
    .describe("Include full child tool schemas. Leave false unless arguments cannot be inferred."),
};
