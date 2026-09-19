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

import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { AdapterConfig } from "../dap/types.js";

const execFileAsync = promisify(execFile);

export interface LaunchArgOptions {
  program?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  /** Adapter-specific launch fields, merged below the explicit common options. */
  launchConfig?: Record<string, unknown>;
  stopOnEntry: boolean;
  /** Source files the session will break in; selects language-specific recipes. */
  sourceFiles?: string[];
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

let rustSysroot: Promise<string | undefined> | undefined;

function findRustSysroot(): Promise<string | undefined> {
  rustSysroot ??= execFileAsync("rustc", ["--print", "sysroot"])
    .then(({ stdout }) => stdout.trim() || undefined)
    .catch(() => undefined);
  return rustSysroot;
}

/**
 * The LLDB commands `rust-lldb` runs before loading a binary. Without them
 * lldb-dap shows `String`, `&str`, `Vec` and `HashMap` as raw structs.
 */
async function rustFormatterCommands(sysroot: string | undefined): Promise<string[]> {
  if (!sysroot) return [];
  const etc = path.join(sysroot, "lib", "rustlib", "etc");
  const lookup = path.join(etc, "lldb_lookup.py");
  if (!(await exists(lookup))) return [];
  const commands = [`command script import "${lookup}"`];
  // Older toolchains register the type summaries from a separate command file.
  const legacyCommands = path.join(etc, "lldb_commands");
  if (await exists(legacyCommands)) commands.push(`command source -s 0 "${legacyCommands}"`);
  return commands;
}

/**
 * Build the DAP launch arguments shared by debug_launch, debug_inspect/debug_at
 * and debug_run. Merge order: adapter launchDefaults < launchConfig < explicit
 * common fields, then per-adapter recipes that a caller would otherwise have
 * to know by heart.
 */
export async function buildLaunchArgs(
  config: AdapterConfig,
  opts: LaunchArgOptions,
  resolveRustSysroot: () => Promise<string | undefined> = findRustSysroot
): Promise<Record<string, unknown>> {
  const launchArgs: Record<string, unknown> = {
    ...config.launchDefaults,
    ...opts.launchConfig,
    stopOnEntry: opts.stopOnEntry,
  };
  if (opts.program !== undefined) launchArgs.program = opts.program;
  if (opts.args !== undefined) launchArgs.args = opts.args;
  if (opts.cwd !== undefined) launchArgs.cwd = opts.cwd;
  if (opts.env !== undefined) launchArgs.env = opts.env;

  // delve's `cwd` is the debuggee's working directory; the *build* (go build)
  // runs from delve's own process cwd, controlled by `dlvCwd`. Mirror
  // cwd → dlvCwd so a user-supplied cwd is found by `go build` looking for go.mod.
  if (config.type === "go" && opts.cwd !== undefined && launchArgs.dlvCwd === undefined) {
    launchArgs.dlvCwd = opts.cwd;
  }

  const involvesRust = (opts.sourceFiles ?? []).some(
    (file) => path.extname(file).toLowerCase() === ".rs"
  );
  if (config.type === "cppdbg" && involvesRust) {
    const existing = Array.isArray(launchArgs.initCommands)
      ? (launchArgs.initCommands as unknown[]).map(String)
      : [];
    if (!existing.some((command) => command.includes("lldb_lookup"))) {
      const formatters = await rustFormatterCommands(await resolveRustSysroot());
      if (formatters.length > 0) launchArgs.initCommands = [...existing, ...formatters];
    }
  }

  return launchArgs;
}

/** `target/debug/<package name>` of the Cargo project in cwd, once it has been built. */
export async function defaultCargoProgram(cwd: string): Promise<string | undefined> {
  const manifest = await fs.readFile(path.join(cwd, "Cargo.toml"), "utf8").catch(() => undefined);
  const name = manifest?.match(/^\s*\[package\][^[]*?^\s*name\s*=\s*"([^"]+)"/ms)?.[1];
  if (!name) return undefined;
  const binary = path.join(cwd, "target", "debug", process.platform === "win32" ? `${name}.exe` : name);
  return (await exists(binary)) ? binary : undefined;
}

const LAUNCH_FAILURE_HINTS: Record<string, string> = {
  php:
    "PHP ran without xdebug connecting to the adapter. Check that xdebug 3 is loaded in the CLI (php -m | grep -i xdebug) " +
    "and that launchConfig.runtimeArgs still enables it (-dxdebug.mode=debug -dxdebug.start_with_request=yes).",
};

/** Why a program may have run to completion without the debugger ever binding a breakpoint. */
export function launchFailureHint(adapterType: string): string | undefined {
  return LAUNCH_FAILURE_HINTS[adapterType];
}

const ADAPTER_USAGE_NOTES: Record<string, string> = {
  cppdbg: "Compile with debug info (-g -O0) and pass the executable as program.",
  rust: "Build with `cargo build`; debug_at defaults program to target/debug/<package name> and loads the Rust LLDB formatters.",
  php: "Needs xdebug 3 in the PHP CLI; the xdebug runtimeArgs are supplied by the adapter's launchDefaults.",
  java:
    "Start the JVM with -agentlib:jdwp=transport=dt_socket,server=y,suspend=y,address=127.0.0.1:5005, " +
    "then call debug_attach with port and breakpoints so they bind before the VM resumes.",
};

/** How to get a first stop with this language/adapter; surfaced by debug_doctor. */
export function adapterUsageNote(languageOrAdapter: string): string | undefined {
  return ADAPTER_USAGE_NOTES[languageOrAdapter];
}
