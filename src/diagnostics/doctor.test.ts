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
import { AdapterRegistry } from "../adapters/registry.js";
import { detectProjectSignals, resolveProjectAdapter, runDebugDoctor } from "./doctor.js";

describe("debug doctor", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "dap-doctor-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("detects Node projects and test frameworks", async () => {
    await fs.writeFile(
      path.join(tmpDir, "package.json"),
      JSON.stringify({ devDependencies: { vitest: "latest" } })
    );
    await fs.writeFile(path.join(tmpDir, "package-lock.json"), "{}");

    const signals = await detectProjectSignals(tmpDir);
    expect(signals.languages).toContain("node");
    expect(signals.testFrameworks).toContain("vitest");
    expect(signals.packageManager).toBe("npm");
  });

  it("returns a ready recommendation for a valid configured adapter", async () => {
    await fs.writeFile(path.join(tmpDir, "package.json"), "{}");
    const registry = new AdapterRegistry(tmpDir, tmpDir);
    registry.register({
      type: "node",
      runtime: "",
      program: process.execPath,
      transport: "stdio",
    });

    const result = await runDebugDoctor(registry, { cwd: tmpDir });
    expect(result.recommendedAdapter).toBe("node");
    expect(result.ready).toBe(true);
    expect(result.adapters.find((adapter) => adapter.selected)?.available).toBe(true);
  });

  it("finds a project-local vscode-js-debug adapter and retains TCP defaults", async () => {
    await fs.writeFile(path.join(tmpDir, "package.json"), "{}");
    const adapterProgram = path.join(
      tmpDir,
      "node_modules",
      "@vscode",
      "js-debug",
      "src",
      "dapDebugServer.js"
    );
    await fs.mkdir(path.dirname(adapterProgram), { recursive: true });
    await fs.writeFile(adapterProgram, "// fixture");
    const registry = new AdapterRegistry(tmpDir, tmpDir);

    const resolved = await resolveProjectAdapter(registry, { cwd: tmpDir });
    expect(resolved.result.ready).toBe(true);
    expect(resolved.config).toMatchObject({
      type: "node",
      runtime: "node",
      program: adapterProgram,
      transport: "tcp",
    });
    expect(resolved.config?.portMatcher).toBeDefined();
  });

  it("returns remediation when no language can be inferred", async () => {
    const registry = new AdapterRegistry(tmpDir, tmpDir);
    const result = await runDebugDoctor(registry, { cwd: tmpDir });
    expect(result.ready).toBe(false);
    expect(result.nextSteps[0]).toMatch(/Specify an adapter/i);
  });
});
