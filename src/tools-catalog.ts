import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";

// 列出 pi 会话实际会拿到的工具:内置七件套 + 由 SOP_PI_EXTENSION_PATHS 加载的扩展工具。
// 只读自省 —— 用与 pi-worker 相同的方式加载资源,不跑任何会话。给 UI 的"能力清单"做数据源。

export type ToolInfo = { name: string; description: string; source: "builtin" | "extension"; extension?: string };

const BUILTINS: ToolInfo[] = [
  { name: "read", description: "读取文件", source: "builtin" },
  { name: "bash", description: "执行 shell 命令", source: "builtin" },
  { name: "edit", description: "编辑文件", source: "builtin" },
  { name: "write", description: "写入文件", source: "builtin" },
  { name: "grep", description: "按内容搜索", source: "builtin" },
  { name: "find", description: "按文件名查找", source: "builtin" },
  { name: "ls", description: "列目录", source: "builtin" },
];

let cache: { ts: number; tools: ToolInfo[] } | undefined;

export async function listAgentTools(dataDir: string): Promise<ToolInfo[]> {
  const now = Date.now();
  if (cache && now - cache.ts < 30_000) return cache.tools;

  const extraPaths = (process.env.SOP_PI_EXTENSION_PATHS ?? "")
    .split(":")
    .map((p) => p.trim())
    .filter(Boolean);

  const tools: ToolInfo[] = [...BUILTINS];

  if (extraPaths.length) {
    try {
      const cwd = dataDir;
      const agentDir = `${dataDir}/pi-agent`;
      const settingsManager = SettingsManager.create(cwd, agentDir);
      const rl = new DefaultResourceLoader({
        cwd,
        agentDir,
        settingsManager,
        noExtensions: true,
        additionalExtensionPaths: extraPaths,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
      });
      await rl.reload();
      for (const extension of rl.getExtensions().extensions) {
        const label = String(extension.path ?? "extension").split("/").filter(Boolean).pop() || "extension";
        const map = extension.tools;
        if (map && typeof (map as { entries?: unknown }).entries === "function") {
          for (const [name, def] of map as Map<string, { description?: string; label?: string }>) {
            tools.push({
              name,
              description: String(def?.description ?? def?.label ?? ""),
              source: "extension",
              extension: label,
            });
          }
        }
      }
    } catch {
      // 加载失败不影响内置清单
    }
  }

  cache = { ts: now, tools };
  return tools;
}
