import fs from "node:fs/promises";
import path from "node:path";

import { providerProfileSchema, type ProviderProfile } from "./contracts.js";

export class ProviderRegistry {
  constructor(private readonly providerDir: string) {}

  async get(id: string): Promise<ProviderProfile | undefined> {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u.test(id)) {
      throw new Error("Invalid Provider Profile id");
    }
    try {
      const content = await fs.readFile(path.join(this.providerDir, `${id}.json`), "utf8");
      const profile = providerProfileSchema.parse(JSON.parse(content));
      if (profile.id !== id) {
        throw new Error(`Provider Profile file ${id}.json declares id ${profile.id}`);
      }
      return profile;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async list(): Promise<Array<Omit<ProviderProfile, "credentialRef"> & { credentialConfigured: boolean }>> {
    let names: string[] = [];
    try {
      names = await fs.readdir(this.providerDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const profiles = await Promise.all(
      names
        .filter((name) => name.endsWith(".json"))
        .sort()
        .map(async (name) => await this.get(name.slice(0, -5))),
    );
    return profiles.filter((profile): profile is ProviderProfile => profile !== undefined).map(({ credentialRef: _credentialRef, ...profile }) => ({
      ...profile,
      credentialConfigured: true,
    }));
  }
}
