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
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "./server.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MOCK_ADAPTER = path.join(__dirname, "test-fixtures/mock-adapter.js");

interface InternalTool {
  outputSchema?: unknown;
  annotations?: Record<string, unknown>;
  handler: (args: Record<string, unknown>, extra?: unknown) => Promise<{
    content: Array<{ type: string; text?: string }>;
    isError?: boolean;
  }>;
}

function internals(server: ReturnType<typeof createServer>): Record<string, InternalTool> {
  return (server as unknown as { _registeredTools: Record<string, InternalTool> })
    ._registeredTools;
}

describe("MCP server metadata", () => {
  it("advertises concise instructions, schemas, and annotations through MCP", async () => {
    const server = createServer();
    const client = new Client({ name: "catalog-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const catalog = await client.listTools();
    const tools = new Map(catalog.tools.map((tool) => [tool.name, tool]));
    const instructions = client.getInstructions();

    expect(instructions).toContain("test fails");
    expect(instructions).toContain("debug_doctor");
    expect(instructions?.length).toBeLessThan(2000);
    expect(tools.get("debug_doctor")?.outputSchema).toBeDefined();
    expect(tools.get("debug_doctor")?.annotations?.readOnlyHint).toBe(true);
    expect(tools.get("debug_at")?.outputSchema).toBeDefined();
    expect(tools.get("debug_at")?.annotations?.destructiveHint).toBe(true);
    expect(tools.get("get_state")?.annotations?.readOnlyHint).toBe(true);
    expect(tools.get("get_output")?.annotations?.readOnlyHint).toBe(false);

    const doctor = await client.callTool({
      name: "debug_doctor",
      arguments: { cwd: process.cwd() },
    });
    expect(doctor.isError).not.toBe(true);
    expect(doctor.structuredContent).toMatchObject({ cwd: process.cwd() });

    await client.close();
  });

  it("waits for a supplied breakpoint and returns its stopped state", async () => {
    const server = createServer();
    const tools = internals(server);
    const launch = await tools.debug_launch.handler({
      adapter: "mock",
      program: "/test/app.py",
      breakpoints: [{ file: "/test/app.py", line: 5 }],
      timeout: 2000,
      adapterConfig: {
        type: "mock",
        runtime: "node",
        program: MOCK_ADAPTER,
      },
    });

    expect(launch.isError).not.toBe(true);
    const payload = JSON.parse(launch.content[0].text ?? "{}") as {
      sessionId: string;
      status: string;
      breakpoints: Array<{ breakpoints: Array<{ verified: boolean }> }>;
    };
    expect(payload.status).toBe("stopped");
    expect(payload.breakpoints[0].breakpoints[0].verified).toBe(true);

    await tools.debug_disconnect.handler({ sessionId: payload.sessionId });
  });

  const MOCK_CONFIG = { type: "mock", runtime: "node", program: MOCK_ADAPTER };

  it("answers a step compactly and carries only output the agent has not seen", async () => {
    const tools = internals(createServer());
    const launch = await tools.debug_launch.handler({
      adapter: "mock",
      program: "/test/app.py",
      breakpoints: [{ file: "/test/app.py", line: 5 }],
      timeout: 2000,
      adapterConfig: MOCK_CONFIG,
    });
    const launched = JSON.parse(launch.content[0].text ?? "{}");
    expect(launched.output).toEqual(["Program started\n"]);
    expect(launched.scopes.map((s: { name: string }) => s.name)).toEqual(["Locals", "Globals"]);

    const step = await tools.step.handler({ sessionId: launched.sessionId, action: "next" });
    const text = step.content[0].text ?? "";
    const stepped = JSON.parse(text);
    expect(text).not.toContain("\n");
    expect(stepped.reason).toBe("step");
    expect(stepped.threads).toBeUndefined();
    expect(stepped.output).toBeUndefined();
    expect(stepped.scopes.map((s: { name: string }) => s.name)).toEqual(["Locals"]);
    expect(stepped.scopes[0].variables[0]).toEqual({ name: "x", value: "42", type: "int" });

    const full = await tools.step.handler({
      sessionId: launched.sessionId,
      action: "next",
      detail: "full",
    });
    expect(JSON.parse(full.content[0].text ?? "{}").threads).toHaveLength(1);

    await tools.debug_disconnect.handler({ sessionId: launched.sessionId });
  });

  it("lets get_state opt into register scopes", async () => {
    const tools = internals(createServer());
    const launch = await tools.debug_launch.handler({
      adapter: "mock",
      program: "/test/app.py",
      breakpoints: [{ file: "/test/app.py", line: 5 }],
      timeout: 2000,
      adapterConfig: MOCK_CONFIG,
    });
    const { sessionId } = JSON.parse(launch.content[0].text ?? "{}");

    const state = await tools.get_state.handler({ sessionId, scopes: ["Registers"] });
    const payload = JSON.parse(state.content[0].text ?? "{}");
    expect(payload.scopes.map((s: { name: string }) => s.name)).toEqual(["Registers"]);

    await tools.debug_disconnect.handler({ sessionId });
  });

  it("binds breakpoints during attach, before the debuggee resumes", async () => {
    const tools = internals(createServer());
    const attach = await tools.debug_attach.handler({
      adapter: "mock",
      port: 5005,
      breakpoints: [{ file: "/test/app.py", line: 5 }],
      timeout: 2000,
      adapterConfig: MOCK_CONFIG,
    });

    expect(attach.isError).not.toBe(true);
    const payload = JSON.parse(attach.content[0].text ?? "{}");
    expect(payload.breakpoints[0].breakpoints[0]).toMatchObject({ verified: true, line: 5 });
    expect(payload.status).toBe("stopped");
    expect(payload.reason).toBe("breakpoint");

    await tools.debug_disconnect.handler({ sessionId: payload.sessionId });
  });

  it("keeps a plain attach non-blocking", async () => {
    const tools = internals(createServer());
    const attach = await tools.debug_attach.handler({
      adapter: "mock",
      port: 5005,
      adapterConfig: MOCK_CONFIG,
    });
    const payload = JSON.parse(attach.content[0].text ?? "{}");
    expect(payload.status).toBe("running");

    await tools.debug_disconnect.handler({ sessionId: payload.sessionId });
  });

  it("reports the exit code when a launch runs the program to completion", async () => {
    const tools = internals(createServer());
    const launch = await tools.debug_launch.handler({
      adapter: "mock",
      program: "/test/app.py",
      stopOnEntry: false,
      waitForStop: true,
      timeout: 2000,
      adapterConfig: MOCK_CONFIG,
    });
    const payload = JSON.parse(launch.content[0].text ?? "{}");
    expect(payload.status).toBe("terminated");
    expect(payload.exitCode).toBe(3);

    await tools.debug_disconnect.handler({ sessionId: payload.sessionId });
  });

  it("explains an unready debugger without dumping every adapter", async () => {
    const tools = internals(createServer());
    const emptyDir = await fs.mkdtemp(path.join(os.tmpdir(), "dap-unready-"));
    const result = await tools.debug_at
      .handler({ cwd: emptyDir, file: path.join(emptyDir, "notes.unknownlang"), line: 1 })
      .finally(() => fs.rm(emptyDir, { recursive: true, force: true }));

    expect(result.isError).toBe(true);
    const text = result.content[0].text ?? "";
    expect(text).toMatch(/Specify an adapter/i);
    expect(text).toMatch(/python/);
    expect(text).not.toContain("installHint");
    expect(text.length).toBeLessThan(700);
  });

  it("keeps debug_doctor concise unless verbose is requested", async () => {
    const tools = internals(createServer());
    const concise = JSON.parse(
      (await tools.debug_doctor.handler({ cwd: process.cwd() })).content[0].text ?? "{}"
    );
    expect(concise.recommendedAdapter).toBe("node");
    expect(concise.adapters.map((a: { type: string }) => a.type)).toEqual(["node"]);
    expect(concise.otherAdapters.some((entry: string) => entry.startsWith("python"))).toBe(true);

    const verbose = JSON.parse(
      (await tools.debug_doctor.handler({ cwd: process.cwd(), verbose: true })).content[0].text ?? "{}"
    );
    expect(verbose.adapters.length).toBeGreaterThan(3);
  });
});
