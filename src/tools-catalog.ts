import { readFileSync } from "node:fs";
import { dirname, basename } from "node:path";
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";

// 技能包的展示名:优先 package.json 的 pi.displayName / name(去掉 -extension 后缀),
// 再退到目录名。绝不用 index.js 这种文件名——那对用户没有意义。
function packDisplayName(toolFilePath: string): string {
  const dir = dirname(toolFilePath);
  try {
    const pkg = JSON.parse(readFileSync(`${dir}/package.json`, "utf8")) as { name?: string; pi?: { displayName?: string } };
    const raw = pkg.pi?.displayName || pkg.name || basename(dir);
    return raw.replace(/-extension$/, "");
  } catch {
    return basename(dir).replace(/-extension$/, "");
  }
}

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
        const label = packDisplayName(String(extension.path ?? "extension"));
        const map = extension.tools;
        if (map && typeof (map as { entries?: unknown }).entries === "function") {
          // Map 值是 { definition, sourceInfo };描述在 definition.description
          for (const [name, entry] of map as Map<string, { definition?: { description?: string; label?: string } }>) {
            const def = entry?.definition;
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
