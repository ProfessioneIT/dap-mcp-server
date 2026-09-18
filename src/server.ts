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
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { AdapterRegistry } from "./adapters/registry.js";
import { SessionManager } from "./session/session-manager.js";
import { DebugSession } from "./session/session.js";
import { runDebugInspect } from "./session/inspect.js";
import { runDebugRun } from "./session/run.js";
import { inspectAdapterAvailability } from "./adapters/detect.js";
import { resolveProjectAdapter, runDebugDoctor } from "./diagnostics/doctor.js";

function readPackageVersion(): string {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(
      readFileSync(path.join(here, "..", "package.json"), "utf-8")
    ) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export function createServer(): McpServer {
  const globalDir = path.join(os.homedir(), ".dap-mcp");
  const projectDir = path.join(process.cwd(), ".dap-mcp");

  const registry = new AdapterRegistry(globalDir, projectDir);
  const sessions = new SessionManager();

  // Load persisted adapter configs (best-effort, don't block server start)
  const registryReady = registry.load().catch((err: unknown) => {
    console.error("Warning: failed to load adapter configs:", err);
  });

  const server = new McpServer(
    {
      name: "dap-mcp-server",
      version: readPackageVersion(),
    },
    {
      instructions: [
        "Local source-code debugger using the Debug Adapter Protocol.",
        "Use it when a test fails, a program crashes, runtime state is unclear, or code behavior cannot be explained statically.",
        "Start with debug_doctor to detect the project and verify adapter readiness.",
        "Prefer debug_at for a one-call breakpoint inspection: it selects the adapter, launches, waits, evaluates expressions, and cleans up.",
        "Use debug_run when output or termination is enough. Use debug_launch only for interactive stepping or multiple inspection points.",
        "For interactive sessions: debug_launch -> get_state/evaluate -> step -> debug_disconnect. A launch with breakpoints waits by default and reports stopped, terminated, or timeout explicitly.",
        "Omit sessionId when exactly one session is active. Adapter-specific DAP fields belong in launchConfig. Tool errors use isError=true.",
      ].join("\n"),
    }
  );

  const doctorOutputSchema = z.object({
    cwd: z.string(),
    ready: z.boolean(),
    recommendedAdapter: z.string().optional(),
    detected: z.object({
      languages: z.array(z.string()),
      testFrameworks: z.array(z.string()),
      packageManager: z.string().optional(),
      pythonPath: z.string().optional(),
      launchJson: z.string().optional(),
    }),
    adapters: z.array(
      z.object({
        type: z.string(),
        source: z.enum(["builtin", "global", "project"]),
        selected: z.boolean(),
        available: z.boolean(),
        command: z.string(),
        reason: z.string().optional(),
        installHint: z.string().optional(),
        runtime: z.string().optional(),
        program: z.string(),
        transport: z.enum(["stdio", "tcp"]),
      })
    ),
    nextSteps: z.array(z.string()),
  });

  const breakpointResultSchema = z.object({
    id: z.number().optional(),
    verified: z.boolean(),
    line: z.number(),
    message: z.string().optional(),
  });

  const debugAtOutputSchema = z.object({
    adapter: z.string(),
    hit: z.boolean(),
    reason: z.string().optional(),
    location: z
      .object({
        file: z.string(),
        line: z.number(),
        functionName: z.string().optional(),
        column: z.number().optional(),
      })
      .optional(),
    values: z
      .record(
        z.string(),
        z.object({
          result: z.string().optional(),
          type: z.string().optional(),
          error: z.string().optional(),
        })
      )
      .optional(),
    output: z.array(z.string()).optional(),
    status: z.string().optional(),
    timedOut: z.boolean().optional(),
    breakpoint: breakpointResultSchema.optional(),
  });

  // ────────────────────────────────────────────────────────────────────────────
  // High-level LLM entry points
  // ────────────────────────────────────────────────────────────────────────────
  server.registerTool(
    "debug_doctor",
    {
      title: "Check debugger readiness",
      description:
        "Inspect a local project, detect its language/tooling, select the likely debug adapter, verify the complete adapter command, and return concrete remediation. Use this before debugging or when an adapter fails to start.",
      inputSchema: z.object({
        cwd: z.string().optional().describe("Project directory (default: server working directory)"),
        adapter: z.string().optional().describe("Adapter to validate instead of auto-detecting one"),
      }),
      outputSchema: doctorOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (options) => {
      try {
        await registryReady;
        const result = await runDebugDoctor(registry, options);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
          structuredContent: { ...result },
        };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `Error: ${String(err)}` }],
          isError: true,
        };
      }
    }
  );

  server.registerTool(
    "debug_at",
    {
      title: "Inspect runtime state at a line",
      description:
        "Primary one-shot debugging tool for bugs and failing behavior. Auto-selects a ready adapter, launches the program, stops at file:line, evaluates expressions, reports breakpoint/termination/timeout details, and cleans up.",
      inputSchema: z.object({
        cwd: z.string().optional().describe("Project and debuggee working directory"),
        adapter: z.string().optional().describe("Adapter type; auto-detected from file/project when omitted"),
        program: z
          .string()
          .optional()
          .describe("Launch target; defaults to file for Python/Node and cwd for Go"),
        args: z.array(z.string()).optional().describe("Program arguments"),
        env: z.record(z.string(), z.string()).optional().describe("Environment variables"),
        file: z.string().describe("Source file containing the breakpoint"),
        line: z.number().int().positive().describe("One-based breakpoint line"),
        condition: z.string().optional().describe("Conditional breakpoint expression"),
        hitCondition: z.string().optional().describe("Adapter-specific hit count condition"),
        expressions: z.array(z.string()).optional().describe("Expressions to evaluate in the stopped frame"),
        timeout: z.number().positive().optional().describe("Breakpoint wait timeout in milliseconds"),
        launchConfig: z
          .record(z.string(), z.unknown())
          .optional()
          .describe("Adapter-specific DAP launch fields"),
      }),
      outputSchema: debugAtOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (options) => {
      try {
        await registryReady;
        const cwd = path.resolve(options.cwd ?? process.cwd());
        const sourceFile = path.resolve(cwd, options.file);
        const resolved = await resolveProjectAdapter(registry, {
          cwd,
          adapter: options.adapter,
          sourceFile,
        });
        const adapter = resolved.result.recommendedAdapter;
        if (!adapter || !resolved.config || !resolved.result.ready) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Debugger is not ready:\n${JSON.stringify(resolved.result, null, 2)}`,
              },
            ],
            isError: true,
          };
        }

        const hasLaunchTarget =
          options.launchConfig !== undefined &&
          ["program", "module", "code"].some(
            (key) => options.launchConfig?.[key] !== undefined
          );
        if (!options.program && !hasLaunchTarget && adapter === "cppdbg") {
          return {
            content: [
              {
                type: "text" as const,
                text: "Error: C/C++ debugging requires the compiled executable in program or launchConfig.program.",
              },
            ],
            isError: true,
          };
        }
        const program =
          options.program ??
          (hasLaunchTarget ? undefined : adapter === "go" ? cwd : sourceFile);

        const result = await runDebugInspect(registry, sessions, {
          adapter,
          adapterConfig: resolved.config,
          program,
          args: options.args,
          cwd,
          env: options.env,
          at: {
            file: sourceFile,
            line: options.line,
            condition: options.condition,
            hitCondition: options.hitCondition,
          },
          expressions: options.expressions,
          timeout: options.timeout,
          launchConfig: options.launchConfig,
        });
        const structuredContent = { adapter, ...result };
        return {
          content: [
            { type: "text" as const, text: JSON.stringify(structuredContent, null, 2) },
          ],
          structuredContent,
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
  // 1. list_adapters
  // ────────────────────────────────────────────────────────────────────────────
  server.tool(
    "list_adapters",
    "List all known debug adapters with their availability status on this machine. Returns a summary line, the full adapter list, and a separate 'missing' list with installation hints for adapters that aren't installed.",
    {},
    {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    async () => {
      try {
        await registryReady;
        const adapters = registry.listAll();
        const results = await Promise.all(
          adapters.map(async (a) => {
            const availability = await inspectAdapterAvailability(a);
            return { ...a, ...availability };
          })
        );
        const available = results.filter((r) => r.available);
        const missing = results
          .filter((r) => !r.available)
          .map((r) => ({
            type: r.type,
            command: r.command,
            reason: r.reason,
            installHint: r.installHint,
          }));
        const summary =
          missing.length === 0
            ? `${available.length}/${results.length} adapters available`
            : `${available.length}/${results.length} adapters available; missing: ${missing.map((m) => m.type).join(", ")}`;
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ summary, adapters: results, missing }, null, 2),
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
      transport: z.enum(["stdio", "tcp"]).optional().describe("DAP transport used by the adapter"),
      portMatcher: z.string().optional().describe("Regex whose first capture group is the TCP port"),
      scope: z.enum(["global", "project"]).optional().describe("Where to persist the adapter config (default: project)"),
    },
    {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
    async ({ type, program, runtime, args, launchDefaults, installHint, transport, portMatcher, scope }) => {
      try {
        await registryReady;
        const config = {
          type,
          program,
          runtime,
          args,
          launchDefaults,
          installHint,
          transport,
          portMatcher,
        };
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
    "Launch an interactive debug session. With a breakpoint or stopOnEntry, waits by default and reports whether execution stopped, terminated, or timed out.",
    {
      adapter: z.string().describe("Adapter type to use (e.g. 'python', 'node')"),
      program: z.string().optional().describe("Path to the program to debug; may instead be supplied through launchConfig"),
      args: z.array(z.string()).optional().describe("Program arguments"),
      cwd: z.string().optional().describe("Working directory for the program"),
      env: z.record(z.string(), z.string()).optional().describe("Environment variables"),
      launchConfig: z
        .record(z.string(), z.unknown())
        .optional()
        .describe("Adapter-specific DAP launch properties; explicit common fields take precedence"),
      stopOnEntry: z
        .boolean()
        .optional()
        .describe("Stop on program entry. Defaults to false when breakpoints are provided (run to first breakpoint), true otherwise."),
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
      waitForStop: z
        .boolean()
        .optional()
        .describe("Wait for stopped/terminated outcome; defaults to true when a stop is expected"),
      timeout: z.number().positive().optional().describe("Wait timeout in milliseconds (default: 30000)"),
      adapterConfig: z
        .object({
          type: z.string(),
          program: z.string(),
          runtime: z.string().optional(),
          args: z.array(z.string()).optional(),
          launchDefaults: z.record(z.string(), z.unknown()).optional(),
          installHint: z.string().optional(),
          transport: z.enum(["stdio", "tcp"]).optional(),
          portMatcher: z.string().optional(),
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
      launchConfig,
      stopOnEntry,
      breakpoints,
      exceptionBreakpoints,
      waitForStop,
      timeout,
      adapterConfig,
    }) => {
      // Default: run to a configured breakpoint/exception; otherwise stop at entry.
      const expectsConfiguredStop =
        (breakpoints !== undefined && breakpoints.length > 0) ||
        (exceptionBreakpoints !== undefined && exceptionBreakpoints.length > 0);
      const shouldStop = stopOnEntry ?? !expectsConfiguredStop;
      let session: DebugSession | undefined;
      try {
        await registryReady;
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
          ...launchConfig,
          stopOnEntry: shouldStop,
        };
        if (program !== undefined) launchArgs.program = program;
        if (args !== undefined) launchArgs.args = args;
        if (cwd !== undefined) launchArgs.cwd = cwd;
        if (env !== undefined) launchArgs.env = env;

        // Adapter-specific arg normalization. delve's `cwd` is the debuggee's
        // working directory; the *build* (go build) runs from delve's own
        // process cwd, controlled by `dlvCwd`. Mirror cwd → dlvCwd so a
        // user-supplied cwd is found by `go build` looking for go.mod.
        if (config.type === "go" && cwd !== undefined && launchArgs.dlvCwd === undefined) {
          launchArgs.dlvCwd = cwd;
        }

        // Send launch first (don't await — real adapters like debugpy block
        // the launch response until configurationDone arrives)
        const launchPromise = session.launch(launchArgs);
        // Suppress unhandled rejection: the real `await launchPromise` below
        // will still throw if launch fails. Without this, an early launch
        // rejection (e.g. adapter rejects the request) crashes the MCP server.
        launchPromise.catch(() => { /* handled at await */ });

        // Wait for the adapter to emit the "initialized" event before sending
        // configuration requests. Some adapters (delve) emit it right after the
        // initialize response; others (debugpy) only emit it after receiving
        // launch — that's why we fire launch first and wait for initialized here.
        await session.waitForInitialized(10000);

        // Set breakpoints grouped by file
        const breakpointResults: Array<{
          file: string;
          breakpoints: Awaited<ReturnType<DebugSession["setBreakpoints"]>>;
        }> = [];
        if (breakpoints && breakpoints.length > 0) {
          const byFile = new Map<string, typeof breakpoints>();
          for (const bp of breakpoints) {
            const existing = byFile.get(bp.file) ?? [];
            existing.push(bp);
            byFile.set(bp.file, existing);
          }
          for (const [file, bps] of byFile) {
            const results = await session.setBreakpoints(
              file,
              bps.map((b) => ({
                line: b.line,
                condition: b.condition,
                hitCondition: b.hitCondition,
                logMessage: b.logMessage,
              }))
            );
            breakpointResults.push({ file, breakpoints: results });
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

        const shouldWait =
          waitForStop ?? (shouldStop || expectsConfiguredStop);
        let stateData: Record<string, unknown>;
        if (shouldWait) {
          const startedAt = Date.now();
          const outcome = await session.waitForStopOrTermination(timeout ?? 30000);
          if (outcome.status === "stopped") {
            stateData = (await session.collectState()) as unknown as Record<string, unknown>;
          } else if (outcome.status === "terminated") {
            const { output } = session.getOutput();
            stateData = {
              status: "terminated",
              output: output.map((entry) => entry.text),
            };
          } else {
            stateData = { status: session.state, timedOut: true, elapsedMs: Date.now() - startedAt };
          }
        } else {
          stateData = { status: session.state };
        }

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                { sessionId: id, breakpoints: breakpointResults, ...stateData },
                null,
                2
              ),
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
          transport: z.enum(["stdio", "tcp"]).optional(),
          portMatcher: z.string().optional(),
        })
        .optional()
        .describe("Override adapter config inline"),
    },
    async ({ adapter, port, host, processId, attachConfig, adapterConfig }) => {
      let session: DebugSession | undefined;
      try {
        await registryReady;
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
        // Suppress unhandled rejection: the real `await attachPromise` below
        // will still throw if attach fails.
        attachPromise.catch(() => { /* handled at await */ });
        await session.waitForInitialized(10000);
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
    {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
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
          const outcome = await session.waitForStopOrTermination(waitMs);
          if (outcome.status === "stopped") {
            const state = await session.collectState(threadId, depth ?? 10, variableDepth ?? 1);
            return {
              content: [{ type: "text" as const, text: JSON.stringify(state, null, 2) }],
            };
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
                text: `Error: Session is not stopped (current state: ${session.state}). Expressions can only be evaluated at a stopped frame. Set a breakpoint where you want to inspect (set_breakpoints) and continue to it (step with action 'continue'), then retry.`,
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

        const outcome = await session.waitForStopOrTermination(waitMs);
        if (outcome.status !== "stopped") {
          const elapsed = Date.now() - startTime;
          if (outcome.status === "terminated") {
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
    "Get buffered stdout/stderr and debug adapter output for a session. Pass `since` (the `nextSince` from a previous call) to get only newly-emitted entries — useful for polling logpoint output without re-reading the full buffer.",
    {
      sessionId: z.string().optional().describe("Session ID (omit if only one session is active)"),
      category: z
        .string()
        .optional()
        .describe("Filter by output category: 'stdout', 'stderr', 'console', etc."),
      clear: z.boolean().optional().describe("Clear the output buffer after reading (default: false)"),
      since: z
        .number()
        .optional()
        .describe(
          "Return only entries with seq > since. Pass the `nextSince` value from a prior call to fetch incremental output."
        ),
    },
    {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
    async ({ sessionId, category, clear, since }) => {
      try {
        const session = sessions.resolve(sessionId);
        const result = session.getOutput(category, clear ?? false, since);
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
        // Suppress unhandled rejection: the real `await launchPromise` below
        // will still throw if launch fails.
        launchPromise.catch(() => { /* handled at await */ });
        await newSession.waitForInitialized(10000);

        // Re-apply saved breakpoints
        for (const [file, bps] of savedBreakpoints) {
          await newSession.setBreakpoints(file, bps);
        }

        await newSession.configurationDone();
        await launchPromise;

        const stopOnEntry = launchConfig.stopOnEntry !== false;
        const shouldWait = stopOnEntry || savedBreakpoints.size > 0;
        let stateData: Record<string, unknown>;
        if (shouldWait) {
          const outcome = await newSession.waitForStopOrTermination(30000);
          if (outcome.status === "stopped") {
            stateData = (await newSession.collectState()) as unknown as Record<string, unknown>;
          } else {
            stateData = {
              status: outcome.status === "timeout" ? newSession.state : "terminated",
              timedOut: outcome.status === "timeout",
            };
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
  // 13. debug_inspect
  // ────────────────────────────────────────────────────────────────────────────
  server.tool(
    "debug_inspect",
    "One-shot inspection: launch a program, run to a breakpoint, evaluate a list of expressions in that frame, then disconnect. Collapses launch + wait + evaluate + disconnect into a single call. Use for 'what is X at line N?' debugging.",
    {
      adapter: z.string().describe("Adapter type to use (e.g. 'python', 'node')"),
      program: z.string().describe("Path to the program to debug"),
      args: z.array(z.string()).optional().describe("Program arguments"),
      cwd: z.string().optional().describe("Working directory for the program"),
      env: z.record(z.string(), z.string()).optional().describe("Environment variables"),
      at: z
        .object({
          file: z.string().describe("Absolute path to the source file"),
          line: z.number().describe("Line number (1-based)"),
          condition: z.string().optional().describe("Conditional breakpoint expression"),
          hitCondition: z.string().optional().describe("Hit-count condition (e.g. '5' for 5th hit)"),
        })
        .describe("Breakpoint location to stop at"),
      expressions: z
        .array(z.string())
        .optional()
        .describe("Expressions to evaluate when stopped at the breakpoint. Omit to just verify the line is reached."),
      timeout: z
        .number()
        .optional()
        .describe("Milliseconds to wait for the breakpoint to be hit (default: 30000)"),
      launchConfig: z
        .record(z.string(), z.unknown())
        .optional()
        .describe("Adapter-specific DAP launch fields"),
      adapterConfig: z
        .object({
          type: z.string(),
          program: z.string(),
          runtime: z.string().optional(),
          args: z.array(z.string()).optional(),
          launchDefaults: z.record(z.string(), z.unknown()).optional(),
          installHint: z.string().optional(),
          transport: z.enum(["stdio", "tcp"]).optional(),
          portMatcher: z.string().optional(),
        })
        .optional()
        .describe("Override adapter config inline"),
    },
    async (opts) => {
      try {
        await registryReady;
        const result = await runDebugInspect(registry, sessions, opts);
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
  // 14. list_breakpoints
  // ────────────────────────────────────────────────────────────────────────────
  server.tool(
    "list_breakpoints",
    "List the breakpoints currently registered with a session, grouped by source file. Includes regular breakpoints, conditional breakpoints, and logpoints.",
    {
      sessionId: z.string().optional().describe("Session ID (omit if only one session is active)"),
    },
    {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    async ({ sessionId }) => {
      try {
        const session = sessions.resolve(sessionId);
        const bps = session.getBreakpoints();
        const files = Array.from(bps.entries()).map(([file, breakpoints]) => ({
          file,
          breakpoints,
        }));
        const totalCount = files.reduce((n, f) => n + f.breakpoints.length, 0);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ count: totalCount, files }, null, 2),
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
  // 15. debug_run
  // ────────────────────────────────────────────────────────────────────────────
  server.tool(
    "debug_run",
    "Launch a program with no stops, let it run to completion, and return all stdout/stderr/console output. Optionally inject logpoints (breakpoints with logMessage) for printf-style debugging without modifying source. Use for 'what does this script actually do?' cases where you don't need to inspect intermediate state.",
    {
      adapter: z.string().describe("Adapter type to use (e.g. 'python', 'node')"),
      program: z.string().describe("Path to the program to debug"),
      args: z.array(z.string()).optional().describe("Program arguments"),
      cwd: z.string().optional().describe("Working directory for the program"),
      env: z.record(z.string(), z.string()).optional().describe("Environment variables"),
      logpoints: z
        .array(
          z.object({
            file: z.string().describe("Absolute path to the source file"),
            line: z.number().describe("Line number (1-based)"),
            logMessage: z.string().describe("Message template; expressions in {braces} are evaluated in scope"),
          })
        )
        .optional()
        .describe("Logpoints to emit per-hit messages without pausing execution"),
      timeout: z
        .number()
        .optional()
        .describe("Total wall-clock timeout for the whole run in milliseconds (default: 60000)"),
      adapterConfig: z
        .object({
          type: z.string(),
          program: z.string(),
          runtime: z.string().optional(),
          args: z.array(z.string()).optional(),
          launchDefaults: z.record(z.string(), z.unknown()).optional(),
          installHint: z.string().optional(),
          transport: z.enum(["stdio", "tcp"]).optional(),
          portMatcher: z.string().optional(),
        })
        .optional()
        .describe("Override adapter config inline"),
    },
    async (opts) => {
      try {
        await registryReady;
        const result = await runDebugRun(registry, sessions, opts);
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
