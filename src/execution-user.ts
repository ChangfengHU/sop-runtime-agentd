import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import { SupervisorError } from "./util.js";

const exec = promisify(execFile);
export type ExecutionConfig = { user: string; workspace: string };
export function validateInstanceId(id: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(id)) throw new SupervisorError("无效的实例 ID", 400);
}
export async function executionIdentity(user: string) {
  if (!/^[a-z_][a-z0-9_-]{0,31}$/.test(user)) throw new SupervisorError("无效的系统用户名", 400);
  let row: string;
  try { row = (await exec("getent", ["passwd", user], { timeout: 5000 })).stdout.trim(); }
  catch { throw new SupervisorError(`系统用户 ${user} 不存在`, 400); }
  const fields = row.split(":");
  const home = fields[5] || "";
  if (fields[0] !== user || !path.isAbsolute(home)) throw new SupervisorError("无法解析执行用户的 HOME", 400);
  return { user, home };
}
export async function executionCommand(user: string, command: string, args: string[]) {
  const identity = await executionIdentity(user);
  // An engine must never inherit another OS user's Codex home or API credentials.
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin", HOME: identity.home, USER: user, LOGNAME: user };
  for (const key of ["LANG", "LC_ALL", "TZ", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY"]) {
    if (process.env[key]) env[key] = process.env[key];
  }
  if (os.userInfo().username === user) return { command, args, env, ...identity };
  return { command: "sudo", args: ["-n", "-H", "-u", user, "--", "/usr/bin/env", "-i", ...Object.entries(env).map(([k,v]) => `${k}=${v}`), command, ...args], env, ...identity };
}
export async function prepareExecutionWorkspace(config: ExecutionConfig): Promise<void> {
  if (!path.isAbsolute(config.workspace) || config.workspace.includes("\0")) throw new SupervisorError("工作目录必须是绝对路径", 400);
  try {
    const mkdir = await executionCommand(config.user, "/bin/mkdir", ["-p", "--", config.workspace]);
    await exec(mkdir.command, mkdir.args, { env: mkdir.env, timeout: 5000 });
    for (const mode of ["-w", "-x", "-d"]) {
      const test = await executionCommand(config.user, "/usr/bin/test", [mode, config.workspace]);
      await exec(test.command, test.args, { env: test.env, timeout: 5000 });
    }
  } catch { throw new SupervisorError(`用户 ${config.user} 无法访问或写入工作目录 ${config.workspace}，请选择该用户可写的目录`, 400); }
}
export async function defaultExecutionConfig(instanceId: string): Promise<ExecutionConfig> {
  validateInstanceId(instanceId);
  const user = process.env.SOP_CODEX_EXECUTION_USER || "claude";
  const { home } = await executionIdentity(user);
  return { user, workspace: path.join(home, "harness", instanceId) };
}
