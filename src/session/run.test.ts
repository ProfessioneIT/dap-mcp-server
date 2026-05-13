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
import { runDebugRun } from "./run.js";
import { AdapterRegistry } from "../adapters/registry.js";
import { SessionManager } from "./session-manager.js";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MOCK_ADAPTER = path.join(__dirname, "../test-fixtures/mock-adapter.js");

function freshSetup() {
  return {
    registry: new AdapterRegistry(
      path.join(os.tmpdir(), `dap-test-${Date.now()}-${Math.random()}-global`),
      path.join(os.tmpdir(), `dap-test-${Date.now()}-${Math.random()}-project`)
    ),
    sessions: new SessionManager(),
  };
}

describe("runDebugRun", () => {
  it("runs a program to completion and returns its output", async () => {
    const { registry, sessions } = freshSetup();
    const result = await runDebugRun(registry, sessions, {
      adapter: "mock",
      program: "/test/app.py",
      timeout: 5000,
      adapterConfig: {
        type: "mock",
        runtime: "node",
        program: MOCK_ADAPTER,
      },
    });

    expect(result.terminated).toBe(true);
    expect(result.status).toBe("terminated");
    expect(result.output.some((s) => s.includes("Program started"))).toBe(true);
    expect(result.output.some((s) => s.includes("Program completed"))).toBe(true);
    expect(sessions.listAll()).toHaveLength(0);
  });

  it("rejects when adapter is unknown and no inline config provided", async () => {
    const { registry, sessions } = freshSetup();
    await expect(
      runDebugRun(registry, sessions, {
        adapter: "nonexistent",
        program: "/test/app.py",
      })
    ).rejects.toThrow(/not found/);
  });
});
