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

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { AdapterRegistry } from "./registry.js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

describe("AdapterRegistry", () => {
  let tmpDir: string;
  let registry: AdapterRegistry;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "dap-mcp-test-"));
    registry = new AdapterRegistry(tmpDir, tmpDir);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("returns built-in adapters", () => {
    const adapters = registry.listAll();
    expect(adapters.some((a) => a.type === "python")).toBe(true);
    expect(adapters.some((a) => a.type === "go")).toBe(true);
    // node adapter removed — no reliable universal path; configure via configure_adapter
    expect(adapters.some((a) => a.type === "node")).toBe(false);
  });

  it("registers a custom adapter", () => {
    registry.register({ type: "ruby", program: "/usr/bin/rdbg", args: ["--open", "--dap"] });
    const ruby = registry.get("ruby");
    expect(ruby).toBeDefined();
    expect(ruby!.program).toBe("/usr/bin/rdbg");
  });

  it("project-local overrides built-in", () => {
    registry.register({ type: "python", program: "/custom/debugpy" });
    const python = registry.get("python");
    expect(python!.program).toBe("/custom/debugpy");
  });

  it("saves and loads config from disk", async () => {
    registry.register({ type: "ruby", program: "/usr/bin/rdbg" });
    await registry.save("project");

    const registry2 = new AdapterRegistry(tmpDir, tmpDir);
    await registry2.load();
    const ruby = registry2.get("ruby");
    expect(ruby).toBeDefined();
    expect(ruby!.program).toBe("/usr/bin/rdbg");
  });
});
