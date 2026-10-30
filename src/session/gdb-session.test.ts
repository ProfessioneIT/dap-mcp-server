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

import { afterEach, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { DebugSession } from "./session.js";
import { runDebugInspect } from "./inspect.js";
import { AdapterRegistry } from "../adapters/registry.js";
import { SessionManager } from "./session-manager.js";
import { AdapterConfig } from "../dap/types.js";

const config = { type: "gdb", runtime: process.execPath, program: fileURLToPath(new URL("../test-fixtures/gdb-mock-adapter.js", import.meta.url)) };
let session: DebugSession | undefined;
afterEach(async () => { if (session) await session.disconnect(); session = undefined; });

async function stopped(adapterConfig: AdapterConfig = config) {
  session = new DebugSession("gdb-unit", adapterConfig);
  await session.initialize();
  const launch = session.launch({ program: "/test/pet", stopOnEntry: false });
  await session.waitForInitialized();
  await session.setBreakpoints("/test/app.rs", [{ line: 5 }]);
  await session.configurationDone();
  await launch;
  await session.waitForStopped(2000);
  return session;
}

describe("GDB expression and session compatibility", () => {
  it("evaluates automatic expressions in watch context with frame ID zero and preserves partial failures", async () => {
    const sessions = new SessionManager();
    const result = await runDebugInspect(new AdapterRegistry("/unused/global", "/unused/project"), sessions, {
      adapter: "gdb", adapterConfig: config, program: "/test/pet",
      at: { file: "/test/app.rs", line: 5 }, expressions: ["x", "bad"], timeout: 2000,
    });
    expect(result.values?.x).toMatchObject({ result: "42", type: "i32" });
    expect(result.values?.bad.error).toMatch(/Unknown variable/);
    expect(sessions.listAll()).toHaveLength(0);
  });

  it("negotiates variable types and resolves the top frame with ID zero", async () => {
    const current = await stopped();
    const value = await current.evaluate("x", undefined, "watch");
    expect(value).toMatchObject({ result: "42", type: "i32" });
    const state = await current.collectState();
    expect(state.scopes[0].variables[0]).toMatchObject({ name: "x", type: "i32" });
  });

  it("updates pending breakpoint verification when the adapter reports a change", async () => {
    const current = await stopped();
    expect(current.getBreakpointResults().get("/test/app.rs")?.[0]).toMatchObject({ verified: true, line: 5 });
    expect(current.getBreakpoints().get("/test/app.rs")?.[0]).toEqual({ line: 5 });
  });

  it("retains immediate breakpoint updates with ID zero while installing and replacing results", async () => {
    session = new DebugSession("gdb-early", { ...config, args: ["--mode=early-breakpoint"] });
    await session.initialize();
    for (const line of [5, 8]) {
      const result = await session.setBreakpoints("/test/app.rs", [{ line, condition: "x == 42" }]);
      expect(result[0]).toMatchObject({ id: 0, verified: true, line: line + 1 });
      expect(session.getBreakpointResults().get("/test/app.rs")?.[0]).toEqual(result[0]);
      expect(session.getBreakpoints().get("/test/app.rs")?.[0]).toEqual({ line, condition: "x == 42" });
    }
  });

  it("correlates breakpoint updates by ID when the adapter reports a canonical source path", async () => {
    const current = await stopped({ ...config, args: ["--event-source=/canonical/app.rs"] });
    expect(current.getBreakpointResults().get("/test/app.rs")?.[0]).toMatchObject({ verified: true, line: 5 });
    expect(current.getBreakpoints().get("/test/app.rs")?.[0]).toEqual({ line: 5 });
  });

  it("preserves repl console commands instead of silently treating them as expressions", async () => {
    const current = await stopped();
    expect(await current.evaluate("print x")).toMatchObject({ result: "$1 = 42" });
    await expect(current.evaluate("x")).rejects.toThrow(/Undefined command/);
    expect(await current.evaluate("x", 0, "watch")).toMatchObject({ result: "42" });
  });
});
