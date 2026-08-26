#!/usr/bin/env node
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
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
const EXPECTED_ACTIONS = ["search", "inspect", "call", "skill.load", "status", "disable"] as const;
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

export interface HarnessValidation {
  passed: boolean;
  sessionId?: string;
  permissionPreset?: string;
  modelSelection?: { provider?: string; model?: string };
  toolNames: string[];
  actions: string[];
  toolErrorCount: number;
  evidence: {
    searchFoundDemo: boolean;
    sumFive: boolean;
    skillLoaded: boolean;
    statusEnabled: boolean;
    disabled: boolean;
    readOnly: boolean;
  };
  failures: string[];
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

export function validateHarnessRecords(
  records: readonly unknown[],
  expectedSelection?: { provider: string; model: string },
): HarnessValidation {
  const normalized = records.map(asRecord).filter((record): record is UnknownRecord => record !== undefined);
  const session = normalized.find((record) => record.type === "session");
  const calls = normalized
    .filter((record) => record.type === "tool/call")
    .map((record) => {
      const data = asRecord(record.data) ?? {};
      return {
        callId: typeof data.callId === "string" ? data.callId : undefined,
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
  const permissionRecords = normalized
    .filter((record) => record.type === "permission/preset")
    .map((record) => asRecord(record.data)?.preset)
    .filter((preset): preset is string => typeof preset === "string");
  const permissionPreset = permissionRecords.at(-1);
  const requestHeader = normalized.find((record) => record.type === "request/header");
  const header = asRecord(asRecord(requestHeader?.data)?.header);
  const requestConfig = asRecord(header?.config);
  const modelSelection = {
    ...(typeof requestConfig?.provider === "string" ? { provider: requestConfig.provider } : {}),
    ...(typeof requestConfig?.model === "string" ? { model: requestConfig.model } : {}),
  };
  const actions = calls.map((call) => (typeof call.args?.action === "string" ? call.args.action : ""));
  const toolNames = [...new Set(calls.map((call) => call.name))];
  const resultAt = (index: number) => {
    const callId = calls[index]?.callId;
    return callId ? results.get(callId) : undefined;
  };
  const callArgs = calls[2]?.args;
  const childArguments = parseObject(callArgs?.argumentsJson);
  const evidence = {
    searchFoundDemo: /demo-echo/.test(resultAt(0)?.text ?? ""),
    sumFive: /(^|\D)5(\D|$)/.test(resultAt(2)?.text ?? ""),
    skillLoaded: /skill_content|falsifiable|reproducible|ml experiment review/i.test(
      resultAt(3)?.text ?? "",
    ),
    statusEnabled: /demo-echo/.test(resultAt(4)?.text ?? "") && /enabled/.test(resultAt(4)?.text ?? ""),
    disabled:
      /demo-echo/.test(resultAt(5)?.text ?? "") && /"wasEnabled"\s*:\s*true/.test(resultAt(5)?.text ?? ""),
    readOnly: permissionPreset === "read-only",
  };
  const toolErrorCount = calls.filter((call) => {
    const result = call.callId ? results.get(call.callId) : undefined;
    return result === undefined || result.isError;
  }).length;
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
  if (calls[0]?.args?.query !== "demo") failures.push('search must use query "demo"');
  if (calls[1]?.args?.name !== "demo-echo") failures.push("inspect must target demo-echo");
  if (
    callArgs?.name !== "demo-echo" ||
    callArgs.tool !== "add" ||
    childArguments?.a !== 2 ||
    childArguments.b !== 3
  ) {
    failures.push("call must invoke demo-echo/add with a=2 and b=3");
  }
  if (calls[3]?.args?.name !== "ml-experiment-review") {
    failures.push("skill.load must target ml-experiment-review");
  }
  if (calls[5]?.args?.name !== "demo-echo") failures.push("disable must target demo-echo");
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
    evidence,
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
    "Call it exactly six times, in this order, with exactly these JSON arguments. Do not retry and do not use any other tool:",
    '1. {"action":"search","query":"demo"}',
    '2. {"action":"inspect","name":"demo-echo"}',
    '3. {"action":"call","name":"demo-echo","tool":"add","argumentsJson":"{\\"a\\":2,\\"b\\":3}"}',
    '4. {"action":"skill.load","name":"ml-experiment-review"}',
    '5. {"action":"status"}',
    '6. {"action":"disable","name":"demo-echo"}',
    "After all six successful results, answer with one short sentence containing the sum and the loaded skill name.",
  ].join("\n");
}

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, filePath);
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

async function main(): Promise<void> {
  const root = packageRoot();
  const startedAt = new Date();
  const provider = process.env.CAPABILITY_HUB_SMOKE_PROVIDER ?? "lmstudio";
  const model = process.env.CAPABILITY_HUB_SMOKE_MODEL ?? "ling-3.0-tiny";
  const modelKey = process.env.CAPABILITY_HUB_SMOKE_MODEL_KEY ?? model;
  const timeoutMs = positiveInteger(process.env.CAPABILITY_HUB_SMOKE_TIMEOUT_MS, 15 * 60_000);
  const ttlSeconds = positiveInteger(process.env.CAPABILITY_HUB_SMOKE_MODEL_TTL_SECONDS, 3_600);
  const receiptPath = path.resolve(
    process.env.CAPABILITY_HUB_SMOKE_RECEIPT ??
      path.join(root, "data", "state", "smoke-receipts", `${startedAt.toISOString().replace(/[:.]/g, "-")}.json`),
  );
  const tempHome = await mkdtemp(path.join(os.tmpdir(), "capability-hub-dsh-smoke-"));
  let loadResult: ProcessResult | undefined;
  let harnessResult: ProcessResult | undefined;
  let modelProcess: unknown;
  let validation: HarnessValidation | undefined;
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

    const environment: NodeJS.ProcessEnv = {
      ...process.env,
      DSH_HOME: tempHome,
      DSH_PERMISSION_MODE: "read-only",
      DSH_TELEMETRY_DISABLED: "1",
      LMSTUDIO_API_KEY: process.env.LMSTUDIO_API_KEY ?? "lm-studio-local",
      CAPABILITY_HUB_SMOKE_SETTINGS: settingsPath,
      CAPABILITY_HUB_SMOKE_PROVIDER: provider,
      CAPABILITY_HUB_SMOKE_MODEL: model,
      CAPABILITY_HUB_SMOKE_SERVER: path.join(root, "dist", "src", "server.js"),
      CAPABILITY_HUB_SMOKE_CATALOG: path.join(root, "data", "catalog.json"),
      CAPABILITY_HUB_SMOKE_STATE: path.join(tempHome, "capability-hub-state"),
    };

    if (provider === "lmstudio" || process.env.CAPABILITY_HUB_SMOKE_LOAD_MODEL === "1") {
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
        { cwd: root, env: environment, timeoutMs: Math.min(timeoutMs, 10 * 60_000) },
      );
      if (loadResult.exitCode !== 0 || loadResult.timedOut) {
        failures.push(`LM Studio model load failed (exit ${String(loadResult.exitCode)})`);
      } else {
        const processResult = await runProcess(lmsCommand(), ["ps", "--json"], {
          cwd: root,
          env: environment,
          timeoutMs: 30_000,
        });
        if (processResult.exitCode === 0) {
          const processes = JSON.parse(processResult.stdout) as unknown;
          const selected = Array.isArray(processes)
            ? processes.find((candidate) => {
                const record = asRecord(candidate);
                return record?.identifier === model || record?.modelKey === modelKey;
              })
            : undefined;
          modelProcess = compactModelProcess(selected);
        }
        if (!modelProcess) failures.push("LM Studio did not report the selected model as loaded");
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
          smokePrompt(),
        ],
        { cwd: root, env: environment, timeoutMs },
      );
      if (harnessResult.exitCode !== 0 || harnessResult.timedOut) {
        failures.push(`Harness smoke failed (exit ${String(harnessResult.exitCode)})`);
      }
      try {
        validation = validateHarnessRecords(await readHarnessRecords(tempHome), { provider, model });
        failures.push(...validation.failures);
      } catch (error) {
        failures.push(error instanceof Error ? error.message : String(error));
      }
    }
  } catch (error) {
    failures.push(error instanceof Error ? error.message : String(error));
  } finally {
    const uniqueFailures = [...new Set(failures)];
    const receipt = {
      schemaVersion: 1,
      passed: uniqueFailures.length === 0,
      startedAt: startedAt.toISOString(),
      durationMs: Date.now() - startedAt.getTime(),
      selection: { provider, model, modelKey, ttlSeconds },
      lmStudio: {
        loadExitCode: loadResult?.exitCode ?? null,
        loaded: modelProcess !== undefined,
        process: modelProcess ?? null,
      },
      harness: {
        exitCode: harnessResult?.exitCode ?? null,
        timedOut: harnessResult?.timedOut ?? false,
        sessionId: validation?.sessionId ?? null,
        permissionPreset: validation?.permissionPreset ?? null,
        modelSelection: validation?.modelSelection ?? null,
        toolNames: validation?.toolNames ?? [],
        actions: validation?.actions ?? [],
        toolErrorCount: validation?.toolErrorCount ?? null,
      },
      evidence: validation?.evidence ?? null,
      failures: uniqueFailures,
      ...(uniqueFailures.length === 0
        ? {}
        : {
            diagnostics: {
              modelLoad: tail(`${loadResult?.stderr ?? ""}\n${loadResult?.stdout ?? ""}`.trim()),
              harness: tail(`${harnessResult?.stderr ?? ""}\n${harnessResult?.stdout ?? ""}`.trim()),
            },
          }),
    };
    await writeJsonAtomic(receiptPath, receipt);
    await rm(tempHome, { recursive: true, force: true }).catch(() => undefined);
    process.stdout.write(`${JSON.stringify({ receipt: receiptPath, passed: receipt.passed })}\n`);
    if (!receipt.passed) process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
