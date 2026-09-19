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
import { AdapterConfig, BreakpointResult, ExceptionDetails } from "../dap/types.js";
import { buildLaunchArgs, launchFailureHint } from "../adapters/recipes.js";

export interface InspectOptions {
  adapter: string;
  program?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  at: {
    file: string;
    line: number;
    condition?: string;
    hitCondition?: string;
  };
  expressions?: string[];
  timeout?: number;
  /** Adapter-specific launch fields, merged below explicit common options. */
  launchConfig?: Record<string, unknown>;
  adapterConfig?: AdapterConfig;
}

export interface InspectValueResult {
  result?: string;
  type?: string;
  error?: string;
}

export interface InspectResult {
  hit: boolean;
  reason?: string;
  /** What to check when the program ran past a breakpoint the adapter never bound. */
  hint?: string;
  /** Present when the program stopped on an exception instead of the breakpoint. */
  exception?: ExceptionDetails;
  location?: { file: string; line: number; functionName?: string; column?: number };
  values?: Record<string, InspectValueResult>;
  output?: string[];
  status?: string;
  /** Debuggee exit code, when the program terminated and the adapter reports one. */
  exitCode?: number;
  timedOut?: boolean;
  breakpoint?: BreakpointResult;
}

/**
 * Launch a program, run until it hits the given breakpoint, evaluate a set of
 * expressions in that frame, and disconnect. Collapses a multi-call workflow
 * into a single operation suitable for "what is X at line N?" debugging.
 */
export async function runDebugInspect(
  registry: AdapterRegistry,
  sessions: SessionManager,
  opts: InspectOptions
): Promise<InspectResult> {
  const config = opts.adapterConfig ?? registry.get(opts.adapter);
  if (!config) {
    throw new Error(
      `Adapter '${opts.adapter}' not found. Use list_adapters to see available adapters or configure_adapter to register one.`
    );
  }

  const id = sessions.generateId();
  const session = new DebugSession(id, config);
  sessions.add(session);

  try {
    await session.initialize();

    const launchArgs = await buildLaunchArgs(config, {
      program: opts.program,
      args: opts.args,
      cwd: opts.cwd,
      env: opts.env,
      launchConfig: opts.launchConfig,
      stopOnEntry: false,
      sourceFiles: [opts.at.file],
    });

    const launchPromise = session.launch(launchArgs);
    // Suppress unhandled rejection: the real `await launchPromise` below will
    // still throw if launch fails. Without this, an early launch rejection
    // (e.g. adapter rejects the request) crashes the MCP server.
    launchPromise.catch(() => { /* handled at await */ });
    await session.waitForInitialized(10000);

    const breakpoint = (await session.setBreakpoints(opts.at.file, [
      {
        line: opts.at.line,
        condition: opts.at.condition,
        hitCondition: opts.at.hitCondition,
      },
    ]))[0];

    await session.configurationDone();
    await launchPromise;

    const waitMs = opts.timeout ?? 30000;
    const outcome = await session.waitForStopOrTermination(waitMs);
    if (outcome.status !== "stopped") {
      const terminated = outcome.status === "terminated";
      const { output } = session.getOutput();
      return {
        hit: false,
        hint: terminated && !breakpoint?.verified ? launchFailureHint(config.type) : undefined,
        exitCode: terminated ? await session.waitForExitCode() : undefined,
        reason:
          outcome.status === "terminated"
            ? "Program terminated before reaching the breakpoint."
            : breakpoint && !breakpoint.verified
              ? breakpoint.message ?? "The adapter did not verify the breakpoint."
              : "Timed out while waiting for the breakpoint.",
        status: outcome.status === "timeout" ? session.state : outcome.status,
        timedOut: outcome.status === "timeout",
        breakpoint,
        output: output.map((e) => e.text),
      };
    }

    const state = await session.collectState();
    const effectiveBreakpoint =
      breakpoint && state.reason === "breakpoint"
        ? {
            ...breakpoint,
            verified: true,
            line: opts.at.line,
            message: breakpoint.verified ? breakpoint.message : undefined,
          }
        : breakpoint;
    const values: Record<string, InspectValueResult> = {};
    if (opts.expressions && opts.expressions.length > 0) {
      // Some adapters (vscode-js-debug) require a frameId to evaluate names
      // bound in the current function's scope. Use the top frame's id when
      // available so locals resolve correctly.
      const topFrameId = state.stackTrace?.[0]?.id;
      for (const expr of opts.expressions) {
        try {
          const r = await session.evaluate(expr, topFrameId);
          values[expr] = { result: r.result, type: r.type };
        } catch (err) {
          values[expr] = { error: err instanceof Error ? err.message : String(err) };
        }
      }
    }

    return {
      hit: true,
      reason: state.reason,
      exception: state.exception,
      location: state.location,
      values: opts.expressions && opts.expressions.length > 0 ? values : undefined,
      output: state.output,
      status: "stopped",
      breakpoint: effectiveBreakpoint,
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
