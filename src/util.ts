import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export function nowIso(): string {
  return new Date().toISOString();
}

export function newId(prefix: string): string {
  return `${prefix}-${randomUUID()}`;
}

export async function ensureDir(target: string): Promise<void> {
  await fs.mkdir(target, { recursive: true });
}

export async function fileSha256(target: string): Promise<string> {
  const content = await fs.readFile(target);
  return createHash("sha256").update(content).digest("hex");
}

export function assertPathWithin(parent: string, child: string, label: string): string {
  const resolvedParent = path.resolve(parent);
  const resolvedChild = path.resolve(child);
  const relative = path.relative(resolvedParent, resolvedChild);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`${label} must be inside ${resolvedParent}`);
  }
  return resolvedChild;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
