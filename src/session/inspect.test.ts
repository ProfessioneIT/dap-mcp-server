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
import { runDebugInspect } from "./inspect.js";
import { AdapterRegistry } from "../adapters/registry.js";
import { SessionManager } from "./session-manager.js";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MOCK_ADAPTER = path.join(__dirname, "../test-fixtures/mock-adapter.js");

describe("runDebugInspect", () => {
  it("launches, hits a breakpoint, evaluates expressions, and disconnects", async () => {
    const registry = new AdapterRegistry(
      path.join(os.tmpdir(), `dap-test-${Date.now()}-global`),
      path.join(os.tmpdir(), `dap-test-${Date.now()}-project`)
    );
    const sessions = new SessionManager();

    const result = await runDebugInspect(registry, sessions, {
      adapter: "mock",
      program: "/test/app.py",
      at: { file: "/test/app.py", line: 5 },
      expressions: ["x", "name"],
      timeout: 5000,
      adapterConfig: {
        type: "mock",
        runtime: "node",
        program: MOCK_ADAPTER,
      },
    });

    expect(result.hit).toBe(true);
    expect(result.reason).toBe("breakpoint");
    expect(result.location?.file).toBe("/test/app.py");
    expect(result.values).toBeDefined();
    expect(result.values!["x"].result).toBe("42");
    expect(result.values!["name"].result).toBe("42");
    expect(sessions.listAll()).toHaveLength(0);
  });

  it("returns hit=true with no values when expressions omitted", async () => {
    const registry = new AdapterRegistry(
      path.join(os.tmpdir(), `dap-test-${Date.now()}-global`),
      path.join(os.tmpdir(), `dap-test-${Date.now()}-project`)
    );
    const sessions = new SessionManager();

    const result = await runDebugInspect(registry, sessions, {
      adapter: "mock",
      program: "/test/app.py",
      at: { file: "/test/app.py", line: 5 },
      timeout: 5000,
      adapterConfig: {
        type: "mock",
        runtime: "node",
        program: MOCK_ADAPTER,
      },
    });

    expect(result.hit).toBe(true);
    expect(result.values).toBeUndefined();
  });

  it("rejects when adapter is unknown and no inline config provided", async () => {
    const registry = new AdapterRegistry(
      path.join(os.tmpdir(), `dap-test-${Date.now()}-global`),
      path.join(os.tmpdir(), `dap-test-${Date.now()}-project`)
    );
    const sessions = new SessionManager();

    await expect(
      runDebugInspect(registry, sessions, {
        adapter: "nonexistent",
        program: "/test/app.py",
        at: { file: "/test/app.py", line: 5 },
      })
    ).rejects.toThrow(/not found/);
  });

  it("cleans up the session even when the breakpoint never hits", async () => {
    const registry = new AdapterRegistry(
      path.join(os.tmpdir(), `dap-test-${Date.now()}-global`),
      path.join(os.tmpdir(), `dap-test-${Date.now()}-project`)
    );
    const sessions = new SessionManager();

    const noStopAdapter = path.join(__dirname, "../test-fixtures/no-stop-adapter.js");
    const result = await runDebugInspect(registry, sessions, {
      adapter: "mock",
      program: "/test/app.py",
      at: { file: "/test/app.py", line: 5 },
      timeout: 200,
      adapterConfig: {
        type: "mock",
        runtime: "node",
        program: noStopAdapter,
      },
    });

    expect(result.hit).toBe(false);
    expect(sessions.listAll()).toHaveLength(0);
  });
});
