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

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildLaunchArgs, defaultCargoProgram, launchFailureHint, buildAttachArgs, prepareNativeAdapterConfig } from "./recipes.js";

describe("launch recipes", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "dap-recipes-"));
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  async function fakeRustSysroot(): Promise<string> {
    const etc = path.join(tmpDir, "sysroot", "lib", "rustlib", "etc");
    await fs.mkdir(etc, { recursive: true });
    await fs.writeFile(path.join(etc, "lldb_lookup.py"), "# fixture");
    return path.join(tmpDir, "sysroot");
  }

  it.each([["gdb", "pid"], ["cppdbg", "processId"]])("translates local attach for %s with explicit precedence", (type, key) => {
    expect(buildAttachArgs({ type, program: "debugger", launchDefaults: { [key]: 1 } }, {
      processId: 42, attachConfig: { [key]: 2 },
    })).toEqual({ [key]: 42 });
  });

  it("merges GDB environment overrides without changing other engines", async () => {
    vi.stubEnv("DAP_GDB_INHERITED_TEST", "inherited");
    const options = { stopOnEntry: false, env: { CUSTOM: "explicit" } };
    const gdb = await buildLaunchArgs({ type: "gdb", program: "gdb" }, options);
    expect(gdb.env).toMatchObject({ DAP_GDB_INHERITED_TEST: "inherited", CUSTOM: "explicit" });
    expect((await buildLaunchArgs({ type: "python", program: "adapter" }, options)).env).toEqual({ CUSTOM: "explicit" });
    expect((await buildLaunchArgs({ type: "gdb", program: "gdb" }, { stopOnEntry: false })).env).toBeUndefined();
  });

  async function fakeGdbSysroot() {
    const sdk = path.join(tmpDir, 'sdk "quoted"');
    const etc = path.join(sdk, "lib", "rustlib", "etc");
    await fs.mkdir(etc, { recursive: true });
    for (const file of ["gdb_load_rust_pretty_printers.py", "gdb_lookup.py", "gdb_providers.py", "rust_types.py"]) {
      await fs.writeFile(path.join(etc, file), "# fixture\n");
    }
    return { sdk, etc };
  }

  it("prepares trusted Rust GDB formatters before spawn without mutating configuration", async () => {
    const { sdk, etc } = await fakeGdbSysroot();
    const config = { type: "gdb", program: "gdb", args: ["--nx", "--interpreter=dap"] };
    const prepared = await prepareNativeAdapterConfig(config, { cwd: path.join(tmpDir, "project"), sourceFiles: ["/src/main.rs"] }, async () => sdk);
    expect(config.args).toEqual(["--nx", "--interpreter=dap"]);
    expect(prepared.args?.slice(0, 2)).toEqual(["--nx", "--interpreter=dap"]);
    expect(prepared.args?.at(-2)).toBe("-iex");
    const command = prepared.args?.at(-1) ?? "";
    expect(command).toMatch(/^python /);
    expect(command).not.toContain("\n");
    expect(JSON.parse(command.match(/sys\.path\.insert\(0, ("(?:\\.|[^"\\])*")\)/)![1])).toBe(etc);
    expect((await prepareNativeAdapterConfig(prepared, { sourceFiles: ["/src/main.rs"] }, async () => sdk)).args).toEqual(prepared.args);
  });

  it("does not load missing, project-local, symlink-escaped or non-Rust GDB scripts", async () => {
    const { sdk, etc } = await fakeGdbSysroot();
    const config = { type: "gdb", program: "gdb" };
    expect(await prepareNativeAdapterConfig(config, { cwd: sdk, sourceFiles: ["/src/main.rs"] }, async () => sdk)).toEqual(config);
    expect(await prepareNativeAdapterConfig(config, { sourceFiles: ["/src/main.c"] }, async () => sdk)).toEqual(config);
    const file = path.join(etc, "gdb_lookup.py");
    await fs.unlink(file);
    expect(await prepareNativeAdapterConfig(config, { sourceFiles: ["/src/main.rs"] }, async () => sdk)).toEqual(config);
    const escape = path.join(tmpDir, "untrusted.py");
    await fs.writeFile(escape, "# untrusted"); await fs.symlink(escape, file);
    expect(await prepareNativeAdapterConfig(config, { sourceFiles: ["/src/main.rs"] }, async () => sdk)).toEqual(config);
  });

  it("prepares a Cargo run without source breakpoints and tolerates failed toolchain discovery", async () => {
    const { sdk } = await fakeGdbSysroot();
    const project = path.join(tmpDir, "project");
    await fs.mkdir(project);
    await fs.writeFile(path.join(project, "Cargo.toml"), "[workspace]\n");
    const config = { type: "gdb", program: "gdb" };
    expect((await prepareNativeAdapterConfig(config, { cwd: project }, async () => sdk)).args).toContain("-iex");
    expect(await prepareNativeAdapterConfig(config, { cwd: project }, async () => { throw new Error("rustc failed"); })).toEqual(config);
  });

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
