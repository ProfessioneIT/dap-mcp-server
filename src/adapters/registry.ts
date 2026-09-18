/**
 * Copyright (c) 2026 Ivan Iraci <ivan.iraci@professioneit.com>
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

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
    const builtin = this.builtins.get(type);
    const global = this.global.get(type);
    const project = this.project.get(type);
    if (!builtin && !global && !project) return undefined;

    const merged: Partial<AdapterConfig> = {};
    for (const layer of [builtin, global, project]) {
      if (!layer) continue;
      for (const [key, value] of Object.entries(layer)) {
        if (value !== undefined && key !== "launchDefaults") {
          (merged as Record<string, unknown>)[key] = value;
        }
      }
    }
    merged.launchDefaults = {
      ...builtin?.launchDefaults,
      ...global?.launchDefaults,
      ...project?.launchDefaults,
    };
    return merged as AdapterConfig;
  }

  register(config: AdapterConfig, scope: "global" | "project" = "project"): void {
    const map = scope === "global" ? this.global : this.project;
    map.set(config.type, config);
  }

  listAll(): Array<AdapterConfig & { source: "builtin" | "global" | "project" }> {
    const types = new Set([
      ...this.builtins.keys(),
      ...this.global.keys(),
      ...this.project.keys(),
    ]);
    return Array.from(types, (type) => {
      const config = this.get(type)!;
      const source = this.project.has(type)
        ? "project"
        : this.global.has(type)
          ? "global"
          : "builtin";
      return { ...config, source };
    });
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
