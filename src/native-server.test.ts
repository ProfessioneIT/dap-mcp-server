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

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "./server.js";

describe("native compiled targets over MCP", () => {
  let tmp: string;
  let client: Client;
  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "gdb-mcp-"));
    const config = { runtime: process.execPath, program: fileURLToPath(new URL("./test-fixtures/gdb-mock-adapter.js", import.meta.url)) };
    await fs.mkdir(path.join(tmp, "config"));
    await fs.writeFile(path.join(tmp, "config", "adapters.json"), JSON.stringify({
      gdb: { ...config, type: "gdb" }, cppdbg: { ...config, type: "cppdbg" },
    }));
    const server = createServer({ globalDir: path.join(tmp, "config"), projectDir: path.join(tmp, "empty") });
    const [a, b] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "gdb-test", version: "1" });
    await server.connect(b); await client.connect(a);
  });
  afterEach(async () => { await client.close(); await fs.rm(tmp, { recursive: true, force: true }); });

  it.each(["gdb", "cppdbg"])("resolves an existing Cargo executable for %s", async (adapter) => {
    await fs.writeFile(path.join(tmp, "Cargo.toml"), '[package]\nname = "pet"\n');
    await fs.mkdir(path.join(tmp, "target", "debug"), { recursive: true });
    await fs.writeFile(path.join(tmp, "target", "debug", "pet"), "");
    const result = await client.callTool({ name: "debug_at", arguments: { adapter, cwd: tmp, file: path.join(tmp, "main.rs"), line: 5 } });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({ adapter, hit: true });
    const output = (result.structuredContent as { output: string[] }).output.join("");
    expect(output).toContain(path.join(tmp, "target", "debug", "pet"));
  });

  it.each(["gdb", "cppdbg"])("requires a program for a virtual workspace using %s", async (adapter) => {
    await fs.writeFile(path.join(tmp, "Cargo.toml"), '[workspace]\nmembers = []\n');
    const result = await client.callTool({ name: "debug_at", arguments: { adapter, cwd: tmp, file: path.join(tmp, "main.rs"), line: 5 } });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toMatch(/compiled executable.*program/);
  });

  it("accepts an explicit workspace executable", async () => {
    await fs.writeFile(path.join(tmp, "Cargo.toml"), '[workspace]\nmembers = []\n');
    const result = await client.callTool({ name: "debug_at", arguments: {
      adapter: "gdb", cwd: tmp, program: "/tmp/explicit-test", file: path.join(tmp, "main.rs"), line: 5,
    } });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({ hit: true });
  });

  it("lists resolved verification without losing requested breakpoint information", async () => {
    const launch = await client.callTool({ name: "debug_launch", arguments: {
      adapter: "gdb", program: "/test/pet", breakpoints: [{ file: "/test/app.rs", line: 5, condition: "x == 42" }],
    } });
    const payload = JSON.parse((launch.content as Array<{ text: string }>)[0].text);
    try {
      const listed = await client.callTool({ name: "list_breakpoints", arguments: { sessionId: payload.sessionId } });
      const result = JSON.parse((listed.content as Array<{ text: string }>)[0].text);
      expect(result.files[0].breakpoints[0]).toMatchObject({ line: 5, condition: "x == 42", verified: true });
    } finally {
      await client.callTool({ name: "debug_disconnect", arguments: { sessionId: payload.sessionId } });
    }
  });
});
