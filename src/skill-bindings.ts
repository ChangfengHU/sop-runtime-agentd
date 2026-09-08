import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";
import { skillBindingSchema, type SkillBinding } from "./contracts.js";

export const configuredSkillBindingsSchema = z.array(skillBindingSchema.extend({
  content_digest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
}).strict()).max(32);

const sameBinding = (binding: SkillBinding, other: SkillBinding) => binding.id === other.id && binding.path === other.path && binding.version === other.version && binding.digest === other.digest && (!other.content_digest || binding.content_digest === other.content_digest);

export function configuredSkillBindings(metadata: Record<string, unknown>, legacy?: SkillBinding): SkillBinding[] {
  const snapshot = metadata.agent_access_snapshot as { skills?: unknown; binding?: { skills?: unknown } } | undefined;
  const declared = snapshot?.skills ?? snapshot?.binding?.skills;
  let bindings: SkillBinding[] = legacy ? [legacy] : [];
  if (Object.hasOwn(metadata, "skill_bindings")) {
    const parsed = configuredSkillBindingsSchema.safeParse(metadata.skill_bindings);
    if (!parsed.success) throw Error("invalid_skill_bindings");
    bindings = parsed.data;
    if (legacy && !bindings.some(binding => sameBinding(binding, legacy))) throw Error("turn_skill_not_configured");
  } else if (!legacy && Array.isArray(snapshot?.binding?.skills)) {
    const parsed = z.array(skillBindingSchema).safeParse(snapshot.binding.skills);
    if (!parsed.success) throw Error("invalid_skill_bindings");
    bindings = parsed.data;
  }
  if (new Set(bindings.map(binding => binding.id)).size !== bindings.length) throw Error("duplicate_skill_binding");
  if (Array.isArray(declared)) {
    const ids = declared.map(item => typeof item === "string" ? item : (item as { id?: unknown })?.id);
    if (ids.length !== bindings.length || new Set(ids).size !== ids.length || ids.some(id => !bindings.some(binding => binding.id === id))) throw Error("configured_skill_binding_mismatch");
    for (const item of declared) {
      if (typeof item !== "string") {
        const parsed = skillBindingSchema.safeParse(item);
        if (!parsed.success || !bindings.some(binding => sameBinding(binding, parsed.data))) throw Error("configured_skill_binding_mismatch");
      }
    }
  }
  return bindings;
}

/** Verify real paths and content on submission and again in the worker before requesting the model. */
export async function readBoundSkills(workspace: string, bindings: SkillBinding[]) {
  if (!bindings.length) return [];
  const root = await fs.realpath(workspace);
  const result: Array<{ binding: SkillBinding; filePath: string; content: string; contentDigest: string }> = [];
  let total = 0;
  for (const binding of bindings) {
    const location = path.resolve(workspace, binding.path);
    const stat = await fs.stat(location).catch(() => { throw Error("configured_skill_missing"); });
    const filePath = await fs.realpath(stat.isDirectory() ? path.join(location, "SKILL.md") : location).catch(() => { throw Error("configured_skill_missing"); });
    if (!filePath.startsWith(root + path.sep) || path.basename(filePath) !== "SKILL.md") throw Error("configured_skill_path_invalid");
    if (!(await fs.stat(filePath)).isFile()) throw Error("configured_skill_missing");
    const buffer = await fs.readFile(filePath); total += buffer.length;
    if (!buffer.length || buffer.length > 200_000 || total > 500_000) throw Error("configured_skill_content_invalid");
    const contentDigest = `sha256:${createHash("sha256").update(buffer).digest("hex")}`;
    // digest identifies the installed package/deployment; content_digest pins SKILL.md bytes.
    if (binding.content_digest && binding.content_digest !== contentDigest) throw Error("configured_skill_content_changed");
    if (result.some(item => item.filePath === filePath)) throw Error("duplicate_skill_binding");
    result.push({ binding, filePath, content: buffer.toString("utf8"), contentDigest });
  }
  return result;
}
