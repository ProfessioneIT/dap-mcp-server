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

import { AdapterRegistry } from "../adapters/registry.js";
import { SessionManager } from "./session-manager.js";
import { DebugSession } from "./session.js";
import { AdapterConfig } from "../dap/types.js";
import { buildLaunchArgs } from "../adapters/recipes.js";

export interface RunOptions {
  adapter: string;
  program: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  /** Optional logpoints — break with logMessage emits formatted output without pausing. */
  logpoints?: Array<{ file: string; line: number; logMessage: string }>;
  /** Total wall-clock timeout for the whole run (default: 60_000ms). */
  timeout?: number;
  adapterConfig?: AdapterConfig;
}

export interface RunResult {
  terminated: boolean;
  /** Debuggee exit code, when the adapter reports one. */
  exitCode?: number;
  output: string[];
  status: string;
}

/**
 * Launch a program with no stops, let it run to completion, and return the
 * collected output. Use for "what does this script actually do / print / crash with?"
 * cases where you don't need to inspect intermediate state. Pair with logpoints
 * for printf-style debugging.
 */
export async function runDebugRun(
  registry: AdapterRegistry,
  sessions: SessionManager,
  opts: RunOptions
): Promise<RunResult> {
  const config = opts.adapterConfig ?? registry.get(opts.adapter);
  if (!config) {
    throw new Error(
      `Adapter '${opts.adapter}' not found. Use list_adapters to see available adapters or configure_adapter to register one.`
    );
  }

  const id = sessions.generateId();
  const session = new DebugSession(id, config);
  sessions.add(session);

  const totalTimeout = opts.timeout ?? 60_000;
  const deadline = Date.now() + totalTimeout;

  try {
    await session.initialize();

    const launchArgs = await buildLaunchArgs(config, {
      program: opts.program,
      args: opts.args,
      cwd: opts.cwd,
      env: opts.env,
      stopOnEntry: false,
      sourceFiles: opts.logpoints?.map((lp) => lp.file),
    });

    const launchPromise = session.launch(launchArgs);
    // Suppress unhandled rejection: the real `await launchPromise` below will
    // still throw if launch fails.
    launchPromise.catch(() => { /* handled at await */ });
    await session.waitForInitialized(10000);

    if (opts.logpoints && opts.logpoints.length > 0) {
      const byFile = new Map<string, Array<{ line: number; logMessage: string }>>();
      for (const lp of opts.logpoints) {
        const existing = byFile.get(lp.file) ?? [];
        existing.push({ line: lp.line, logMessage: lp.logMessage });
        byFile.set(lp.file, existing);
      }
      for (const [file, bps] of byFile) {
        await session.setBreakpoints(file, bps);
      }
    }

    await session.configurationDone();
    await launchPromise;

    // Loop: if the program stops unexpectedly (e.g. exception, surprise breakpoint),
    // continue. Exit when the program terminates or the deadline passes.
    while (session.state !== "terminated") {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;

      if (session.state === "stopped") {
        await session.continueExecution();
      }

      const outcome = await session.waitForStopOrTermination(remaining);
      if (outcome.status === "timeout") break;
    }

    const terminated = session.state === "terminated";
    const exitCode = terminated ? await session.waitForExitCode() : undefined;
    const { output } = session.getOutput();
    return {
      terminated,
      exitCode,
      output: output.map((e) => e.text),
      status: session.state,
    };
  } finally {
    sessions.remove(session.id);
    try {
      await session.disconnect();
    } catch {
      /* best-effort cleanup */
    }
  }
}
