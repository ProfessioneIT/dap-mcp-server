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
import { buildLaunchArgs, defaultCargoProgram, launchFailureHint } from "./recipes.js";

describe("launch recipes", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "dap-recipes-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  async function fakeRustSysroot(): Promise<string> {
    const etc = path.join(tmpDir, "sysroot", "lib", "rustlib", "etc");
    await fs.mkdir(etc, { recursive: true });
    await fs.writeFile(path.join(etc, "lldb_lookup.py"), "# fixture");
    return path.join(tmpDir, "sysroot");
  }

  it("layers adapter defaults below launchConfig below explicit fields", async () => {
    const args = await buildLaunchArgs(
      { type: "python", program: "-m", launchDefaults: { console: "internalConsole", justMyCode: true } },
      {
        program: "/app/main.py",
        cwd: "/app",
        launchConfig: { justMyCode: false, program: "/ignored.py" },
        stopOnEntry: false,
      }
    );
    expect(args).toEqual({
      console: "internalConsole",
      justMyCode: false,
      program: "/app/main.py",
      cwd: "/app",
      stopOnEntry: false,
    });
  });

  it("mirrors cwd to dlvCwd so delve builds from the module directory", async () => {
    const args = await buildLaunchArgs(
      { type: "go", program: "dlv" },
      { program: "/work/pet", cwd: "/work/pet", stopOnEntry: false }
    );
    expect(args.dlvCwd).toBe("/work/pet");
  });

  it("loads the Rust LLDB formatters when a cppdbg session involves .rs sources", async () => {
    const sysroot = await fakeRustSysroot();
    const args = await buildLaunchArgs(
      { type: "cppdbg", program: "lldb-dap" },
      {
        program: "/work/target/debug/pet",
        stopOnEntry: false,
        sourceFiles: ["/work/src/main.rs"],
        launchConfig: { initCommands: ["settings set target.x86-disassembly-flavor intel"] },
      },
      async () => sysroot
    );
    expect(args.initCommands).toEqual([
      "settings set target.x86-disassembly-flavor intel",
      `command script import "${path.join(sysroot, "lib", "rustlib", "etc", "lldb_lookup.py")}"`,
    ]);
  });

  it("leaves C sessions and formatter-less toolchains untouched", async () => {
    const sysroot = await fakeRustSysroot();
    const cSession = await buildLaunchArgs(
      { type: "cppdbg", program: "lldb-dap" },
      { program: "/work/stats", stopOnEntry: false, sourceFiles: ["/work/stats.c"] },
      async () => sysroot
    );
    expect(cSession.initCommands).toBeUndefined();

    const noFormatters = await buildLaunchArgs(
      { type: "cppdbg", program: "lldb-dap" },
      { program: "/work/pet", stopOnEntry: false, sourceFiles: ["/work/src/main.rs"] },
      async () => path.join(tmpDir, "empty-sysroot")
    );
    expect(noFormatters.initCommands).toBeUndefined();
  });

  it("defaults a Cargo project's program to its built debug binary", async () => {
    await fs.writeFile(
      path.join(tmpDir, "Cargo.toml"),
      '[package]\nname = "wordfreq"\nversion = "0.1.0"\n'
    );
    expect(await defaultCargoProgram(tmpDir)).toBeUndefined();

    const binary = path.join(tmpDir, "target", "debug", "wordfreq");
    await fs.mkdir(path.dirname(binary), { recursive: true });
    await fs.writeFile(binary, "");
    expect(await defaultCargoProgram(tmpDir)).toBe(binary);
  });

  it("explains a silent PHP run in terms of xdebug", () => {
    expect(launchFailureHint("php")).toMatch(/xdebug/i);
    expect(launchFailureHint("python")).toBeUndefined();
  });
});
