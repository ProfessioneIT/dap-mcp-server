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

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import os from "node:os";
import path from "node:path";

import { AdapterRegistry } from "./adapters/registry.js";
import { SessionManager } from "./session/session-manager.js";
import { DebugSession } from "./session/session.js";
import { checkAdapterAvailable } from "./adapters/detect.js";

export function createServer(): McpServer {
  const globalDir = path.join(os.homedir(), ".dap-mcp");
  const projectDir = path.join(process.cwd(), ".dap-mcp");

  const registry = new AdapterRegistry(globalDir, projectDir);
  const sessions = new SessionManager();

  // Load persisted adapter configs (best-effort, don't block server start)
  registry.load().catch((err: unknown) => {
    console.error("Warning: failed to load adapter configs:", err);
  });

  const server = new McpServer(
    {
      name: "dap-mcp-server",
      version: "0.1.0",
    },
    {
      instructions: [
        "This server provides AI-driven debugging via the Debug Adapter Protocol (DAP).",
        "",
        "## Debugging Workflow",
        "",
        "A typical session follows this sequence:",
        "1. `list_adapters` — discover available debug adapters and check which are installed",
        "2. `debug_launch` (or `debug_attach`) — start a debug session. This performs the full DAP handshake,",
        "   sets initial breakpoints, and launches the program. Returns a sessionId and initial stopped state.",
        "3. Inspect state with `get_state` — returns threads, call stack, scopes, and variables in one call.",
        "   This is a coarse-grained tool designed to minimize round-trips; prefer it over multiple fine-grained queries.",
        "4. `step` — control execution (continue, next, stepIn, stepOut, pause). Each step action blocks until",
        "   the program stops again and returns the new state, so you do NOT need to call get_state after stepping.",
        "5. `evaluate` — evaluate expressions in the context of a stopped frame (REPL, watch, or hover context).",
        "6. `set_breakpoints` / `set_exception_breakpoints` — modify breakpoints during the session.",
        "7. `get_output` — retrieve buffered stdout/stderr/console output (ring buffer, max 10K lines).",
        "8. `debug_disconnect` — end the session. `debug_restart` replays the same launch config with preserved breakpoints.",
        "",
        "## Key Conventions",
        "",
        "- **Auto-session resolution**: All tools accept an optional `sessionId`. When only one session is active,",
        "  you can omit it — the server resolves it automatically.",
        "- **Synchronous stepping**: `step` returns the new stopped state directly. Do not follow a step with get_state",
        "  unless you need to change parameters like `variableDepth` or `threadId`.",
        "- **Coarse get_state**: Fetches threads + stack frames + scopes + variables in a single call.",
        "  Use `depth` (default 10) and `variableDepth` (default 1) to control how much data is returned.",
        "- **Output buffering**: Program output is buffered in a 10K-line ring buffer. Oldest lines are dropped",
        "  when the buffer is full. Use `get_output` with `clear: true` to consume and free buffer space.",
        "- **Adapter registration**: Use `configure_adapter` to register adapters. Configs are persisted to",
        "  `~/.dap-mcp/adapters.json` (global) or `./.dap-mcp/adapters.json` (project), with project overriding global.",
        "- **Error handling**: All tool errors are returned as `isError: true` results with an error message.",
        "  The session remains usable after most errors.",
      ].join("\n"),
    }
  );

  // ────────────────────────────────────────────────────────────────────────────
  // 1. list_adapters
  // ────────────────────────────────────────────────────────────────────────────
  server.tool(
    "list_adapters",
    "List all known debug adapters with their availability status on this machine.",
    {},
    async () => {
      try {
        const adapters = registry.listAll();
        const results = await Promise.all(
          adapters.map(async (a) => {
            const cmd = a.runtime || a.program;
            const available = cmd ? await checkAdapterAvailable(cmd) : false;
            return { ...a, available };
          })
        );
        return {
          content: [{ type: "text" as const, text: JSON.stringify(results, null, 2) }],
        };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `Error: ${String(err)}` }],
          isError: true,
        };
      }
    }
  );

  // ────────────────────────────────────────────────────────────────────────────
  // 2. configure_adapter
  // ────────────────────────────────────────────────────────────────────────────
  server.tool(
    "configure_adapter",
    "Register or update a debug adapter configuration and persist it to disk.",
    {
      type: z.string().describe("Adapter type identifier (e.g. 'python', 'node', 'go')"),
      program: z.string().describe("Path or command for the adapter executable"),
      runtime: z.string().optional().describe("Optional runtime to invoke the program (e.g. 'node', 'python3')"),
      args: z.array(z.string()).optional().describe("Additional arguments to pass to the adapter"),
      launchDefaults: z.record(z.string(), z.unknown()).optional().describe("Default launch configuration properties"),
      installHint: z.string().optional().describe("Hint shown when adapter is not installed"),
      scope: z.enum(["global", "project"]).optional().describe("Where to persist the adapter config (default: project)"),
    },
    async ({ type, program, runtime, args, launchDefaults, installHint, scope }) => {
      try {
        const config = { type, program, runtime, args, launchDefaults, installHint };
        const saveScope = scope ?? "project";
        registry.register(config, saveScope);
        await registry.save(saveScope);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ success: true, type, scope: saveScope }, null, 2),
            },
          ],
        };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `Error: ${String(err)}` }],
          isError: true,
        };
      }
    }
  );

  // ────────────────────────────────────────────────────────────────────────────
  // 3. debug_launch
  // ────────────────────────────────────────────────────────────────────────────
  server.tool(
    "debug_launch",
    "Launch a program under a debug adapter. Performs the full DAP initialization lifecycle and returns the session ID and initial stopped state.",
    {
      adapter: z.string().describe("Adapter type to use (e.g. 'python', 'node')"),
      program: z.string().describe("Path to the program to debug"),
      args: z.array(z.string()).optional().describe("Program arguments"),
      cwd: z.string().optional().describe("Working directory for the program"),
      env: z.record(z.string(), z.string()).optional().describe("Environment variables"),
      stopOnEntry: z.boolean().optional().describe("Stop on program entry (default: true)"),
      breakpoints: z
        .array(
          z.object({
            file: z.string().describe("Source file path"),
            line: z.number().describe("Line number"),
            condition: z.string().optional(),
            hitCondition: z.string().optional(),
            logMessage: z.string().optional(),
          })
        )
        .optional()
        .describe("Breakpoints to set before launching"),
      exceptionBreakpoints: z
        .array(z.string())
        .optional()
        .describe("Exception filter IDs (e.g. ['uncaughtExceptions'])"),
      adapterConfig: z
        .object({
          type: z.string(),
          program: z.string(),
          runtime: z.string().optional(),
          args: z.array(z.string()).optional(),
          launchDefaults: z.record(z.string(), z.unknown()).optional(),
          installHint: z.string().optional(),
        })
        .optional()
        .describe("Override adapter config inline instead of looking up from registry"),
    },
    async ({
      adapter,
      program,
      args,
      cwd,
      env,
      stopOnEntry,
      breakpoints,
      exceptionBreakpoints,
      adapterConfig,
    }) => {
      const shouldStop = stopOnEntry !== false;
      let session: DebugSession | undefined;
      try {
        const config =
          adapterConfig ??
          registry.get(adapter);

        if (!config) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Error: Adapter '${adapter}' not found. Use list_adapters to see available adapters or configure_adapter to register one.`,
              },
            ],
            isError: true,
          };
        }

        const id = sessions.generateId();
        session = new DebugSession(id, config);
        sessions.add(session);

        // Initialize (waits for the initialized event internally)
        await session.initialize();

        // Build launch request
        const launchArgs: Record<string, unknown> = {
          ...config.launchDefaults,
          program,
          stopOnEntry: shouldStop,
        };
        if (args !== undefined) launchArgs.args = args;
        if (cwd !== undefined) launchArgs.cwd = cwd;
        if (env !== undefined) launchArgs.env = env;

        // Send launch first (don't await — real adapters like debugpy block
        // the launch response until configurationDone arrives)
        const launchPromise = session.launch(launchArgs);

        // Set breakpoints grouped by file
        if (breakpoints && breakpoints.length > 0) {
          const byFile = new Map<string, typeof breakpoints>();
          for (const bp of breakpoints) {
            const existing = byFile.get(bp.file) ?? [];
            existing.push(bp);
            byFile.set(bp.file, existing);
          }
          for (const [file, bps] of byFile) {
            await session.setBreakpoints(
              file,
              bps.map((b) => ({
                line: b.line,
                condition: b.condition,
                hitCondition: b.hitCondition,
                logMessage: b.logMessage,
              }))
            );
          }
        }

        // Set exception breakpoints
        if (exceptionBreakpoints && exceptionBreakpoints.length > 0) {
          await session.setExceptionBreakpoints(exceptionBreakpoints);
        }

        // Configuration done — signals the adapter to proceed with launch
        await session.configurationDone();

        // Now await the launch response
        await launchPromise;

        let stateData: Record<string, unknown>;
        if (shouldStop) {
          try {
            await session.waitForStopped(10000);
            stateData = (await session.collectState()) as unknown as Record<string, unknown>;
          } catch {
            stateData = { status: session.state };
          }
        } else {
          stateData = { status: session.state };
        }

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ sessionId: id, ...stateData }, null, 2),
            },
          ],
        };
      } catch (err) {
        if (session) {
          sessions.remove(session.id);
          session.disconnect().catch(() => undefined);
        }
        return {
          content: [{ type: "text" as const, text: `Error: ${String(err)}` }],
          isError: true,
        };
      }
    }
  );

  // ────────────────────────────────────────────────────────────────────────────
  // 4. debug_attach
  // ────────────────────────────────────────────────────────────────────────────
  server.tool(
    "debug_attach",
    "Attach a debug adapter to an already-running process.",
    {
      adapter: z.string().describe("Adapter type to use"),
      port: z.number().optional().describe("Debug port to attach to"),
      host: z.string().optional().describe("Host to attach to (default: localhost)"),
      processId: z.number().optional().describe("PID of process to attach to"),
      attachConfig: z.record(z.string(), z.unknown()).optional().describe("Arbitrary attach configuration properties"),
      adapterConfig: z
        .object({
          type: z.string(),
          program: z.string(),
          runtime: z.string().optional(),
          args: z.array(z.string()).optional(),
          launchDefaults: z.record(z.string(), z.unknown()).optional(),
          installHint: z.string().optional(),
        })
        .optional()
        .describe("Override adapter config inline"),
    },
    async ({ adapter, port, host, processId, attachConfig, adapterConfig }) => {
      let session: DebugSession | undefined;
      try {
        const config = adapterConfig ?? registry.get(adapter);
        if (!config) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Error: Adapter '${adapter}' not found.`,
              },
            ],
            isError: true,
          };
        }

        const id = sessions.generateId();
        session = new DebugSession(id, config);
        sessions.add(session);

        await session.initialize();

        // Merge order: adapter defaults (lowest priority) < user attachConfig < explicit params (highest)
        const attachArgs: Record<string, unknown> = {
          ...config.launchDefaults,
          ...attachConfig,
        };
        if (port !== undefined) attachArgs.port = port;
        if (host !== undefined) attachArgs.host = host;
        if (processId !== undefined) attachArgs.processId = processId;

        // Send attach first (don't await — real adapters block until configurationDone)
        const attachPromise = session.attach(attachArgs);
        await session.configurationDone();
        await attachPromise;

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ sessionId: id, status: session.state }, null, 2),
            },
          ],
        };
      } catch (err) {
        if (session) {
          sessions.remove(session.id);
          session.disconnect().catch(() => undefined);
        }
        return {
          content: [{ type: "text" as const, text: `Error: ${String(err)}` }],
          isError: true,
        };
      }
    }
  );

  // ────────────────────────────────────────────────────────────────────────────
  // 5. set_breakpoints
  // ────────────────────────────────────────────────────────────────────────────
  server.tool(
    "set_breakpoints",
    "Set breakpoints in a source file for an active debug session.",
    {
      sessionId: z.string().optional().describe("Session ID (omit if only one session is active)"),
      file: z.string().describe("Absolute path to the source file"),
      breakpoints: z
        .array(
          z.object({
            line: z.number().describe("Line number (1-based)"),
            condition: z.string().optional().describe("Condition expression"),
            hitCondition: z.string().optional().describe("Hit count condition"),
            logMessage: z.string().optional().describe("Log message (logpoint)"),
          })
        )
        .describe("Breakpoints to set"),
    },
    async ({ sessionId, file, breakpoints }) => {
      try {
        const session = sessions.resolve(sessionId);
        const results = await session.setBreakpoints(file, breakpoints);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(results, null, 2) }],
        };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `Error: ${String(err)}` }],
          isError: true,
        };
      }
    }
  );

  // ────────────────────────────────────────────────────────────────────────────
  // 6. set_exception_breakpoints
  // ────────────────────────────────────────────────────────────────────────────
  server.tool(
    "set_exception_breakpoints",
    "Configure exception breakpoints for an active debug session.",
    {
      sessionId: z.string().optional().describe("Session ID (omit if only one session is active)"),
      filters: z
        .array(z.string())
        .describe("Exception filter IDs to enable (e.g. ['uncaughtExceptions', 'userUnhandledExceptions'])"),
    },
    async ({ sessionId, filters }) => {
      try {
        const session = sessions.resolve(sessionId);
        await session.setExceptionBreakpoints(filters);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ success: true, filters }, null, 2),
            },
          ],
        };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `Error: ${String(err)}` }],
          isError: true,
        };
      }
    }
  );

  // ────────────────────────────────────────────────────────────────────────────
  // 7. get_state
  // ────────────────────────────────────────────────────────────────────────────
  server.tool(
    "get_state",
    "Get the current state of a debug session. If stopped, returns full stack/scopes/variables. If running, returns status and buffered output.",
    {
      sessionId: z.string().optional().describe("Session ID (omit if only one session is active)"),
      threadId: z.number().optional().describe("Thread ID (uses stopped thread if omitted)"),
      depth: z.number().optional().describe("Stack trace depth (default: 10)"),
      variableDepth: z.number().optional().describe("Variable expansion depth (default: 1)"),
      timeout: z
        .number()
        .optional()
        .describe("If running, wait up to this many milliseconds for the program to stop (default: 0 = don't wait)"),
    },
    async ({ sessionId, threadId, depth, variableDepth, timeout }) => {
      try {
        const session = sessions.resolve(sessionId);
        const waitMs = timeout ?? 0;

        if (session.state === "stopped") {
          const state = await session.collectState(threadId, depth ?? 10, variableDepth ?? 1);
          return {
            content: [{ type: "text" as const, text: JSON.stringify(state, null, 2) }],
          };
        }

        if (waitMs > 0 && session.state === "running") {
          try {
            await session.waitForStopped(waitMs);
            const state = await session.collectState(threadId, depth ?? 10, variableDepth ?? 1);
            return {
              content: [{ type: "text" as const, text: JSON.stringify(state, null, 2) }],
            };
          } catch {
            // Timed out — fall through to return running status
          }
        }

        const { output } = session.getOutput();
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  status: session.state,
                  output: output.map((e) => e.text),
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `Error: ${String(err)}` }],
          isError: true,
        };
      }
    }
  );

  // ────────────────────────────────────────────────────────────────────────────
  // 8. evaluate
  // ────────────────────────────────────────────────────────────────────────────
  server.tool(
    "evaluate",
    "Evaluate an expression in the context of a stopped debug session.",
    {
      sessionId: z.string().optional().describe("Session ID (omit if only one session is active)"),
      expression: z.string().describe("Expression to evaluate"),
      frameId: z.number().optional().describe("Stack frame ID (uses topmost frame if omitted)"),
      context: z
        .enum(["repl", "watch", "hover"])
        .optional()
        .describe("Evaluation context (default: repl)"),
    },
    async ({ sessionId, expression, frameId, context }) => {
      try {
        const session = sessions.resolve(sessionId);
        if (session.state !== "stopped") {
          return {
            content: [
              {
                type: "text" as const,
                text: `Error: Session is not stopped (current state: ${session.state}). Use 'step' with action 'pause' to stop first.`,
              },
            ],
            isError: true,
          };
        }
        const result = await session.evaluate(expression, frameId, context ?? "repl");
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `Error: ${String(err)}` }],
          isError: true,
        };
      }
    }
  );

  // ────────────────────────────────────────────────────────────────────────────
  // 9. step
  // ────────────────────────────────────────────────────────────────────────────
  server.tool(
    "step",
    "Control execution of a debug session: continue, step over (next), step into, step out, or pause. Waits for the program to stop and returns the new state.",
    {
      sessionId: z.string().optional().describe("Session ID (omit if only one session is active)"),
      action: z
        .enum(["continue", "next", "stepIn", "stepOut", "pause"])
        .describe("Execution control action"),
      threadId: z.number().optional().describe("Thread ID (uses stopped thread if omitted)"),
      timeout: z
        .number()
        .optional()
        .describe("Milliseconds to wait for the program to stop after the action (default: 30000)"),
    },
    async ({ sessionId, action, threadId, timeout }) => {
      try {
        const session = sessions.resolve(sessionId);
        const waitMs = timeout ?? 30000;
        const startTime = Date.now();

        // If already stopped and asking to pause, just return current state
        if (action === "pause" && session.state === "stopped") {
          const state = await session.collectState(threadId);
          return {
            content: [{ type: "text" as const, text: JSON.stringify(state, null, 2) }],
          };
        }

        switch (action) {
          case "continue":
            await session.continueExecution(threadId);
            break;
          case "next":
            await session.next(threadId);
            break;
          case "stepIn":
            await session.stepIn(threadId);
            break;
          case "stepOut":
            await session.stepOut(threadId);
            break;
          case "pause":
            await session.pause(threadId);
            break;
        }

        try {
          await session.waitForStopped(waitMs);
        } catch (err) {
          // Timeout or terminated
          const elapsed = Date.now() - startTime;
          if (session.state === "terminated") {
            const { output } = session.getOutput();
            return {
              content: [
                {
                  type: "text" as const,
                  text: JSON.stringify(
                    { status: "terminated", output: output.map((e) => e.text) },
                    null,
                    2
                  ),
                },
              ],
            };
          }
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({ status: "running", elapsedMs: elapsed }, null, 2),
              },
            ],
          };
        }

        if (session.state === "terminated") {
          const { output } = session.getOutput();
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  { status: "terminated", output: output.map((e) => e.text) },
                  null,
                  2
                ),
              },
            ],
          };
        }

        const state = await session.collectState(threadId);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(state, null, 2) }],
        };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `Error: ${String(err)}` }],
          isError: true,
        };
      }
    }
  );

  // ────────────────────────────────────────────────────────────────────────────
  // 10. get_output
  // ────────────────────────────────────────────────────────────────────────────
  server.tool(
    "get_output",
    "Get buffered stdout/stderr and debug adapter output for a session.",
    {
      sessionId: z.string().optional().describe("Session ID (omit if only one session is active)"),
      category: z
        .string()
        .optional()
        .describe("Filter by output category: 'stdout', 'stderr', 'console', etc."),
      clear: z.boolean().optional().describe("Clear the output buffer after reading (default: false)"),
    },
    async ({ sessionId, category, clear }) => {
      try {
        const session = sessions.resolve(sessionId);
        const result = session.getOutput(category, clear ?? false);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `Error: ${String(err)}` }],
          isError: true,
        };
      }
    }
  );

  // ────────────────────────────────────────────────────────────────────────────
  // 11. debug_disconnect
  // ────────────────────────────────────────────────────────────────────────────
  server.tool(
    "debug_disconnect",
    "Disconnect from a debug session and optionally terminate the debuggee.",
    {
      sessionId: z.string().optional().describe("Session ID (omit if only one session is active)"),
      terminateDebuggee: z
        .boolean()
        .optional()
        .describe("Whether to terminate the debuggee process (default: true for launched sessions, false for attached)"),
    },
    async ({ sessionId, terminateDebuggee }) => {
      try {
        const session = sessions.resolve(sessionId);
        await session.disconnect(terminateDebuggee);
        sessions.remove(session.id);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ success: true, sessionId: session.id }, null, 2),
            },
          ],
        };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `Error: ${String(err)}` }],
          isError: true,
        };
      }
    }
  );

  // ────────────────────────────────────────────────────────────────────────────
  // 12. debug_restart
  // ────────────────────────────────────────────────────────────────────────────
  server.tool(
    "debug_restart",
    "Restart a debug session with the same adapter and launch configuration.",
    {
      sessionId: z.string().optional().describe("Session ID to restart (omit if only one session is active)"),
    },
    async ({ sessionId }) => {
      let oldSession: DebugSession | undefined;
      let newSession: DebugSession | undefined;
      try {
        oldSession = sessions.resolve(sessionId);
        const launchMode = oldSession.getLaunchMode();

        if (launchMode === "attach") {
          return {
            content: [
              {
                type: "text" as const,
                text: "Error: Cannot restart an attached session. Attached sessions cannot be restarted.",
              },
            ],
            isError: true,
          };
        }

        const launchConfig = oldSession.getLaunchConfig();
        const adapterConfig = oldSession.getAdapterConfig();
        const savedBreakpoints = oldSession.getBreakpoints();

        if (!launchConfig) {
          return {
            content: [
              {
                type: "text" as const,
                text: "Error: No launch configuration found for this session.",
              },
            ],
            isError: true,
          };
        }

        // Disconnect old session
        await oldSession.disconnect();
        sessions.remove(oldSession.id);

        // Create new session with same adapter config
        const newId = sessions.generateId();
        newSession = new DebugSession(newId, adapterConfig);
        sessions.add(newSession);

        // Initialize (waits for the initialized event internally)
        await newSession.initialize();

        // Send launch first (don't await — real adapters block until configurationDone)
        const launchPromise = newSession.launch(launchConfig);

        // Re-apply saved breakpoints
        for (const [file, bps] of savedBreakpoints) {
          await newSession.setBreakpoints(file, bps);
        }

        await newSession.configurationDone();
        await launchPromise;

        const stopOnEntry = launchConfig.stopOnEntry !== false;
        let stateData: Record<string, unknown>;
        if (stopOnEntry) {
          try {
            await newSession.waitForStopped(10000);
            stateData = (await newSession.collectState()) as unknown as Record<string, unknown>;
          } catch {
            stateData = { status: newSession.state };
          }
        } else {
          stateData = { status: newSession.state };
        }

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                { sessionId: newId, previousSessionId: oldSession.id, ...stateData },
                null,
                2
              ),
            },
          ],
        };
      } catch (err) {
        if (newSession) {
          sessions.remove(newSession.id);
          newSession.disconnect().catch(() => undefined);
        }
        return {
          content: [{ type: "text" as const, text: `Error: ${String(err)}` }],
          isError: true,
        };
      }
    }
  );

  // ────────────────────────────────────────────────────────────────────────────
  // Resource: dap://sessions
  // ────────────────────────────────────────────────────────────────────────────
  // NOTE: This resource does not emit change notifications.
  // Clients should poll or use get_state for up-to-date session information.
  server.resource(
    "sessions",
    "dap://sessions",
    {
      description: "List of all active debug sessions with their current status.",
      mimeType: "application/json",
    },
    async (_uri) => {
      const all = sessions.listAll().map((s) => ({
        id: s.id,
        state: s.state,
        adapterType: s.getAdapterConfig().type,
      }));
      return {
        contents: [
          {
            uri: "dap://sessions",
            text: JSON.stringify(all, null, 2),
          },
        ],
      };
    }
  );

  return server;
}
