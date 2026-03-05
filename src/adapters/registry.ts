import { AdapterConfig } from "../dap/types.js";
import { BUILTIN_ADAPTERS } from "./builtin.js";
import fs from "node:fs/promises";
import path from "node:path";

export class AdapterRegistry {
  private builtins: Map<string, AdapterConfig>;
  private global: Map<string, AdapterConfig> = new Map();
  private project: Map<string, AdapterConfig> = new Map();
  private globalDir: string;
  private projectDir: string;

  constructor(globalDir: string, projectDir: string) {
    this.globalDir = globalDir;
    this.projectDir = projectDir;
    this.builtins = new Map(BUILTIN_ADAPTERS.map((a) => [a.type, a]));
  }

  get(type: string): AdapterConfig | undefined {
    return this.project.get(type) ?? this.global.get(type) ?? this.builtins.get(type);
  }

  register(config: AdapterConfig, scope: "global" | "project" = "project"): void {
    const map = scope === "global" ? this.global : this.project;
    map.set(config.type, config);
  }

  listAll(): Array<AdapterConfig & { source: "builtin" | "global" | "project" }> {
    const result = new Map<string, AdapterConfig & { source: "builtin" | "global" | "project" }>();
    for (const [type, config] of this.builtins) {
      result.set(type, { ...config, source: "builtin" });
    }
    for (const [type, config] of this.global) {
      result.set(type, { ...config, source: "global" });
    }
    for (const [type, config] of this.project) {
      result.set(type, { ...config, source: "project" });
    }
    return Array.from(result.values());
  }

  async load(): Promise<void> {
    this.global = await this.loadFile(path.join(this.globalDir, "adapters.json"));
    this.project = await this.loadFile(path.join(this.projectDir, "adapters.json"));
  }

  async save(scope: "global" | "project"): Promise<void> {
    const dir = scope === "global" ? this.globalDir : this.projectDir;
    const map = scope === "global" ? this.global : this.project;
    await fs.mkdir(dir, { recursive: true });
    const data = Object.fromEntries(map);
    await fs.writeFile(path.join(dir, "adapters.json"), JSON.stringify(data, null, 2));
  }

  private async loadFile(filePath: string): Promise<Map<string, AdapterConfig>> {
    try {
      const data = await fs.readFile(filePath, "utf-8");
      const parsed = JSON.parse(data) as Record<string, AdapterConfig>;
      return new Map(Object.entries(parsed));
    } catch {
      return new Map();
    }
  }
}
