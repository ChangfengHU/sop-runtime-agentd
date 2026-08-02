import fs from "node:fs/promises";
import path from "node:path";

import { assertPathWithin } from "./util.js";

interface CredentialFile {
  apiKey?: string;
  value?: string;
}

export class CredentialResolver {
  constructor(
    private readonly credentialDir: string,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  async resolve(reference: string): Promise<string> {
    if (reference.startsWith("env:")) {
      const variable = reference.slice(4);
      if (!/^[A-Z][A-Z0-9_]*$/u.test(variable)) {
        throw new Error("Invalid credential environment variable name");
      }
      const value = this.env[variable];
      if (!value) {
        throw new Error(`Credential ${reference} is not configured`);
      }
      return value;
    }

    const relative = reference.startsWith("file:") ? reference.slice(5) : reference;
    const target = assertPathWithin(this.credentialDir, path.join(this.credentialDir, relative), "credential path");
    const content = (await fs.readFile(target, "utf8")).trim();
    if (!content) {
      throw new Error(`Credential ${reference} is empty`);
    }
    if (content.startsWith("{")) {
      const parsed = JSON.parse(content) as CredentialFile;
      const value = parsed.apiKey || parsed.value;
      if (!value) {
        throw new Error(`Credential ${reference} does not contain apiKey or value`);
      }
      return value;
    }
    return content;
  }
}
