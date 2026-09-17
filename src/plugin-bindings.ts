import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import { mcpBindingSchema } from "./mcp-session.js";

const relative = z.string().min(1).max(500).refine(p => !p.startsWith("/") && !p.includes("\\") && p.split("/").every(s => s !== ".." && s !== ""), "invalid relative path");
export const pluginBindingRequestSchema = z.object({
  plugin: z.object({
    id: z.string().regex(/^[a-zA-Z0-9_.-]+$/).max(128),
    repo: z.string().regex(/^https:\/\/github\.com\/[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+(?:\.git)?$/),
    commit: z.string().regex(/^[a-f0-9]{40}$/),
    root: relative,
    skills: z.array(z.object({ id: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:-]*$/).max(128), path: relative }).strict()).max(64),
    mcps: z.array(z.unknown()).max(20),
  }).strict(),
  mcpBindings: z.array(mcpBindingSchema).max(20).default([]),
  toolAllowlist: z.array(z.string().min(1)).max(2000).default([]),
  agentAccessSnapshot: z.object({ agent_id: z.string().min(1), runtime_id: z.string().min(1), agent_version: z.number().int() }).passthrough().optional(),
  runtimeId: z.string().optional(),
  allowContinuation: z.boolean().default(false),
}).strict();
export type PluginBindingRequest = z.infer<typeof pluginBindingRequestSchema>;
export type PluginBinding = {
  status: "ready" | "not_ready";
  pluginId: string; commit: string; sessionId: string; runtimeId: string; commands: string[];
  checks: Array<{ name: string; status: "passed" | "failed"; detail: string }>;
};
const exec = promisify(execFile);
/** Fetch a whole immutable public GitHub tree, never run repository scripts or Git hooks. */
export async function installPlugin(input: PluginBindingRequest["plugin"], directory: string): Promise<{ root: string; skills: string[]; directory: string }> {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const staging = await fs.mkdtemp(path.join(directory, "plugin-"));
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: staging, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0" };
  const git = (args: string[]) => exec("git", ["-c", "core.hooksPath=/dev/null", "-c", "protocol.file.allow=never", ...args], { cwd: staging, env, timeout: 90_000, maxBuffer: 4_000_000 });
  try {
    await git(["init", "--quiet"]);
    await git(["fetch", "--quiet", "--depth=1", "--no-tags", input.repo, input.commit]);
    const head = (await git(["rev-parse", "FETCH_HEAD"])).stdout.trim();
    if (head !== input.commit) throw Error("plugin_commit_mismatch");
    const entries = (await git(["ls-tree", "-rlz", "--full-tree", "FETCH_HEAD"])).stdout.split("\0").filter(Boolean);
    if (entries.some(entry => !/^(100644|100755) blob /.test(entry))) throw Error("plugin_symlink_or_submodule_unsupported");
    const bytes = entries.reduce((total, entry) => total + Number(entry.split("\t")[0]!.trim().split(/\s+/)[3]), 0);
    if (entries.length > 20_000 || !Number.isFinite(bytes) || bytes > 100_000_000) throw Error("plugin_package_too_large");
    await git(["checkout", "--quiet", "--detach", "FETCH_HEAD"]);
    const root = path.resolve(staging, input.root);
    if (root !== staging && !root.startsWith(staging + path.sep)) throw Error("plugin_root_invalid");
    const manifest = JSON.parse(await fs.readFile(path.join(root, ".codex-plugin", "plugin.json"), "utf8"));
    if (!manifest || typeof manifest !== "object" || manifest.name !== input.id) throw Error("plugin_manifest_invalid");
    const skills = await Promise.all(input.skills.map(async skill => {
      // Paths are relative to plugin root, not the repository root.
      const candidate = path.resolve(root, skill.path);
      const file = path.basename(candidate) === "SKILL.md" ? candidate : path.join(candidate, "SKILL.md");
      if (!file.startsWith(root + path.sep) || !(await fs.stat(file)).isFile()) throw Error("plugin_skill_missing");
      return file;
    }));
    if (new Set(skills).size !== skills.length) throw Error("plugin_duplicate_skill");
    return { root, skills, directory: staging };
  } catch (error) { await fs.rm(staging, { recursive: true, force: true }); throw error; }
}
