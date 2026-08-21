import { z } from "zod";

export const engineIdSchema = z.enum([
  "sop-native",
  "codex",
  "claude-code",
  "hermes",
  "openclaw",
  "deepseek-harness",
  "opencode",
  "mastra",
]);

export type EngineId = z.infer<typeof engineIdSchema>;

export const executionStatusSchema = z.enum([
  "queued",
  "running",
  "waiting_approval",
  "completed",
  "failed",
  "cancelled",
]);

export type ExecutionStatus = z.infer<typeof executionStatusSchema>;

export const materialSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(["text", "url", "file", "json"]),
  name: z.string().default(""),
  mediaType: z.string().default("application/octet-stream"),
  text: z.string().optional(),
  url: z.string().url().optional(),
  path: z.string().optional(),
  data: z.unknown().optional(),
  metadata: z.record(z.string(), z.unknown()).default({}),
});

export type Material = z.infer<typeof materialSchema>;

export const providerProfileSchema = z.object({
  id: z.string().min(1),
  protocol: z.enum(["openai-compatible", "anthropic-compatible"]),
  provider: z.string().min(1),
  baseUrl: z.string().url(),
  model: z.string().min(1),
  credentialRef: z.string().min(1),
  options: z.record(z.string(), z.unknown()).default({}),
});

export type ProviderProfile = z.infer<typeof providerProfileSchema>;

export const skillBindingSchema = z.object({
  id: z.string().min(1),
  version: z.string().default("unversioned"),
  path: z.string().min(1),
  digest: z.string().default(""),
});

export type SkillBinding = z.infer<typeof skillBindingSchema>;

export const sessionStatusSchema = z.enum(["idle", "active", "closed"]);

export type SessionStatus = z.infer<typeof sessionStatusSchema>;

export const createSessionSchema = z.object({
  requestId: z.string().min(1).optional(),
  instanceId: z.string().min(1),
  engine: engineIdSchema,
  workspace: z.string().min(1),
  providerId: z.string().min(1).optional(),
  title: z.string().default(""),
  metadata: z.record(z.string(), z.unknown()).default({}),
  // 可选:建会话时顺带发出第一轮,省掉客户端一次完整往返(隧道单程约 2s)
  firstInstruction: z.string().min(1).optional(),
});

export type CreateSessionInput = z.infer<typeof createSessionSchema>;

export const createTurnSchema = z.object({
  requestId: z.string().min(1).optional(),
  nodeId: z.string().min(1).optional(),
  instruction: z.string().min(1),
  materials: z.array(materialSchema).default([]),
  skill: skillBindingSchema.optional(),
  outputDir: z.string().min(1).optional(),
  timeoutMs: z.number().int().min(1_000).max(7_200_000).default(1_200_000),
  metadata: z.record(z.string(), z.unknown()).default({}),
});

export type CreateTurnInput = z.infer<typeof createTurnSchema>;

export const steerExecutionSchema = z.object({
  message: z.string().min(1),
});

export const setSessionProviderSchema = z.object({
  providerId: z.string().min(1),
});

export type SetSessionProviderInput = z.infer<typeof setSessionProviderSchema>;

export const resolveApprovalSchema = z.object({
  approvalId: z.string().min(1).optional(),
  decision: z.enum(["approve", "reject"]),
  note: z.string().default(""),
});

// webhook 触发后落点的类型域。目前只实现 session(往会话里追加一轮);
// task(看板任务)与 workflow-run 是已规划落点,先占住取值域,触发时会返回 501。
export const webhookTargetSchema = z.enum(["session", "task", "workflow-run"]);

export type WebhookTarget = z.infer<typeof webhookTargetSchema>;

export const createWebhookSchema = z.object({
  name: z.string().min(1),
  description: z.string().default(""),
  engine: engineIdSchema,
  providerId: z.string().min(1).optional(),
  workspace: z.string().min(1),
  instructionTemplate: z.string().min(1),
  minIntervalMs: z.number().int().min(0).default(3000),
  target: webhookTargetSchema.default("session"),
});

export type CreateWebhookInput = z.infer<typeof createWebhookSchema>;

export const setWebhookEnabledSchema = z.object({
  enabled: z.boolean(),
});

export interface WebhookRecord {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  engine: EngineId;
  providerId: string;
  workspace: string;
  instructionTemplate: string;
  secretHash: string;
  minIntervalMs: number;
  target: WebhookTarget;
  sessionId: string;
  createdAt: string;
  lastTriggeredAt: string;
  triggerCount: number;
}

export type PublicWebhookRecord = Omit<WebhookRecord, "secretHash">;

export interface SessionRecord {
  id: string;
  requestId: string;
  instanceId: string;
  engine: EngineId;
  providerId: string;
  workspace: string;
  title: string;
  status: SessionStatus;
  nativeSessionId: string;
  turnCount: number;
  activeExecutionId: string;
  lastExecutionId: string;
  createdAt: string;
  lastActivityAt: string;
  metadata: Record<string, unknown>;
}

export const createExecutionSchema = z.object({
  requestId: z.string().min(1).optional(),
  instanceId: z.string().min(1),
  nodeId: z.string().min(1).optional(),
  engine: engineIdSchema,
  workspace: z.string().min(1),
  outputDir: z.string().min(1),
  instruction: z.string().min(1),
  materials: z.array(materialSchema).default([]),
  skill: skillBindingSchema.optional(),
  providerId: z.string().min(1).optional(),
  sessionPolicy: z.enum(["ephemeral", "persistent", "resume"]).default("ephemeral"),
  sessionId: z.string().min(1).optional(),
  timeoutMs: z.number().int().min(1_000).max(7_200_000).default(1_200_000),
  metadata: z.record(z.string(), z.unknown()).default({}),
});

export type CreateExecutionInput = z.infer<typeof createExecutionSchema>;

export interface AgentCapabilities {
  persistentSessions: boolean;
  streamingEvents: boolean;
  toolEvents: boolean;
  approvals: boolean;
  steering: boolean;
  resume: boolean;
  subagents: boolean;
  nativeCancellation: boolean;
  skills: boolean;
  localWorkspace: boolean;
}

export interface ArtifactRecord {
  id: string;
  name: string;
  path: string;
  relativePath: string;
  mediaType: string;
  size: number;
  sha256: string;
  relayable: boolean;
}

export interface ExecutionRecord {
  id: string;
  requestId: string;
  instanceId: string;
  nodeId: string;
  sessionRef: string;
  engine: EngineId;
  status: ExecutionStatus;
  workspace: string;
  outputDir: string;
  sessionId: string;
  nativeRunId: string;
  instruction: string;
  materials: Material[];
  skill?: SkillBinding;
  provider?: ProviderProfile;
  sessionPolicy: "ephemeral" | "persistent" | "resume";
  timeoutMs: number;
  createdAt: string;
  startedAt: string;
  finishedAt: string;
  error: string;
  responseText: string;
  reasoningText?: string;
  artifacts: ArtifactRecord[];
  metadata: Record<string, unknown>;
}

export interface RuntimeEvent<T = unknown> {
  id: number;
  executionId: string;
  type: string;
  status: ExecutionStatus | SessionStatus;
  producer: string;
  subject: {
    kind: "execution" | "session" | "skill" | "model" | "tool" | "artifact" | "approval" | "webhook";
    id: string;
  };
  summary: string;
  data: T;
  occurredAt: string;
}

export interface AdapterRunContext {
  execution: ExecutionRecord;
  /** 同会话的历史轮次(仅对 persistentSessions=false 的引擎提供:它们每轮都是全新进程,
   *  拿不到上下文就会去翻工作目录猜、或直接编造答案)。按时间正序。 */
  history: Array<{ instruction: string; responseText: string }>;
  signal: AbortSignal;
  emit: (event: Omit<RuntimeEvent, "id" | "executionId" | "occurredAt">) => Promise<RuntimeEvent>;
}

export interface AdapterRunResult {
  sessionId: string;
  nativeRunId: string;
  responseText: string;
  reasoningText?: string;
}

export interface AgentRuntimeAdapter {
  readonly id: EngineId;
  readonly displayName: string;
  capabilities(): AgentCapabilities;
  probe(): Promise<{ ok: boolean; detail: Record<string, unknown>; reason: string }>;
  run(context: AdapterRunContext): Promise<AdapterRunResult>;
  cancel?(executionId: string): Promise<void>;
  /** 可选预热:会话创建时提前把常驻进程拉起来,让第一轮不必付冷启动(ACP 引擎用)。 */
  warmup?(input: { sessionId: string; workspace: string }): Promise<void>;
  steer?(executionId: string, message: string): Promise<void>;
  resolveApproval?(
    executionId: string,
    input: { approvalId: string; decision: "approve" | "reject"; note: string },
  ): Promise<void>;
}
