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

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AdapterRegistry } from "../adapters/registry.js";
import { resolveProjectAdapter } from "./doctor.js";

const available = vi.hoisted(() => ({ gdb: true, lldb: true }));
vi.mock("../adapters/recipes.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../adapters/recipes.js")>(),
  prepareNativeAdapterConfig: async (config: unknown) => config,
}));
vi.mock("../adapters/detect.js", () => ({
  inspectAdapterAvailability: async (config: { type: string; program: string }) => ({
    command: config.program, available: config.type === "gdb" ? available.gdb : config.type === "cppdbg" ? available.lldb : true,
    reason: "fixture adapter unavailable",
  }),
}));

describe("Rust engine selection", () => {
  let directory: string;
  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), "gdb-selection-"));
    await fs.writeFile(path.join(directory, "Cargo.toml"), '[package]\nname = "pet"\n');
  });
  afterEach(async () => { await fs.rm(directory, { recursive: true, force: true }); });

  it("explains how to enable absent optional GDB Rust formatters", async () => {
    available.gdb = true;
    const result = await resolveProjectAdapter(new AdapterRegistry(directory, directory), { cwd: directory }, "linux");
    expect(result.result.nextSteps.join(" ")).toMatch(/formatters.*unavailable.*rust-gdb/i);
    expect(result.result.ready).toBe(true);
  });

  it.each([
    ["linux", true, true, undefined, "gdb", true],
    ["linux", false, true, undefined, "cppdbg", true],
    ["linux", false, false, undefined, "cppdbg", false],
    ["darwin", true, true, undefined, "cppdbg", true],
    ["win32", true, true, undefined, "cppdbg", true],
    ["linux", false, true, "gdb", "gdb", false],
    ["linux", true, true, "cppdbg", "cppdbg", true],
    ["linux", true, true, "", "", false],
  ] as const)("selects %s gdb=%s lldb=%s override=%s", async (platform, gdb, lldb, adapter, expected, ready) => {
    available.gdb = gdb; available.lldb = lldb;
    const registry = new AdapterRegistry(directory, directory);
    const result = await resolveProjectAdapter(registry, { cwd: directory, adapter }, platform);
    expect(result.result.recommendedAdapter).toBe(expected);
    expect(result.result.ready).toBe(ready);
    if (platform === "linux" && !gdb && adapter === undefined) expect(result.result.nextSteps.join(" ")).toMatch(/GDB|gdb/);
  });

  it.each([["main.c", "cppdbg"], ["main.py", "python"], ["main.ts", "node"], ["main.go", "go"], ["main.php", "php"], ["main.java", "java"]])(
    "retains the adapter for %s", async (file, adapter) => {
      available.gdb = true; available.lldb = true;
      const result = await resolveProjectAdapter(new AdapterRegistry(directory, directory), {
        cwd: directory, sourceFile: path.join(directory, file),
      }, "linux");
      expect(result.result.recommendedAdapter).toBe(adapter);
    },
  );
});
