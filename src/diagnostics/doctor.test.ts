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

  it("infers the language from loose source files when there is no manifest", async () => {
    await fs.writeFile(path.join(tmpDir, "inventory.py"), "print('hi')\n");
    await fs.writeFile(path.join(tmpDir, "test_inventory.py"), "");

    const signals = await detectProjectSignals(tmpDir);
    expect(signals.languages).toEqual(["python"]);
  });

  it("looks one level into src/ for loose source files", async () => {
    await fs.mkdir(path.join(tmpDir, "src"));
    await fs.writeFile(path.join(tmpDir, "src", "cart.php"), "<?php\n");

    const signals = await detectProjectSignals(tmpDir);
    expect(signals.languages).toEqual(["php"]);
  });

  it("prefers a manifest over a stray file of another language", async () => {
    await fs.writeFile(path.join(tmpDir, "go.mod"), "module pet\n");
    await fs.writeFile(path.join(tmpDir, "gen.py"), "");

    const signals = await detectProjectSignals(tmpDir);
    expect(signals.languages[0]).toBe("go");
  });

  it("detects Cargo projects and maps Rust onto the cppdbg adapter", async () => {
    await fs.writeFile(path.join(tmpDir, "Cargo.toml"), '[package]\nname = "wordfreq"\n');
    const registry = new AdapterRegistry(tmpDir, tmpDir);

    const result = await runDebugDoctor(registry, { cwd: tmpDir });
    expect(result.detected.languages).toContain("rust");
    expect(result.recommendedAdapter).toBe("cppdbg");
  });

  it("detects PHP and Java manifests", async () => {
    await fs.writeFile(path.join(tmpDir, "composer.json"), "{}");
    expect((await detectProjectSignals(tmpDir)).languages).toContain("php");

    await fs.rm(path.join(tmpDir, "composer.json"));
    await fs.writeFile(path.join(tmpDir, "pom.xml"), "<project/>");
    expect((await detectProjectSignals(tmpDir)).languages).toContain("java");
  });

  it.each([
    ["main.rs", "cppdbg"],
    ["cart.php", "php"],
    ["Bank.java", "java"],
  ])("selects the adapter for a %s breakpoint file", async (file, adapter) => {
    const registry = new AdapterRegistry(tmpDir, tmpDir);
    const resolved = await resolveProjectAdapter(registry, {
      cwd: tmpDir,
      sourceFile: path.join(tmpDir, file),
    });
    expect(resolved.result.recommendedAdapter).toBe(adapter);
  });

  it("tells the agent how to get a first stop in a Java project", async () => {
    await fs.writeFile(path.join(tmpDir, "pom.xml"), "<project/>");
    const registry = new AdapterRegistry(tmpDir, tmpDir);
    registry.register({ type: "java", program: process.execPath });

    const result = await runDebugDoctor(registry, { cwd: tmpDir });
    expect(result.ready).toBe(true);
    expect(result.nextSteps.join("\n")).toMatch(/agentlib:jdwp.*debug_attach/s);
  });

  it("returns remediation when no language can be inferred", async () => {
    const registry = new AdapterRegistry(tmpDir, tmpDir);
    const result = await runDebugDoctor(registry, { cwd: tmpDir });
    expect(result.ready).toBe(false);
    expect(result.nextSteps[0]).toMatch(/Specify an adapter/i);
  });
});
