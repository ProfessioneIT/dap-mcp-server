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

import { describe, it, expect, afterEach } from "vitest";
import { DebugSession } from "../session/session.js";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MOCK_ADAPTER = path.join(__dirname, "../test-fixtures/mock-adapter.js");

describe("Debug Lifecycle Integration", () => {
  let session: DebugSession | undefined;

  afterEach(async () => {
    if (session && session.state !== "terminated") {
      try { await session.disconnect(); } catch { /* ignore */ }
    }
    session = undefined;
  });

  it("full debug lifecycle: launch, stop, inspect, step, evaluate, disconnect", async () => {
    session = new DebugSession("integ-1", { type: "mock", runtime: "node", program: MOCK_ADAPTER });

    // Initialize
    const caps = await session.initialize();
    expect(caps.supportsConfigurationDoneRequest).toBe(true);
    expect(session.state).toBe("configuring");

    // Set breakpoints
    const bps = await session.setBreakpoints("/test/app.py", [{ line: 5 }, { line: 10 }]);
    expect(bps).toHaveLength(2);
    expect(bps[0].verified).toBe(true);

    // Configuration done + launch
    await session.configurationDone();
    await session.launch({ program: "/test/app.py", stopOnEntry: true });

    // Wait for stopped on entry
    const stoppedEvent = await session.waitForStopped(5000);
    expect(stoppedEvent.body.reason).toBe("entry");
    expect(session.state).toBe("stopped");

    // Collect composite state
    const state = await session.collectState(1, 10, 1);
    expect(state.status).toBe("stopped");
    expect(state.reason).toBe("entry");
    expect(state.threads).toHaveLength(1);
    expect(state.threads[0].name).toBe("MainThread");
    expect(state.stackTrace.length).toBeGreaterThan(0);
    expect(state.scopes.length).toBeGreaterThan(0);

    // Check variables
    const locals = state.scopes.find(s => s.name === "Locals");
    expect(locals).toBeDefined();
    expect(locals!.variables.some(v => v.name === "x" && v.value === "42")).toBe(true);
    expect(locals!.variables.some(v => v.name === "name")).toBe(true);

    // Step next
    await session.next(1);
    const stoppedAfterStep = await session.waitForStopped(5000);
    expect(stoppedAfterStep.body.reason).toBe("step");

    // Evaluate expression
    const evalResult = await session.evaluate("x + 1", 1);
    expect(evalResult.result).toBe("42");

    // Continue
    await session.continueExecution(1);
    const stoppedAtBp = await session.waitForStopped(5000);
    expect(stoppedAtBp.body.reason).toBe("breakpoint");

    // Check output
    const output = session.getOutput();
    expect(output.output.some(o => o.text.includes("Program started"))).toBe(true);

    // Disconnect
    await session.disconnect();
    expect(session.state).toBe("terminated");
  });

  it("handles adapter crash gracefully", async () => {
    const crashAdapter = path.join(__dirname, "../test-fixtures/crash-adapter.js");
    session = new DebugSession("integ-crash", { type: "mock", runtime: "node", program: crashAdapter });
    await expect(session.initialize()).rejects.toThrow();
    expect(session.state).toBe("terminated");
  });
});
