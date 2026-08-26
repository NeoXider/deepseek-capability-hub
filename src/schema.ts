import { z } from "zod";

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
  url: z.url(),
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
  argumentsJson: z
    .string()
    .max(100_000)
    .optional()
    .describe('JSON object forwarded to the selected child MCP tool, for example {"query":"MCP"}.'),
  configJson: z
    .string()
    .max(100_000)
    .optional()
    .describe("JSON object with non-secret configuration. Only catalog-whitelisted keys are accepted."),
  includeSchema: z
    .boolean()
    .optional()
    .describe("Include full child tool schemas. Leave false unless arguments cannot be inferred."),
  entryJson: z
    .string()
    .max(200_000)
    .optional()
    .describe("JSON capability proposal. It remains untrusted until a human approves it outside this MCP."),
};
