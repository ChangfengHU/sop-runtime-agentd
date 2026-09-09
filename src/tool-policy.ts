import { configuredSkillBindingsSchema } from "./skill-bindings.js";
import { SupervisorError } from "./util.js";
import { isReadOnlyWriteScope as readOnly } from "./tool-allowlist.js";
import { mcpBindingSchema } from "./mcp-session.js";

type Metadata = Record<string, unknown>;
const owns = (metadata: Metadata, key: string): boolean => Object.hasOwn(metadata, key);

function validateShape(metadata: Metadata): void {
  if (owns(metadata, "skill_bindings") && !configuredSkillBindingsSchema.safeParse(metadata.skill_bindings).success) throw new SupervisorError("invalid_skill_bindings", 403);
  if (owns(metadata, "tool_allowlist")) {
    const tools = metadata.tool_allowlist;
    if (!Array.isArray(tools) || tools.some((tool) =>
      typeof tool !== "string" || !tool.trim() || tool !== tool.trim() || tool.includes("*"))) {
      throw new SupervisorError("invalid_tool_allowlist", 403);
    }
    if (!tools.length) throw new SupervisorError("empty_tool_allowlist_denied", 403);
  }
  if (owns(metadata, "write_scope") && typeof metadata.write_scope !== "string") {
    throw new SupervisorError("invalid_write_scope", 403);
  }
  if (owns(metadata, "mcp_bindings")) {
    if (!Array.isArray(metadata.mcp_bindings) || metadata.mcp_bindings.length > 20 || metadata.mcp_bindings.some((binding) => !mcpBindingSchema.safeParse(binding).success)) {
      throw new SupervisorError("invalid_mcp_bindings", 403);
    }
  }
}

/** Reject declared restrictions that the selected adapter cannot enforce. */
export function assertToolPolicy(engine: string, metadata: Metadata): void {
  validateShape(metadata);
  const agentBound = ["preset_id", "ops_agent_id", "agent_access_snapshot"].some((key) => owns(metadata, key));
  if (agentBound && !owns(metadata, "tool_allowlist")) {
    throw new SupervisorError("agent_tool_allowlist_required", 403);
  }
  if ((metadata.tool_allowlist as string[] | undefined)?.some((name) => name.includes("::")) &&
      (!Array.isArray(metadata.mcp_bindings) || !metadata.mcp_bindings.length || !metadata.agent_access_snapshot)) {
    throw new SupervisorError("mcp_binding_required", 403);
  }
  if (engine !== "sop-native" && (owns(metadata, "tool_allowlist") || owns(metadata, "skill_bindings") || readOnly(metadata.write_scope))) {
    throw new SupervisorError("engine_tool_policy_not_supported", 403);
  }
}

/** A turn can narrow the session's tools, but cannot replace its policy or identity. */
export function mergeTurnMetadata(session: Metadata, turn: Metadata): Metadata {
  validateShape(session);
  validateShape(turn);
  const merged = { ...turn };
  if (owns(session, "tool_allowlist")) {
    const ceiling = session.tool_allowlist as string[];
    merged.tool_allowlist = owns(turn, "tool_allowlist")
      ? ceiling.filter((tool) => (turn.tool_allowlist as string[]).includes(tool))
      : [...ceiling];
  }
  if (owns(session, "write_scope") && (readOnly(session.write_scope) || !owns(turn, "write_scope"))) {
    merged.write_scope = session.write_scope;
  }
  for (const key of ["preset_id", "ops_agent_id", "agent_access_snapshot", "vault_scope", "plugin_id", "mcp_bindings", "skill_bindings", "workflow_binding"]) {
    if (owns(session, key)) merged[key] = session[key];
  }
  return merged;
}
