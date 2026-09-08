// 会话级工具白名单:把"预设/派单层写在 session.metadata 里的 tool_allowlist"变成工具层硬约束。
// 之前 allowedTools 是进程级(内置七件套 + 宿主加载的全部扩展),同一宿主所有会话一样,
// "只读"只能靠提示词自觉。这里在 pi 会话创建前求交集,模型根本看不到白名单外的工具。

export const WRITE_TOOLS = new Set(["bash", "edit", "write"]);

export function isReadOnlyWriteScope(scope: unknown): boolean {
  return typeof scope === "string" && /^只读|read-?only$/i.test(scope.trim());
}

export interface ToolAllowlistResult {
  tools: string[];
  removed: string[];
  unknown: string[];
}

/**
 * @param available 宿主实际可用的工具名(内置 + 扩展)
 * @param allowlist session.metadata.tool_allowlist;仅缺省保持旧行为，显式空值不授予工具
 * @param writeScope session.metadata.write_scope;"只读" 时剔除 bash/edit/write
 */
export function applyToolAllowlist(
  available: string[],
  allowlist: unknown,
  writeScope: unknown,
): ToolAllowlistResult {
  const wanted = Array.isArray(allowlist) ? allowlist.map((item) => String(item)).filter(Boolean) : [];
  const readOnly = isReadOnlyWriteScope(writeScope);
  let tools = [...available];
  const removed: string[] = [];
  const unknown: string[] = [];
  if (allowlist !== undefined) {
    const wantedSet = new Set(wanted);
    for (const name of wanted) if (!available.includes(name)) unknown.push(name);
    tools = tools.filter((name) => {
      const keep = wantedSet.has(name);
      if (!keep) removed.push(name);
      return keep;
    });
  }
  if (readOnly) {
    tools = tools.filter((name) => {
      const keep = !WRITE_TOOLS.has(name);
      if (!keep) removed.push(name);
      return keep;
    });
  }
  return { tools, removed, unknown };
}
