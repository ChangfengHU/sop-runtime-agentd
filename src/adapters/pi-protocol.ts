import type { Material, ProviderProfile, SkillBinding } from "../contracts.js";

export interface PiWorkerInput {
  executionId: string;
  workspace: string;
  outputDir: string;
  instruction: string;
  materials: Material[];
  skill?: SkillBinding;
  provider: ProviderProfile;
  sessionPolicy: "ephemeral" | "persistent" | "resume";
  requestedSessionId: string;
  sessionDir: string;
  agentDir: string;
  /** 会话级工具白名单(来自 session.metadata.tool_allowlist);空 = 不限制。 */
  toolAllowlist?: string[];
  /** 会话写权限(来自 session.metadata.write_scope);"只读" 时剔除 bash/edit/write。 */
  writeScope?: string;
}

export interface PiWorkerEvent {
  kind: "event";
  type: string;
  subjectKind: "session" | "skill" | "model" | "tool";
  subjectId: string;
  summary: string;
  data: Record<string, unknown>;
}

export interface PiWorkerResult {
  kind: "result";
  sessionId: string;
  nativeRunId: string;
  responseText: string;
  reasoningText?: string;
}

export interface PiWorkerError {
  kind: "error";
  message: string;
}

export type PiWorkerMessage = PiWorkerEvent | PiWorkerResult | PiWorkerError;

export interface PiWorkerCancelCommand {
  kind: "cancel";
}

export interface PiWorkerSteerCommand {
  kind: "steer";
  message: string;
}

export type PiWorkerCommand = PiWorkerCancelCommand | PiWorkerSteerCommand;
