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
}

export interface PiWorkerError {
  kind: "error";
  message: string;
}

export type PiWorkerMessage = PiWorkerEvent | PiWorkerResult | PiWorkerError;
