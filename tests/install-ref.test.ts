import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
const exec = promisify(execFile);
const installer = fileURLToPath(new URL("../scripts/install.sh", import.meta.url));

test("installer selects fetched remote branch while preserving explicit rollback tags and SHAs", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agentd-install-ref-"));
  const upstream = path.join(dir, "upstream"), checkout = path.join(dir, "checkout");
  const git = async (cwd: string, ...args: string[]) => (await exec("git", args, { cwd })).stdout.trim();
  try {
    await fs.mkdir(upstream);
    await git(upstream, "init", "-b", "main");
    await git(upstream, "config", "user.name", "Installer Test");
    await git(upstream, "config", "user.email", "installer@example.test");
    await fs.writeFile(path.join(upstream, "version"), "old");
    await git(upstream, "add", "."); await git(upstream, "commit", "-m", "old");
    const old = await git(upstream, "rev-parse", "HEAD");
    await git(upstream, "tag", "rollback");
    await git(dir, "clone", upstream, checkout);
    await fs.writeFile(path.join(upstream, "version"), "new");
    await git(upstream, "commit", "-am", "new");
    const current = await git(upstream, "rev-parse", "HEAD");
    for (const [ref, expected] of [["main", current], ["refs/tags/rollback", old], [old, old]]) {
      const result = await exec("bash", [installer, "--install-dir", checkout, "--ref", ref!, "--resolve-ref-only"]);
      assert.equal(result.stdout.trim(), expected);
      assert.equal(await git(checkout, "rev-parse", "HEAD"), old, "resolution must not change the installed checkout");
    }
    await assert.rejects(exec("bash", [installer, "--install-dir", checkout, "--ref", "does-not-exist", "--resolve-ref-only"]));
    assert.equal(await git(checkout, "rev-parse", "HEAD"), old);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
