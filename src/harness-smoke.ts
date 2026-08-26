#!/usr/bin/env node
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { zstdDecompressSync } from "node:zlib";

const HUB_TOOL = "mcp__capability_hub__capability_hub";
const EXPECTED_ACTIONS = [
  "search",
  "inspect",
  "tools",
  "call",
  "skill.load",
  "status",
  "disable",
] as const;
const EXPECTED_FINAL_ASSISTANT_TEXT = "CAPABILITY_HUB_SMOKE_OK";
const EXTERNAL_EXPECTED_ACTIONS = [
  "search",
  "inspect",
  "enable",
  "tools",
  "call",
  "skill.load",
  "status",
  "disable",
  "status",
] as const;
const EXTERNAL_EXPECTED_FINAL_ASSISTANT_TEXT = "CAPABILITY_HUB_EXTERNAL_SMOKE_OK";
const EXTERNAL_PLAYWRIGHT_URL =
  "data:text/html,%3Ctitle%3Ecapability-hub-external-smoke-EXTERNAL_PLAYWRIGHT_OK%3C/title%3E%3Ch1%3EEXTERNAL_PLAYWRIGHT_OK%3C/h1%3E";
const VISIBLE_APPROVED_CAPABILITIES = ["web-search-neo", "unity-cli"] as const;
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const MAX_DIAGNOSTIC_CHARS = 2_000;

type UnknownRecord = Record<string, unknown>;

interface ProcessResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
}

export interface AutoSelectedLmStudioModel {
  modelKey: string;
  displayName?: string;
  sizeBytes: number;
}

export interface HarnessValidation {
  passed: boolean;
  sessionId?: string;
  permissionPreset?: string;
  modelSelection?: { provider?: string; model?: string };
  toolNames: string[];
  actions: string[];
  toolErrorCount: number;
  finalAssistantText: string;
  evidence: {
    searchFoundDemo: boolean;
    inspectedDemo: boolean;
    toolsListedAdd: boolean;
    sumFive: boolean;
    skillLoaded: boolean;
    statusEnabled: boolean;
    disabled: boolean;
    readOnly: boolean;
    exactFinalAssistantToken: boolean;
  };
  catalogVisibility: {
    webSearchNeo: boolean;
    unityCli: boolean;
    mode: "isolated-approved-metadata-only";
  };
  failures: string[];
}

export interface ExternalHarnessValidation {
  passed: boolean;
  sessionId?: string;
  permissionPreset?: string;
  modelSelection?: { provider?: string; model?: string };
  toolNames: string[];
  actions: string[];
  toolErrorCount: number;
  finalAssistantText: string;
  evidence: {
    sessionRecorded: boolean;
    searchFoundPlaywrightStopped: boolean;
    inspectedPinnedPlaywright: boolean;
    explicitlyEnabled: boolean;
    toolsListedNavigate: boolean;
    navigatedExternalPage: boolean;
    skillLoaded: boolean;
    statusEnabled: boolean;
    disabled: boolean;
    statusStopped: boolean;
    childStopped: boolean;
    readOnly: boolean;
    exactFinalAssistantToken: boolean;
  };
  catalogVisibility: {
    playwright: boolean;
    mode: "isolated-external-local";
  };
  failures: string[];
}

interface HarnessTrace {
  session: UnknownRecord | undefined;
  calls: Array<{ callId?: string; name: string; args: UnknownRecord | undefined }>;
  results: Map<string, { callId?: string; isError: boolean; text: string }>;
  permissionPreset: string | undefined;
  modelSelection: { provider?: string; model?: string };
  finalAssistantText: string;
  actions: string[];
  toolNames: string[];
  resultAt: (index: number) => { callId?: string; isError: boolean; text: string } | undefined;
  toolErrorCount: number;
}

function asRecord(value: unknown): UnknownRecord | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as UnknownRecord)
    : undefined;
}

function parseObject(value: unknown): UnknownRecord | undefined {
  if (typeof value === "string") {
    try {
      return asRecord(JSON.parse(value));
    } catch {
      return undefined;
    }
  }
  return asRecord(value);
}

function parseResultObject(value: string | undefined): UnknownRecord | undefined {
  if (!value) return undefined;
  const start = value.indexOf("{");
  const end = value.lastIndexOf("}");
  return start >= 0 && end >= start ? parseObject(value.slice(start, end + 1)) : undefined;
}

function nestedText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(nestedText).filter(Boolean).join("\n");
  const record = asRecord(value);
  if (!record) return "";
  return Object.values(record).map(nestedText).filter(Boolean).join("\n");
}

function toolResult(record: UnknownRecord): { callId?: string; isError: boolean; text: string } | undefined {
  if (record.type !== "tool/result") return undefined;
  const data = asRecord(record.data);
  const message = asRecord(data?.message);
  const content = Array.isArray(message?.content) ? message.content : [];
  const block = content.map(asRecord).find((candidate) => candidate?.type === "tool-result");
  if (!block) return undefined;
  return {
    ...(typeof block.toolCallId === "string" ? { callId: block.toolCallId } : {}),
    isError: block.isError === true,
    text: nestedText(block.content),
  };
}

function assistantText(record: UnknownRecord): string | undefined {
  if (record.type !== "assistant/message") return undefined;
  const message = asRecord(asRecord(record.data)?.message);
  if (message?.role !== "assistant" || !Array.isArray(message.content)) return undefined;
  const text = message.content
    .map(asRecord)
    .filter((block): block is UnknownRecord => block?.type === "text")
    .map((block) => (typeof block.text === "string" ? block.text : ""))
    .join("");
  return text || undefined;
}

function parseHarnessTrace(records: readonly unknown[]): HarnessTrace {
  const normalized = records.map(asRecord).filter((record): record is UnknownRecord => record !== undefined);
  const session = normalized.find((record) => record.type === "session");
  const calls = normalized
    .filter((record) => record.type === "tool/call")
    .map((record) => {
      const data = asRecord(record.data) ?? {};
      return {
        ...(typeof data.callId === "string" ? { callId: data.callId } : {}),
        name: typeof data.name === "string" ? data.name : "",
        args: parseObject(data.arguments),
      };
    });
  const results = new Map(
    normalized
      .map(toolResult)
      .filter((result): result is NonNullable<ReturnType<typeof toolResult>> => result !== undefined)
      .filter((result) => result.callId !== undefined)
      .map((result) => [result.callId as string, result]),
  );
  const permissionPreset = normalized
    .filter((record) => record.type === "permission/preset")
    .map((record) => asRecord(record.data)?.preset)
    .filter((preset): preset is string => typeof preset === "string")
    .at(-1);
  const requestHeader = normalized.find((record) => record.type === "request/header");
  const requestConfig = asRecord(asRecord(asRecord(requestHeader?.data)?.header)?.config);
  const modelSelection = {
    ...(typeof requestConfig?.provider === "string" ? { provider: requestConfig.provider } : {}),
    ...(typeof requestConfig?.model === "string" ? { model: requestConfig.model } : {}),
  };
  const finalAssistantText = normalized
    .map(assistantText)
    .filter((text): text is string => text !== undefined)
    .at(-1) ?? "";
  const actions = calls.map((call) => (typeof call.args?.action === "string" ? call.args.action : ""));
  const toolNames = [...new Set(calls.map((call) => call.name))];
  const resultAt = (index: number) => {
    const callId = calls[index]?.callId;
    return callId ? results.get(callId) : undefined;
  };
  const toolErrorCount = calls.filter((call) => {
    const result = call.callId ? results.get(call.callId) : undefined;
    return result === undefined || result.isError;
  }).length;
  return {
    session,
    calls,
    results,
    permissionPreset,
    modelSelection,
    finalAssistantText,
    actions,
    toolNames,
    resultAt,
    toolErrorCount,
  };
}

export function validateHarnessRecords(
  records: readonly unknown[],
  expectedSelection?: { provider: string; model: string },
): HarnessValidation {
  const {
    session,
    calls,
    permissionPreset,
    modelSelection,
    finalAssistantText,
    actions,
    toolNames,
    resultAt,
    toolErrorCount,
  } = parseHarnessTrace(records);
  const callArgs = calls[3]?.args;
  const childArguments = parseObject(callArgs?.argumentsJson);
  const searchText = resultAt(0)?.text ?? "";
  const evidence = {
    searchFoundDemo: /demo-echo/.test(searchText),
    inspectedDemo: /demo-echo/.test(resultAt(1)?.text ?? ""),
    toolsListedAdd: /(^|\W)add(\W|$)/.test(resultAt(2)?.text ?? ""),
    sumFive: /(^|\D)5(\D|$)/.test(resultAt(3)?.text ?? ""),
    skillLoaded: /skill_content|falsifiable|reproducible|ml experiment review/i.test(
      resultAt(4)?.text ?? "",
    ),
    statusEnabled: /demo-echo/.test(resultAt(5)?.text ?? "") && /enabled/.test(resultAt(5)?.text ?? ""),
    disabled:
      /demo-echo/.test(resultAt(6)?.text ?? "") && /"wasEnabled"\s*:\s*true/.test(resultAt(6)?.text ?? ""),
    readOnly: permissionPreset === "read-only",
    exactFinalAssistantToken: finalAssistantText === EXPECTED_FINAL_ASSISTANT_TEXT,
  };
  const catalogVisibility = {
    webSearchNeo: /web-search-neo/.test(searchText),
    unityCli: /unity-cli/.test(searchText),
    mode: "isolated-approved-metadata-only" as const,
  };
  const failures: string[] = [];
  if (calls.length !== EXPECTED_ACTIONS.length) {
    failures.push(`expected ${EXPECTED_ACTIONS.length} tool calls, observed ${calls.length}`);
  }
  if (toolNames.length !== 1 || toolNames[0] !== HUB_TOOL) {
    failures.push(`only ${HUB_TOOL} may be used`);
  }
  if (JSON.stringify(actions) !== JSON.stringify(EXPECTED_ACTIONS)) {
    failures.push(`unexpected action sequence: ${actions.join(" -> ")}`);
  }
  if (calls[0]?.args?.query !== undefined) failures.push("search must be unfiltered");
  if (calls[1]?.args?.name !== "demo-echo") failures.push("inspect must target demo-echo");
  if (calls[2]?.args?.name !== "demo-echo") failures.push("tools must target demo-echo");
  if (
    callArgs?.name !== "demo-echo" ||
    callArgs.tool !== "add" ||
    childArguments?.a !== 2 ||
    childArguments.b !== 3
  ) {
    failures.push("call must invoke demo-echo/add with a=2 and b=3");
  }
  if (calls[4]?.args?.name !== "ml-experiment-review") {
    failures.push("skill.load must target ml-experiment-review");
  }
  if (calls[6]?.args?.name !== "demo-echo") failures.push("disable must target demo-echo");
  if (toolErrorCount !== 0) failures.push(`${toolErrorCount} tool call(s) failed or have no result`);
  if (
    expectedSelection &&
    (modelSelection.provider !== expectedSelection.provider || modelSelection.model !== expectedSelection.model)
  ) {
    failures.push(
      `Harness selected ${modelSelection.provider ?? "unknown"}/${modelSelection.model ?? "unknown"}, expected ${expectedSelection.provider}/${expectedSelection.model}`,
    );
  }
  for (const [key, present] of Object.entries(evidence)) {
    if (!present) failures.push(`missing evidence: ${key}`);
  }
  for (const [key, present] of Object.entries(catalogVisibility)) {
    if (key !== "mode" && !present) failures.push(`missing catalog visibility: ${key}`);
  }
  return {
    passed: failures.length === 0,
    ...(typeof session?.id === "string" ? { sessionId: session.id } : {}),
    ...(permissionPreset === undefined ? {} : { permissionPreset }),
    ...(Object.keys(modelSelection).length === 0 ? {} : { modelSelection }),
    toolNames,
    actions,
    toolErrorCount,
    finalAssistantText,
    evidence,
    catalogVisibility,
    failures,
  };
}

export function validateExternalHarnessRecords(
  records: readonly unknown[],
  expectedSelection?: { provider: string; model: string },
): ExternalHarnessValidation {
  const {
    session,
    calls,
    permissionPreset,
    modelSelection,
    finalAssistantText,
    actions,
    toolNames,
    resultAt,
    toolErrorCount,
  } = parseHarnessTrace(records);
  const search = parseResultObject(resultAt(0)?.text);
  const searchEntries = Array.isArray(search?.capabilities) ? search.capabilities.map(asRecord) : [];
  const searchedPlaywright = searchEntries.find((entry) => entry?.name === "playwright");
  const inspected = parseResultObject(resultAt(1)?.text);
  const enabled = parseResultObject(resultAt(2)?.text);
  const tools = parseResultObject(resultAt(3)?.text);
  const listedTools = Array.isArray(tools?.tools) ? tools.tools.map(asRecord) : [];
  const callArgs = calls[4]?.args;
  const childArguments = parseObject(callArgs?.argumentsJson);
  const statusBefore = parseResultObject(resultAt(6)?.text);
  const enabledBefore = Array.isArray(statusBefore?.enabled) ? statusBefore.enabled.map(asRecord) : [];
  const disabled = parseResultObject(resultAt(7)?.text);
  const statusAfter = parseResultObject(resultAt(8)?.text);
  const enabledAfter = Array.isArray(statusAfter?.enabled) ? statusAfter.enabled : undefined;
  const navigationText = resultAt(4)?.text ?? "";
  const evidence = {
    sessionRecorded: typeof session?.id === "string" && /^session-/.test(session.id),
    searchFoundPlaywrightStopped: searchedPlaywright?.enabled === false,
    inspectedPinnedPlaywright:
      inspected?.name === "playwright" &&
      inspected.trusted === true &&
      inspected.source === "devDependency:@playwright/mcp@0.0.79",
    explicitlyEnabled:
      enabled?.enabled === "playwright" && typeof enabled.tools === "number" && enabled.tools > 0,
    toolsListedNavigate: listedTools.some((tool) => tool?.name === "browser_navigate"),
    navigatedExternalPage:
      /capability-hub-external-smoke/.test(navigationText) && /EXTERNAL_PLAYWRIGHT_OK/.test(navigationText),
    skillLoaded: /skill_content|falsifiable|reproducible|ml experiment review/i.test(
      resultAt(5)?.text ?? "",
    ),
    statusEnabled: enabledBefore.some((entry) => entry?.name === "playwright"),
    disabled: disabled?.disabled === "playwright" && disabled.wasEnabled === true,
    statusStopped: enabledAfter?.length === 0,
    childStopped:
      disabled?.disabled === "playwright" && disabled.wasEnabled === true && enabledAfter?.length === 0,
    readOnly: permissionPreset === "read-only",
    exactFinalAssistantToken: finalAssistantText === EXTERNAL_EXPECTED_FINAL_ASSISTANT_TEXT,
  };
  const catalogVisibility = {
    playwright: searchedPlaywright !== undefined,
    mode: "isolated-external-local" as const,
  };
  const failures: string[] = [];
  if (calls.length !== EXTERNAL_EXPECTED_ACTIONS.length) {
    failures.push(`expected ${EXTERNAL_EXPECTED_ACTIONS.length} tool calls, observed ${calls.length}`);
  }
  if (toolNames.length !== 1 || toolNames[0] !== HUB_TOOL) {
    failures.push(`only ${HUB_TOOL} may be used`);
  }
  if (JSON.stringify(actions) !== JSON.stringify(EXTERNAL_EXPECTED_ACTIONS)) {
    failures.push(`unexpected action sequence: ${actions.join(" -> ")}`);
  }
  if (calls[0]?.args?.query !== "browser automation") {
    failures.push('search must use query "browser automation"');
  }
  if (calls[1]?.args?.name !== "playwright") failures.push("inspect must target playwright");
  if (calls[2]?.args?.name !== "playwright") failures.push("enable must target playwright");
  if (calls[3]?.args?.name !== "playwright" || calls[3]?.args?.query !== "navigate") {
    failures.push('tools must target playwright with query "navigate"');
  }
  if (
    callArgs?.name !== "playwright" ||
    callArgs.tool !== "browser_navigate" ||
    childArguments?.url !== EXTERNAL_PLAYWRIGHT_URL
  ) {
    failures.push("call must invoke playwright/browser_navigate with the isolated data URL");
  }
  if (calls[5]?.args?.name !== "ml-experiment-review") {
    failures.push("skill.load must target ml-experiment-review");
  }
  if (calls[7]?.args?.name !== "playwright") failures.push("disable must target playwright");
  if (toolErrorCount !== 0) failures.push(`${toolErrorCount} tool call(s) failed or have no result`);
  if (
    expectedSelection &&
    (modelSelection.provider !== expectedSelection.provider || modelSelection.model !== expectedSelection.model)
  ) {
    failures.push(
      `Harness selected ${modelSelection.provider ?? "unknown"}/${modelSelection.model ?? "unknown"}, expected ${expectedSelection.provider}/${expectedSelection.model}`,
    );
  }
  for (const [key, present] of Object.entries(evidence)) {
    if (!present) failures.push(`missing evidence: ${key}`);
  }
  return {
    passed: failures.length === 0,
    ...(typeof session?.id === "string" ? { sessionId: session.id } : {}),
    ...(permissionPreset === undefined ? {} : { permissionPreset }),
    ...(Object.keys(modelSelection).length === 0 ? {} : { modelSelection }),
    toolNames,
    actions,
    toolErrorCount,
    finalAssistantText,
    evidence,
    catalogVisibility,
    failures,
  };
}

function packageRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
}

function tail(value: string): string {
  return value.length <= MAX_DIAGNOSTIC_CHARS ? value : value.slice(-MAX_DIAGNOSTIC_CHARS);
}

function positiveInteger(raw: string | undefined, fallback: number): number {
  const parsed = raw === undefined ? fallback : Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`Expected a positive integer, received ${raw}`);
  return parsed;
}

async function runProcess(
  command: string,
  args: readonly string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number },
): Promise<ProcessResult> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout = `${stdout}${chunk}`.slice(-100_000);
    });
    child.stderr.on("data", (chunk: string) => {
      stderr = `${stderr}${chunk}`.slice(-100_000);
    });
    child.once("error", reject);
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5_000).unref();
    }, options.timeoutMs);
    child.once("close", (exitCode, signal) => {
      clearTimeout(timer);
      resolve({ exitCode, signal, timedOut, stdout, stderr });
    });
  });
}

async function sessionFiles(directory: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) return await sessionFiles(target);
      return entry.isFile() && entry.name.endsWith(".zstd") ? [target] : [];
    }),
  );
  return nested.flat();
}

function decompressJsonLines(buffer: Buffer): unknown[] {
  const starts: number[] = [];
  for (let index = 0; index <= buffer.length - ZSTD_MAGIC.length; index += 1) {
    if (buffer.subarray(index, index + ZSTD_MAGIC.length).equals(ZSTD_MAGIC)) starts.push(index);
  }
  starts.push(buffer.length);
  const records: unknown[] = [];
  for (let index = 0; index < starts.length - 1; index += 1) {
    const start = starts[index];
    const end = starts[index + 1];
    if (start === undefined || end === undefined || start === end) continue;
    const text = zstdDecompressSync(buffer.subarray(start, end)).toString("utf8");
    for (const line of text.split(/\r?\n/).filter(Boolean)) records.push(JSON.parse(line));
  }
  return records;
}

async function readHarnessRecords(dshHome: string): Promise<unknown[]> {
  const files = await sessionFiles(path.join(dshHome, "sessions"));
  if (files.length !== 1) throw new Error(`Expected exactly one new Harness session, found ${files.length}`);
  const file = files[0];
  if (file === undefined) throw new Error("Harness session file is missing");
  return decompressJsonLines(await readFile(file));
}

function smokePrompt(): string {
  return [
    `Use exactly one tool named ${HUB_TOOL}.`,
    "Call it exactly seven times, in this order, with exactly these JSON arguments. Do not retry and do not use any other tool:",
    '1. {"action":"search"}',
    '2. {"action":"inspect","name":"demo-echo"}',
    '3. {"action":"tools","name":"demo-echo"}',
    '4. {"action":"call","name":"demo-echo","tool":"add","argumentsJson":"{\\"a\\":2,\\"b\\":3}"}',
    '5. {"action":"skill.load","name":"ml-experiment-review"}',
    '6. {"action":"status"}',
    '7. {"action":"disable","name":"demo-echo"}',
    `After all seven successful results, answer exactly ${EXPECTED_FINAL_ASSISTANT_TEXT} and nothing else.`,
  ].join("\n");
}

function externalSmokePrompt(): string {
  return [
    `Use exactly one tool named ${HUB_TOOL}.`,
    "Call it exactly nine times, in this order, with exactly these JSON arguments. Do not retry and do not use any other tool:",
    '1. {"action":"search","query":"browser automation"}',
    '2. {"action":"inspect","name":"playwright"}',
    '3. {"action":"enable","name":"playwright"}',
    '4. {"action":"tools","name":"playwright","query":"navigate"}',
    `5. {"action":"call","name":"playwright","tool":"browser_navigate","argumentsJson":"{\\"url\\":\\"${EXTERNAL_PLAYWRIGHT_URL}\\"}"}`,
    '6. {"action":"skill.load","name":"ml-experiment-review"}',
    '7. {"action":"status"}',
    '8. {"action":"disable","name":"playwright"}',
    '9. {"action":"status"}',
    `After all nine successful results, answer exactly ${EXTERNAL_EXPECTED_FINAL_ASSISTANT_TEXT} and nothing else.`,
  ].join("\n");
}

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, filePath);
}

async function writeIsolatedApprovedMetadata(root: string, stateDir: string): Promise<void> {
  const entries = await Promise.all(
    VISIBLE_APPROVED_CAPABILITIES.map(async (name) => {
      const proposal = parseObject(
        JSON.parse(await readFile(path.join(root, "examples", "catalog", `${name}.proposal.json`), "utf8")),
      );
      const entry = asRecord(proposal?.entry);
      if (entry?.name !== name) throw new Error(`Approved metadata fixture is missing for ${name}`);
      return { ...entry, trusted: true };
    }),
  );
  await writeJsonAtomic(path.join(stateDir, "approved.json"), { version: 1, entries });
}

async function writeExternalSmokeCatalog(root: string, tempHome: string): Promise<string> {
  const playwrightCli = path.join(root, "node_modules", "@playwright", "mcp", "cli.js");
  try {
    await access(playwrightCli);
  } catch {
    throw new Error(
      "The optional external smoke requires pinned @playwright/mcp@0.0.79 in this source checkout; run pnpm install. It never downloads the MCP at runtime",
    );
  }
  const outputDir = path.join(tempHome, "playwright-output");
  await mkdir(outputDir, { recursive: true });
  const catalogPath = path.join(tempHome, "external-catalog.json");
  await writeJsonAtomic(catalogPath, {
    version: 1,
    entries: [
      {
        kind: "mcp",
        name: "playwright",
        description: "Pinned local Playwright MCP used only by the optional external Harness smoke.",
        tags: ["browser", "automation", "external", "test"],
        trusted: true,
        source: "devDependency:@playwright/mcp@0.0.79",
        permissions: ["Starts an isolated headless browser and opens one inert data URL"],
        transport: {
          type: "stdio",
          command: process.execPath,
          args: [playwrightCli, "--headless", "--isolated", "--output-dir", outputDir],
        },
      },
      {
        kind: "skill",
        name: "ml-experiment-review",
        description: "Bundled skill used to verify lazy skill loading in the external smoke.",
        tags: ["ml", "experiment", "review"],
        trusted: true,
        source: "bundled example skill",
        permissions: ["Reads one local Markdown file"],
        skill: {
          type: "file",
          path: path.join(root, "data", "skills", "ml-experiment-review", "SKILL.md"),
          allowedRoots: [path.join(root, "data", "skills")],
        },
      },
    ],
  });
  return catalogPath;
}

function lmsCommand(): string {
  if (process.env.CAPABILITY_HUB_SMOKE_LMS_COMMAND) return process.env.CAPABILITY_HUB_SMOKE_LMS_COMMAND;
  if (process.platform === "win32" && process.env.USERPROFILE) {
    return path.join(process.env.USERPROFILE, ".lmstudio", "bin", "lms.exe");
  }
  return "lms";
}

function compactModelProcess(value: unknown): UnknownRecord | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const keys = [
    "identifier",
    "modelKey",
    "displayName",
    "status",
    "contextLength",
    "trainedForToolUse",
    "ttl",
  ];
  return Object.fromEntries(keys.filter((key) => record[key] !== undefined).map((key) => [key, record[key]]));
}

export function selectSmallestInstalledToolModel(value: unknown): AutoSelectedLmStudioModel | undefined {
  if (!Array.isArray(value)) return undefined;
  return value
    .map(asRecord)
    .filter((candidate): candidate is UnknownRecord => candidate !== undefined)
    .filter(
      (candidate) =>
        candidate.type === "llm" &&
        candidate.trainedForToolUse === true &&
        typeof candidate.modelKey === "string" &&
        candidate.modelKey.length > 0 &&
        typeof candidate.sizeBytes === "number" &&
        Number.isFinite(candidate.sizeBytes) &&
        candidate.sizeBytes >= 0,
    )
    .map((candidate) => ({
      modelKey: candidate.modelKey as string,
      ...(typeof candidate.displayName === "string" ? { displayName: candidate.displayName } : {}),
      sizeBytes: candidate.sizeBytes as number,
    }))
    .sort(
      (left, right) =>
        left.sizeBytes - right.sizeBytes || left.modelKey.localeCompare(right.modelKey, "en"),
    )[0];
}

function matchingModelProcess(processes: unknown, model: string, modelKey: string): unknown {
  if (!Array.isArray(processes)) return undefined;
  return processes.find((candidate) => {
    const record = asRecord(candidate);
    return record?.identifier === model || record?.modelKey === modelKey;
  });
}

function parseModelProcesses(result: ProcessResult): unknown {
  if (result.exitCode !== 0 || result.timedOut) return undefined;
  try {
    return JSON.parse(result.stdout) as unknown;
  } catch {
    return undefined;
  }
}

async function main(): Promise<void> {
  const root = packageRoot();
  const startedAt = new Date();
  const externalPlaywright =
    process.argv.includes("--external-playwright") || process.env.CAPABILITY_HUB_SMOKE_EXTERNAL === "1";
  const smokeMode = externalPlaywright ? "external-playwright" : "bundled";
  const provider = process.env.CAPABILITY_HUB_SMOKE_PROVIDER ?? "lmstudio";
  const explicitModel = process.env.CAPABILITY_HUB_SMOKE_MODEL;
  const explicitModelKey = process.env.CAPABILITY_HUB_SMOKE_MODEL_KEY;
  let model = explicitModel ?? "ling-3.0-tiny";
  let modelKey = explicitModelKey ?? model;
  const shouldAutoSelectModel =
    provider === "lmstudio" && explicitModel === undefined && explicitModelKey === undefined;
  const timeoutMs = positiveInteger(process.env.CAPABILITY_HUB_SMOKE_TIMEOUT_MS, 15 * 60_000);
  const ttlSeconds = positiveInteger(process.env.CAPABILITY_HUB_SMOKE_MODEL_TTL_SECONDS, 3_600);
  const receiptPath = path.resolve(
    process.env.CAPABILITY_HUB_SMOKE_RECEIPT ??
      path.join(root, "data", "state", "smoke-receipts", `${startedAt.toISOString().replace(/[:.]/g, "-")}.json`),
  );
  const tempHome = await mkdtemp(path.join(os.tmpdir(), "capability-hub-dsh-smoke-"));
  const capabilityState = path.join(tempHome, "capability-hub-state");
  let smokeCatalogPath = path.join(root, "data", "catalog.json");
  const managesLmStudioModel = provider === "lmstudio" || process.env.CAPABILITY_HUB_SMOKE_LOAD_MODEL === "1";
  let smokeEnvironment: NodeJS.ProcessEnv = { ...process.env };
  let installedModelListResult: ProcessResult | undefined;
  let autoSelectedModel: AutoSelectedLmStudioModel | undefined;
  let modelListBeforeResult: ProcessResult | undefined;
  let loadResult: ProcessResult | undefined;
  let unloadResult: ProcessResult | undefined;
  let harnessResult: ProcessResult | undefined;
  let modelProcess: unknown;
  let modelWasAlreadyLoaded = false;
  let modelLoadedBySmoke = false;
  let modelUnloaded = false;
  let validation: HarnessValidation | ExternalHarnessValidation | undefined;
  const failures: string[] = [];
  try {
    const profileDir = path.join(tempHome, "profiles", "headless");
    await mkdir(profileDir, { recursive: true });
    await writeFile(
      path.join(profileDir, "package.json"),
      `${JSON.stringify({
        name: "dsh-profile-headless-capability-hub-smoke",
        private: true,
        dependencies: {},
        dsh: { profile: { bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-headless"] } },
      }, null, 2)}\n`,
      "utf8",
    );
    await writeFile(path.join(profileDir, "cordis.patch.yml"), "[]\n", "utf8");
    if (externalPlaywright) {
      smokeCatalogPath = await writeExternalSmokeCatalog(root, tempHome);
    } else {
      await writeIsolatedApprovedMetadata(root, capabilityState);
    }

    if (shouldAutoSelectModel) {
      installedModelListResult = await runProcess(lmsCommand(), ["ls", "--json"], {
        cwd: root,
        env: smokeEnvironment,
        timeoutMs: 30_000,
      });
      autoSelectedModel = selectSmallestInstalledToolModel(parseModelProcesses(installedModelListResult));
      if (!autoSelectedModel) {
        failures.push("No installed LM Studio LLM with trainedForToolUse was found; no model was downloaded");
      } else {
        model = autoSelectedModel.modelKey;
        modelKey = autoSelectedModel.modelKey;
      }
    }

    let providerConfig: UnknownRecord | undefined;
    if (process.env.CAPABILITY_HUB_SMOKE_PROVIDER_CONFIG_JSON) {
      providerConfig = parseObject(process.env.CAPABILITY_HUB_SMOKE_PROVIDER_CONFIG_JSON) ?? {};
    } else if (provider === "lmstudio") {
      providerConfig = {
        displayName: "LM Studio",
        apiKeyEnv: "LMSTUDIO_API_KEY",
        api: "openai-completions",
        baseURL: process.env.CAPABILITY_HUB_SMOKE_BASE_URL ?? "http://127.0.0.1:1234/v1",
        compat: {
          supportsDeveloperRole: false,
          supportsReasoningEffort: false,
          maxTokensField: "max_tokens",
          supportsStrictMode: false,
        },
        models: [
          {
            id: model,
            name: model,
            contextWindow: 32_768,
            input: ["text"],
            reasoningEfforts: false,
          },
        ],
      };
    }
    const settingsPath = path.join(tempHome, "smoke-settings.json");
    const settings = {
      permission: { defaultPreset: "read-only" },
      "agent-default-model": { provider, model },
      ...(providerConfig === undefined
        ? {}
        : { "llm-pi-ai": { providers: { [provider]: providerConfig } } }),
    };
    await writeFile(
      settingsPath,
      `${JSON.stringify(settings, null, 2)}\n`,
      "utf8",
    );

    smokeEnvironment = {
      ...process.env,
      DSH_HOME: tempHome,
      DSH_PERMISSION_MODE: "read-only",
      DSH_TELEMETRY_DISABLED: "1",
      LMSTUDIO_API_KEY: process.env.LMSTUDIO_API_KEY ?? "lm-studio-local",
      CAPABILITY_HUB_SMOKE_SETTINGS: settingsPath,
      CAPABILITY_HUB_SMOKE_PROVIDER: provider,
      CAPABILITY_HUB_SMOKE_MODEL: model,
      CAPABILITY_HUB_SMOKE_SERVER: path.join(root, "dist", "src", "server.js"),
      CAPABILITY_HUB_SMOKE_CATALOG: smokeCatalogPath,
      CAPABILITY_HUB_SMOKE_STATE: capabilityState,
    };

    if (managesLmStudioModel) {
      modelListBeforeResult = await runProcess(lmsCommand(), ["ps", "--json"], {
        cwd: root,
        env: smokeEnvironment,
        timeoutMs: 30_000,
      });
      const processesBefore = parseModelProcesses(modelListBeforeResult);
      if (processesBefore === undefined) {
        failures.push("LM Studio model preflight failed; refusing an unsafe load/unload lifecycle");
      } else {
        const selectedBefore = matchingModelProcess(processesBefore, model, modelKey);
        modelWasAlreadyLoaded = selectedBefore !== undefined;
        modelProcess = compactModelProcess(selectedBefore);
        if (!modelWasAlreadyLoaded) {
          loadResult = await runProcess(
            lmsCommand(),
            [
              "load",
              modelKey,
              "--identifier",
              model,
              "--context-length",
              "32768",
              "--gpu",
              process.env.CAPABILITY_HUB_SMOKE_GPU ?? "max",
              "--parallel",
              "1",
              "--ttl",
              String(ttlSeconds),
              "-y",
            ],
            { cwd: root, env: smokeEnvironment, timeoutMs: Math.min(timeoutMs, 10 * 60_000) },
          );
          if (loadResult.exitCode !== 0 || loadResult.timedOut) {
            failures.push(`LM Studio model load failed (exit ${String(loadResult.exitCode)})`);
          } else {
            modelLoadedBySmoke = true;
            const processResult = await runProcess(lmsCommand(), ["ps", "--json"], {
              cwd: root,
              env: smokeEnvironment,
              timeoutMs: 30_000,
            });
            modelProcess = compactModelProcess(
              matchingModelProcess(parseModelProcesses(processResult), model, modelKey),
            );
            if (!modelProcess) failures.push("LM Studio did not report the selected model as loaded");
          }
        }
      }
    }

    if (failures.length === 0) {
      const dshEntry = path.resolve(
        process.env.CAPABILITY_HUB_SMOKE_DSH_ENTRY ??
          "C:/AI/work/deepseek-harness-runtime/node_modules/@deepseek-ai/dsh/lib/bin.js",
      );
      harnessResult = await runProcess(
        process.execPath,
        [
          dshEntry,
          "--profile",
          "headless",
          "--patch",
          path.join(root, "examples", "dsh", "harness-smoke.patch.yml"),
          externalPlaywright ? externalSmokePrompt() : smokePrompt(),
        ],
        { cwd: root, env: smokeEnvironment, timeoutMs },
      );
      if (harnessResult.exitCode !== 0 || harnessResult.timedOut) {
        failures.push(`Harness smoke failed (exit ${String(harnessResult.exitCode)})`);
      }
      try {
        const records = await readHarnessRecords(tempHome);
        validation = externalPlaywright
          ? validateExternalHarnessRecords(records, { provider, model })
          : validateHarnessRecords(records, { provider, model });
        failures.push(...validation.failures);
      } catch (error) {
        failures.push(error instanceof Error ? error.message : String(error));
      }
    }
  } catch (error) {
    failures.push(error instanceof Error ? error.message : String(error));
  } finally {
    const buildReceipt = () => {
      const uniqueFailures = [...new Set(failures)];
      return {
        schemaVersion: 1,
        mode: smokeMode,
        passed: uniqueFailures.length === 0,
        startedAt: startedAt.toISOString(),
        durationMs: Date.now() - startedAt.getTime(),
        sessionId: validation?.sessionId ?? null,
        selection: {
          provider,
          model,
          autoSelected: autoSelectedModel !== undefined,
          ...(autoSelectedModel?.displayName === undefined
            ? {}
            : { displayName: autoSelectedModel.displayName }),
          ...(autoSelectedModel === undefined ? {} : { sizeBytes: autoSelectedModel.sizeBytes }),
        },
        permissionPreset: validation?.permissionPreset ?? null,
        modelSelection: validation?.modelSelection ?? null,
        toolNames: validation?.toolNames ?? [],
        actions: validation?.actions ?? [],
        toolErrorCount: validation?.toolErrorCount ?? null,
        finalAssistantText: validation?.finalAssistantText ?? "",
        evidence: validation?.evidence ?? null,
        catalogVisibility: validation?.catalogVisibility ?? null,
        lmStudio: {
          managed: managesLmStudioModel,
          modelKey,
          ttlSeconds,
          modelWasAlreadyLoaded,
          loadedBySmoke: modelLoadedBySmoke,
          loadExitCode: loadResult?.exitCode ?? null,
          unloadExitCode: unloadResult?.exitCode ?? null,
          unloaded: modelUnloaded,
          process: modelProcess ?? null,
        },
        failures: uniqueFailures,
        ...(uniqueFailures.length === 0
          ? {}
          : {
              diagnostics: {
                modelPreflight: tail(
                  `${modelListBeforeResult?.stderr ?? ""}\n${modelListBeforeResult?.stdout ?? ""}`.trim(),
                ),
                installedModels: tail(
                  `${installedModelListResult?.stderr ?? ""}\n${installedModelListResult?.stdout ?? ""}`.trim(),
                ),
                modelLoad: tail(`${loadResult?.stderr ?? ""}\n${loadResult?.stdout ?? ""}`.trim()),
                modelUnload: tail(`${unloadResult?.stderr ?? ""}\n${unloadResult?.stdout ?? ""}`.trim()),
                harness: tail(`${harnessResult?.stderr ?? ""}\n${harnessResult?.stdout ?? ""}`.trim()),
              },
            }),
      };
    };

    // Persist the Harness evidence before cleanup. A successful smoke-owned load is
    // then released; a model observed during preflight is deliberately left alone.
    try {
      await writeJsonAtomic(receiptPath, buildReceipt());
    } catch (error) {
      failures.push(`Initial receipt write failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (modelLoadedBySmoke) {
      unloadResult = await runProcess(lmsCommand(), ["unload", model], {
        cwd: root,
        env: smokeEnvironment,
        timeoutMs: 30_000,
      }).catch((error) => ({
        exitCode: null,
        signal: null,
        timedOut: false,
        stdout: "",
        stderr: error instanceof Error ? error.message : String(error),
      }));
      modelUnloaded = unloadResult.exitCode === 0 && !unloadResult.timedOut;
      if (!modelUnloaded) failures.push(`LM Studio model unload failed (exit ${String(unloadResult.exitCode)})`);
    }

    const receipt = buildReceipt();
    await writeJsonAtomic(receiptPath, receipt);
    await rm(tempHome, { recursive: true, force: true }).catch(() => undefined);
    process.stdout.write(`${JSON.stringify({ receipt: receiptPath, passed: receipt.passed })}\n`);
    if (!receipt.passed) process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
