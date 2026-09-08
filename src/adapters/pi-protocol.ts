import type { Material, ProviderProfile, SkillBinding } from "../contracts.js";
import type { McpModelTool } from "../mcp-session.js";

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
  /** 会话级工具白名单(来自 session.metadata.tool_allowlist);显式空列表不授予工具。 */
  toolAllowlist?: string[];
  /** 会话写权限(来自 session.metadata.write_scope);"只读" 时剔除 bash/edit/write。 */
  writeScope?: string;
  mcpTools?: McpModelTool[];
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

export interface PiWorkerMcpCall { kind: "mcp_call"; id: string; toolId: string; arguments: unknown }
export interface PiWorkerMcpResult { kind: "mcp_result"; id: string; result?: unknown; error?: string }
export type PiWorkerMessage = PiWorkerEvent | PiWorkerResult | PiWorkerError | PiWorkerMcpCall;

export interface PiWorkerCancelCommand {
  kind: "cancel";
}

export interface PiWorkerSteerCommand {
  kind: "steer";
  message: string;
}

export type PiWorkerCommand = PiWorkerCancelCommand | PiWorkerSteerCommand | PiWorkerMcpResult;
