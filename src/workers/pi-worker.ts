import path from "node:path";

import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSessionEvent,
} from "@earendil-works/pi-coding-agent";

import type { Material } from "../contracts.js";
import type { PiWorkerInput, PiWorkerMessage } from "../adapters/pi-protocol.js";
import { errorMessage, newId } from "../util.js";

let activeSession: { abort(): Promise<void>; dispose(): void } | undefined;

function send(message: PiWorkerMessage): void {
  if (process.send) {
    process.send(message);
  }
}

function providerApi(protocol: PiWorkerInput["provider"]["protocol"]): "openai-completions" | "anthropic-messages" {
  return protocol === "anthropic-compatible" ? "anthropic-messages" : "openai-completions";
}

function renderMaterial(material: Material): string {
  switch (material.kind) {
    case "file":
      return `- file: ${material.name || material.id}\n  path: ${material.path || "missing"}\n  media_type: ${material.mediaType}`;
    case "url":
      return `- url: ${material.name || material.id}\n  value: ${material.url || "missing"}`;
    case "json":
      return `- json: ${material.name || material.id}\n  value: ${JSON.stringify(material.data)}`;
    case "text":
      return `- text: ${material.name || material.id}\n  value: ${material.text || ""}`;
  }
}

async function sessionManagerFor(input: PiWorkerInput): Promise<SessionManager> {
  if (input.sessionPolicy === "ephemeral") {
    return SessionManager.inMemory(input.workspace, input.requestedSessionId ? { id: input.requestedSessionId } : undefined);
  }
  if (input.sessionPolicy === "resume") {
    const sessions = await SessionManager.list(input.workspace, input.sessionDir);
    const matching = sessions.find((session) => session.id === input.requestedSessionId);
    if (!matching) {
      throw new Error(`Session ${input.requestedSessionId} was not found`);
    }
    return SessionManager.open(matching.path, input.sessionDir, input.workspace);
  }
  return SessionManager.create(
    input.workspace,
    input.sessionDir,
    input.requestedSessionId ? { id: input.requestedSessionId } : undefined,
  );
}

function buildPrompt(input: PiWorkerInput, skillName: string | undefined): string {
  const materials = input.materials.length > 0 ? input.materials.map(renderMaterial).join("\n") : "- none";
  const request = [
    "Runtime Node request:",
    "",
    "Instruction:",
    input.instruction,
    "",
    "Materials:",
    materials,
  ].join("\n");
  return skillName ? `/skill:${skillName} ${request}` : request;
}

function extractAssistantText(event: AgentSessionEvent): string | undefined {
  if (event.type !== "message_end" || event.message.role !== "assistant") {
    return undefined;
  }
  return event.message.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n")
    .trim();
}

async function run(input: PiWorkerInput): Promise<void> {
  const apiKey = process.env.SOP_AGENTD_MODEL_API_KEY;
  if (!apiKey) {
    throw new Error("Model credential was not provided to the isolated worker");
  }

  const runtime = await ModelRuntime.create({ modelsPath: null });
  const options = input.provider.options;
  runtime.registerProvider(input.provider.provider, {
    baseUrl: input.provider.baseUrl,
    apiKey: "$SOP_AGENTD_MODEL_API_KEY",
    api: providerApi(input.provider.protocol),
    authHeader: options.authHeader === true,
    // Some API gateways reject the generic OpenAI SDK user-agent as bot traffic.
    // Use an explicit service identity without exposing credentials or user data.
    headers: { "user-agent": "sop-runtime-agentd/0.1" },
    models: [
      {
        id: input.provider.model,
        name: input.provider.model,
        reasoning: options.reasoning === true,
        input: options.images === true ? ["text", "image"] : ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: Number(options.contextWindow) || 128_000,
        maxTokens: Number(options.maxTokens) || 8_192,
      },
    ],
  });
  await runtime.setRuntimeApiKey(input.provider.provider, apiKey);
  const model = runtime.getModel(input.provider.provider, input.provider.model);
  if (!model) {
    throw new Error(`Model ${input.provider.provider}/${input.provider.model} is not available`);
  }

  const settingsManager = SettingsManager.inMemory(
    {
      compaction: { enabled: true },
      retry: { enabled: true, maxRetries: 2 },
      enableAnalytics: false,
      enableInstallTelemetry: false,
      enableSkillCommands: true,
      defaultProjectTrust: "always",
    },
    { projectTrusted: true },
  );
  const resourceLoader = new DefaultResourceLoader({
    cwd: input.workspace,
    agentDir: input.agentDir,
    settingsManager,
    noExtensions: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    noSkills: true,
    additionalSkillPaths: input.skill ? [input.skill.path] : [],
    appendSystemPrompt: [
      "You are the execution engine for one SOP Runtime Node.",
      "Use only the bound Skill when one is provided. Do not invent hidden adapter fields.",
      `Write every business output under SOP_OUTPUT_DIR: ${input.outputDir}`,
      "Treat manifest.json as a system index, not a business artifact.",
      "Use the instruction and materials as the complete public input contract.",
      "Return a concise execution summary after the Skill has actually completed.",
    ],
  });
  await resourceLoader.reload();
  const loadedSkills = resourceLoader.getSkills().skills;
  if (input.skill && loadedSkills.length !== 1) {
    throw new Error(`Expected exactly one bound Skill at ${input.skill.path}; loaded ${loadedSkills.length}`);
  }
  const skillName = loadedSkills[0]?.name;
  if (input.skill) {
    send({
      kind: "event",
      type: "skill.bound",
      subjectKind: "skill",
      subjectId: input.skill.id,
      summary: `Bound Skill ${input.skill.id}@${input.skill.version}`,
      data: { skillName, skillPath: input.skill.path, digest: input.skill.digest },
    });
  }

  const sessionManager = await sessionManagerFor(input);
  const { session } = await createAgentSession({
    cwd: input.workspace,
    agentDir: input.agentDir,
    model,
    thinkingLevel: options.thinking === "high" ? "high" : options.thinking === "low" ? "low" : "medium",
    modelRuntime: runtime,
    resourceLoader,
    tools: ["read", "bash", "edit", "write", "grep", "find", "ls"],
    sessionManager,
    settingsManager,
  });
  activeSession = session;
  const nativeRunId = newId("pi-run");
  let responseText = "";
  let runError = "";
  let deltaBuffer = "";
  let deltaTimer: NodeJS.Timeout | undefined;

  const flushDelta = (): void => {
    if (!deltaBuffer) return;
    send({
      kind: "event",
      type: "model.output.delta",
      subjectKind: "model",
      subjectId: `${input.provider.provider}/${input.provider.model}`,
      summary: "Agent generated response text",
      data: { text: deltaBuffer },
    });
    deltaBuffer = "";
    if (deltaTimer) clearTimeout(deltaTimer);
    deltaTimer = undefined;
  };

  const unsubscribe = session.subscribe((event) => {
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      deltaBuffer += event.assistantMessageEvent.delta;
      if (deltaBuffer.length >= 512) flushDelta();
      else if (!deltaTimer) deltaTimer = setTimeout(flushDelta, 250);
      return;
    }
    const finalText = extractAssistantText(event);
    if (finalText !== undefined) responseText = finalText;
    if (event.type === "message_end" && event.message.role === "assistant" && event.message.stopReason === "error") {
      runError = event.message.errorMessage || "Model request failed";
      send({
        kind: "event",
        type: "model.request.failed",
        subjectKind: "model",
        subjectId: `${input.provider.provider}/${input.provider.model}`,
        summary: runError,
        data: { stopReason: event.message.stopReason },
      });
    }
    if (event.type === "tool_execution_start") {
      send({
        kind: "event",
        type: "tool.execution.started",
        subjectKind: "tool",
        subjectId: event.toolCallId,
        summary: `${event.toolName} started`,
        data: { toolName: event.toolName, args: event.args },
      });
    } else if (event.type === "tool_execution_end") {
      send({
        kind: "event",
        type: event.isError ? "tool.execution.failed" : "tool.execution.completed",
        subjectKind: "tool",
        subjectId: event.toolCallId,
        summary: `${event.toolName} ${event.isError ? "failed" : "completed"}`,
        data: { toolName: event.toolName, isError: event.isError },
      });
    } else if (event.type === "agent_start") {
      send({
        kind: "event",
        type: "agent.turn.started",
        subjectKind: "session",
        subjectId: session.sessionId,
        summary: "Pi Agent started processing the Node request",
        data: { nativeRunId },
      });
    } else if (event.type === "agent_settled") {
      send({
        kind: "event",
        type: "agent.turn.settled",
        subjectKind: "session",
        subjectId: session.sessionId,
        summary: "Pi Agent finished processing the Node request",
        data: { nativeRunId },
      });
    }
  });

  try {
    await session.prompt(buildPrompt(input, skillName));
    await session.waitForIdle();
    flushDelta();
    if (runError) throw new Error(runError);
    send({ kind: "result", sessionId: session.sessionId, nativeRunId, responseText });
  } finally {
    flushDelta();
    unsubscribe();
    session.dispose();
    activeSession = undefined;
  }
}

process.on("message", (message: unknown) => {
  if (message && typeof message === "object" && "kind" in message && message.kind === "cancel") {
    void activeSession?.abort();
    return;
  }
  void run(message as PiWorkerInput).catch((error) => {
    send({ kind: "error", message: errorMessage(error) });
    activeSession?.dispose();
    activeSession = undefined;
  });
});

process.on("uncaughtException", (error) => {
  send({ kind: "error", message: errorMessage(error) });
  process.exitCode = 1;
});

process.on("unhandledRejection", (error) => {
  send({ kind: "error", message: errorMessage(error) });
  process.exitCode = 1;
});

if (!process.send) {
  throw new Error(`pi-worker must be started with an IPC channel (${path.basename(process.argv[1] || "worker")})`);
}
