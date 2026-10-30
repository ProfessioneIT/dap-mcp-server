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

import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";

const CODEX_ROOT = path.join(
  process.cwd(),
  "integrations",
  "codex"
);
const PLUGIN_ROOT = path.join(CODEX_ROOT, "dap-debugging");

async function readJson(file: string): Promise<Record<string, unknown>> {
  return JSON.parse(await fs.readFile(file, "utf-8")) as Record<string, unknown>;
}

describe("Codex integration", () => {
  it("ships a portable plugin with the stdio MCP server", async () => {
    const plugin = await readJson(path.join(PLUGIN_ROOT, "plugin.json"));
    const mcp = await readJson(path.join(PLUGIN_ROOT, "mcp.json"));
    const servers = mcp.mcpServers as Record<string, Record<string, unknown>>;

    expect(plugin).toMatchObject({
      $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
      name: "dap-debugging",
    });
    expect(servers.dap).toMatchObject({
      type: "stdio",
      command: "npx",
      args: ["-y", "dap-mcp-server"],
    });
    expect(servers.dap.cwd).toBeUndefined();
  });

  it("exposes the plugin through a local Codex marketplace", async () => {
    const marketplace = await readJson(
      path.join(CODEX_ROOT, ".agents", "plugins", "marketplace.json")
    );
    const plugins = marketplace.plugins as Array<Record<string, unknown>>;

    expect(marketplace.name).toBe("dap-mcp-server");
    expect(plugins).toContainEqual(
      expect.objectContaining({
        name: "dap-debugging",
        source: { source: "local", path: "./dap-debugging" },
      })
    );
  });

  it("packages activation guidance for the high-level debug workflow", async () => {
    const skill = await fs.readFile(
      path.join(PLUGIN_ROOT, "skills", "dap-debugging", "SKILL.md"),
      "utf-8"
    );
    const packageJson = await readJson(path.join(process.cwd(), "package.json"));

    expect(skill).toContain("Call `debug_doctor`");
    expect(skill).toContain("Call `debug_at`");
    expect(packageJson.files).toContain("integrations/codex");
  });
});
