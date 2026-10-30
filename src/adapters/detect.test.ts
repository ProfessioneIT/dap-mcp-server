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

import { describe, it, expect } from "vitest";
import { checkAdapterAvailable, inspectAdapterAvailability } from "./detect.js";
import { AdapterRegistry } from "./registry.js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const gdbFixture = fileURLToPath(new URL("../test-fixtures/gdb-mock-adapter.js", import.meta.url));

describe("GDB DAP readiness", () => {
  it("makes the built-in GDB adapter discoverable without replacing LLDB", () => {
    const registry = new AdapterRegistry("/unused/global", "/unused/project");
    expect(registry.get("gdb")?.program).toBe("gdb");
    expect(registry.get("cppdbg")?.program).toBe("lldb-dap");
  });

  it.each(["ready", "reject", "cli", "malformed", "silent", "exit"])(
    "probes the complete configured command and disposes the %s adapter", async (mode) => {
      const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "gdb-probe-"));
      const pidFile = path.join(tmp, "pid");
      try {
        const result = await inspectAdapterAvailability({
          type: "gdb", runtime: process.execPath, program: gdbFixture,
          args: [`--mode=${mode}`, `--pid-file=${pidFile}`],
        });
        expect(result.available).toBe(mode === "ready");
        if (mode !== "ready") expect(result.reason).toMatch(/DAP|exit|initializ|JSON|timeout|timed out/i);
        const pid = Number(await fs.readFile(pidFile, "utf8"));
        expect(() => process.kill(pid, 0)).toThrow();
      } finally {
        await fs.rm(tmp, { recursive: true, force: true });
      }
    }, 8000,
  );
});

describe("checkAdapterAvailable", () => {
  it("detects 'node' as available", async () => {
    const result = await checkAdapterAvailable("node");
    expect(result).toBe(true);
  });

  it("detects non-existent binary as unavailable", async () => {
    const result = await checkAdapterAvailable("definitely-not-a-real-binary-xyz");
    expect(result).toBe(false);
  });

  it("detects a missing runtime-hosted adapter script", async () => {
    const result = await inspectAdapterAvailability({
      type: "node",
      runtime: "node",
      program: "/definitely/missing/dapDebugServer.js",
    });
    expect(result.available).toBe(false);
    expect(result.reason).toMatch(/not found/i);
  });

  it("checks Python modules used with -m", async () => {
    const result = await inspectAdapterAvailability({
      type: "python",
      runtime: "node",
      program: "-m",
      args: ["definitely_missing_python_module"],
    });
    expect(result.available).toBe(false);
  });

  it("rejects incomplete TCP adapter configuration", async () => {
    const result = await inspectAdapterAvailability({
      type: "custom-tcp",
      program: "node",
      transport: "tcp",
    });
    expect(result.available).toBe(false);
    expect(result.reason).toMatch(/portMatcher/);
  });
});
