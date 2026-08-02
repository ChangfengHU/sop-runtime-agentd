import fs from "node:fs/promises";
import path from "node:path";

import type { ArtifactRecord } from "./contracts.js";
import { fileSha256, newId } from "./util.js";

const SYSTEM_ARTIFACT_NAMES = new Set([
  "manifest.json",
  "agent-runtime-trace.json",
  "stdout.txt",
  "stderr.txt",
]);

const MEDIA_TYPES: Record<string, string> = {
  ".csv": "text/csv",
  ".gif": "image/gif",
  ".html": "text/html",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".json": "application/json",
  ".md": "text/markdown",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain",
  ".webp": "image/webp",
  ".xml": "application/xml",
  ".yaml": "application/yaml",
  ".yml": "application/yaml",
};

function mediaTypeFor(file: string): string {
  return MEDIA_TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream";
}

async function walk(root: string, current = root): Promise<string[]> {
  const entries = await fs.readdir(current, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const target = path.join(current, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walk(root, target)));
    } else if (entry.isFile()) {
      files.push(target);
    }
  }
  return files;
}

export async function collectArtifacts(outputDir: string): Promise<ArtifactRecord[]> {
  try {
    const files = await walk(outputDir);
    const artifacts: ArtifactRecord[] = [];
    for (const file of files.sort()) {
      const stat = await fs.stat(file);
      const relativePath = path.relative(outputDir, file);
      const name = path.basename(file);
      artifacts.push({
        id: newId("artifact"),
        name,
        path: file,
        relativePath,
        mediaType: mediaTypeFor(file),
        size: stat.size,
        sha256: await fileSha256(file),
        relayable: !SYSTEM_ARTIFACT_NAMES.has(name),
      });
    }
    return artifacts;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
}
