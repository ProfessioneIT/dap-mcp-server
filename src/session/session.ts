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

import { DAPClient } from "../dap/dap-client.js";
import { RingBuffer } from "../dap/ring-buffer.js";
import {
  SessionState,
  StoppedState,
  AdapterConfig,
  OutputEntry,
  BreakpointConfig,
  BreakpointResult,
  Variable,
  CollectStateOptions,
  ExceptionDetails,
} from "../dap/types.js";
import { DebugProtocol } from "@vscode/debugprotocol";
import path from "node:path";

const MAX_OUTPUT_LINES = 10000;
const MAX_STATE_OUTPUT_ENTRIES = 50;
const DEFAULT_TIMEOUT = 30000;

function isRegistersScope(scope: DebugProtocol.Scope): boolean {
  return scope.presentationHint === "registers" || /^registers?$/i.test(scope.name);
}

function isFrameLocalScope(scope: DebugProtocol.Scope): boolean {
  return !scope.expensive && !/^(global|static)/i.test(scope.name);
}

export type SessionWaitOutcome =
  | { status: "stopped"; event: DebugProtocol.StoppedEvent }
  | { status: "terminated" }
  | { status: "timeout" };

export class DebugSession {
  readonly id: string;
  private client: DAPClient;
  private adapterConfig: AdapterConfig;
  private _state: SessionState = "idle";
  private outputBuffer = new RingBuffer<OutputEntry>(MAX_OUTPUT_LINES);
  private nextOutputSeq = 1;
  private lastReportedOutputSeq = 0;
  private breakpointsMap = new Map<string, BreakpointConfig[]>();
  private breakpointResults = new Map<string, BreakpointResult[]>();
  private pendingBreakpointRequests = 0;
  private pendingBreakpointUpdates = new Map<number, DebugProtocol.BreakpointEvent["body"]>();
  private capabilities: DebugProtocol.Capabilities = {};
  private stoppedThreadId?: number;
  private stoppedReason?: string;
  private stoppedDescription?: string;
  private _exitCode?: number;
  private exitCodeResolvers: Array<() => void> = [];
  private launchConfig?: Record<string, unknown>;
  private attachConfig?: Record<string, unknown>;
  private launchMode: "launch" | "attach" = "launch";
  private stoppedResolvers: Array<(event: DebugProtocol.StoppedEvent) => void> = [];
  private initializedResolvers: Array<() => void> = [];
  private terminatedResolvers: Array<() => void> = [];
  private lifecycleResolvers: Array<(outcome: SessionWaitOutcome) => void> = [];
  private _initializedReceived = false;

  constructor(id: string, config: AdapterConfig) {
    this.id = id;
    this.adapterConfig = config;
    const runtime = config.runtime || "";
    const program = config.program;
    const args = config.args || [];
    this.client = new DAPClient(runtime, program, args, {
      transport: config.transport,
      portMatcher: config.portMatcher,
    });

    this.client.on("event", (event: DebugProtocol.Event) => {
      this.handleEvent(event);
    });

    this.client.on("exit", () => {
      if (this._state !== "terminated") {
        this._state = "terminated";
      }
      this.resolveTerminatedWaiters();
      this.resolveLifecycleWaiters({ status: "terminated" });
    });
  }

  private resolveTerminatedWaiters(): void {
    const resolvers = this.terminatedResolvers;
    this.terminatedResolvers = [];
    for (const r of resolvers) r();
  }

  private resolveLifecycleWaiters(outcome: SessionWaitOutcome): void {
    const resolvers = this.lifecycleResolvers;
    this.lifecycleResolvers = [];
    for (const resolve of resolvers) resolve(outcome);
  }

  get state(): SessionState {
    return this._state;
  }

  async initialize(): Promise<DebugProtocol.Capabilities> {
    try {
      await this.client.spawn();
    } catch (err) {
      this._state = "terminated";
      throw err;
    }
    try {
      const response = await this.client.sendRequest("initialize", {
        adapterID: this.adapterConfig.type,
        clientID: "dap-mcp-server",
        clientName: "DAP MCP Server",
        supportsVariableType: true,
        linesStartAt1: true,
        columnsStartAt1: true,
        pathFormat: "path",
      });
      this.capabilities = response.body || {};
      this._state = "configuring";
      // Note: per DAP spec, the "initialized" event signals the adapter is
      // ready for configuration (setBreakpoints, etc.). Different adapters
      // emit it at different times: delve emits it immediately after the
      // initialize response, but debugpy only emits it after `launch` is
      // received. The orchestrator (server.ts) is responsible for waiting
      // for it AFTER firing the launch/attach request — see waitForInitialized.
      return this.capabilities;
    } catch (err) {
      this._state = "terminated";
      throw err;
    }
  }

  async waitForInitialized(timeout = 10000): Promise<void> {
    // If we already received the initialized event, resolve immediately
    if (this._initializedReceived) return;
    return new Promise<void>((resolve) => {
      let settled = false;
      const wrappedResolve = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const idx = this.initializedResolvers.indexOf(wrappedResolve);
        if (idx !== -1) this.initializedResolvers.splice(idx, 1);
        resolve();
      };
      const timer = setTimeout(() => {
        // Don't reject — some adapters never send initialized; just continue
        wrappedResolve();
      }, timeout);
      this.initializedResolvers.push(wrappedResolve);
    });
  }

  async setBreakpoints(
    filePath: string,
    breakpoints: BreakpointConfig[]
  ): Promise<BreakpointResult[]> {
    const absPath = path.resolve(filePath);
    this.breakpointsMap.set(absPath, breakpoints);
    this.pendingBreakpointRequests++;
    try {
      const response = await this.client.sendRequest("setBreakpoints", {
        source: { path: absPath },
        breakpoints: breakpoints.map((bp) => ({
          line: bp.line,
          condition: bp.condition,
          hitCondition: bp.hitCondition,
          logMessage: bp.logMessage,
        })),
      });
      const results = ((response.body?.breakpoints as DebugProtocol.Breakpoint[]) || []).map((bp) => ({
        id: bp.id,
        verified: bp.verified ?? false,
        line: bp.line ?? 0,
        message: bp.message,
      }));
      this.breakpointResults.set(absPath, results);
      // A response and its following event can be parsed synchronously in one
      // chunk, before this await resumes. Replay updates on the new results.
      for (const update of this.pendingBreakpointUpdates.values()) this.applyBreakpointUpdate(update);
      return results;
    } finally {
      this.pendingBreakpointRequests--;
      if (this.pendingBreakpointRequests === 0) this.pendingBreakpointUpdates.clear();
    }
  }

  async setExceptionBreakpoints(filters: string[]): Promise<void> {
    await this.client.sendRequest("setExceptionBreakpoints", { filters });
  }

  async configurationDone(): Promise<void> {
    if (this.capabilities.supportsConfigurationDoneRequest) {
      await this.client.sendRequest("configurationDone");
    }
  }

  async launch(config: Record<string, unknown>): Promise<void> {
    this.launchConfig = config;
    this.launchMode = "launch";
    this._state = "running";
    await this.client.sendRequest("launch", config);
  }

  async attach(config: Record<string, unknown>): Promise<void> {
    this.attachConfig = config;
    this.launchMode = "attach";
    this._state = "running";
    await this.client.sendRequest("attach", config);
  }

  async continueExecution(threadId?: number): Promise<void> {
    const tid = threadId ?? this.stoppedThreadId ?? 1;
    this._state = "running";
    await this.client.sendRequest("continue", { threadId: tid });
  }

  async next(threadId?: number): Promise<void> {
    const tid = threadId ?? this.stoppedThreadId ?? 1;
    this._state = "running";
    await this.client.sendRequest("next", { threadId: tid });
  }

  async stepIn(threadId?: number): Promise<void> {
    const tid = threadId ?? this.stoppedThreadId ?? 1;
    this._state = "running";
    await this.client.sendRequest("stepIn", { threadId: tid });
  }

  async stepOut(threadId?: number): Promise<void> {
    const tid = threadId ?? this.stoppedThreadId ?? 1;
    this._state = "running";
    await this.client.sendRequest("stepOut", { threadId: tid });
  }

  async pause(threadId?: number): Promise<void> {
    const tid = threadId ?? this.stoppedThreadId ?? 1;
    await this.client.sendRequest("pause", { threadId: tid });
  }

  async waitForTerminated(timeout = DEFAULT_TIMEOUT): Promise<void> {
    if (this._state === "terminated") return;
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const wrapped = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const idx = this.terminatedResolvers.indexOf(wrapped);
        if (idx !== -1) this.terminatedResolvers.splice(idx, 1);
        resolve();
      };
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        const idx = this.terminatedResolvers.indexOf(wrapped);
        if (idx !== -1) this.terminatedResolvers.splice(idx, 1);
        reject(new Error("timeout"));
      }, timeout);
      this.terminatedResolvers.push(wrapped);
    });
  }

  async waitForStopped(timeout = DEFAULT_TIMEOUT): Promise<DebugProtocol.StoppedEvent> {
    if (this._state === "stopped") {
      return {
        seq: 0,
        type: "event",
        event: "stopped",
        body: { reason: this.stoppedReason || "unknown", threadId: this.stoppedThreadId },
      } as DebugProtocol.StoppedEvent;
    }
    return new Promise<DebugProtocol.StoppedEvent>((resolve, reject) => {
      let settled = false;
      const wrappedResolve = (event: DebugProtocol.StoppedEvent) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const idx = this.stoppedResolvers.indexOf(wrappedResolve);
        if (idx !== -1) this.stoppedResolvers.splice(idx, 1);
        resolve(event);
      };
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        const idx = this.stoppedResolvers.indexOf(wrappedResolve);
        if (idx !== -1) this.stoppedResolvers.splice(idx, 1);
        reject(new Error("timeout"));
      }, timeout);
      this.stoppedResolvers.push(wrappedResolve);
    });
  }

  /**
   * Wait for the next meaningful lifecycle outcome without racing two promises.
   * Unlike waitForStopped/waitForTerminated, a timeout is returned as data so
   * callers can reliably distinguish a running process from a completed one.
   */
  async waitForStopOrTermination(timeout = DEFAULT_TIMEOUT): Promise<SessionWaitOutcome> {
    if (this._state === "stopped") {
      return {
        status: "stopped",
        event: {
          seq: 0,
          type: "event",
          event: "stopped",
          body: { reason: this.stoppedReason || "unknown", threadId: this.stoppedThreadId },
        } as DebugProtocol.StoppedEvent,
      };
    }
    if (this._state === "terminated") return { status: "terminated" };

    return new Promise<SessionWaitOutcome>((resolve) => {
      let settled = false;
      const wrappedResolve = (outcome: SessionWaitOutcome) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const index = this.lifecycleResolvers.indexOf(wrappedResolve);
        if (index !== -1) this.lifecycleResolvers.splice(index, 1);
        resolve(outcome);
      };
      const timer = setTimeout(() => wrappedResolve({ status: "timeout" }), timeout);
      this.lifecycleResolvers.push(wrappedResolve);
    });
  }

  get exitCode(): number | undefined {
    return this._exitCode;
  }

  /**
   * The debuggee's exit code, if the adapter reports one. Adapters disagree on
   * whether `exited` precedes or trails `terminated`, so callers that have just
   * seen termination give it a short grace period.
   */
  async waitForExitCode(timeout = 250): Promise<number | undefined> {
    if (this._exitCode !== undefined) return this._exitCode;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(done, timeout);
      const resolvers = this.exitCodeResolvers;
      function done() {
        clearTimeout(timer);
        const idx = resolvers.indexOf(done);
        if (idx !== -1) resolvers.splice(idx, 1);
        resolve();
      }
      resolvers.push(done);
    });
    return this._exitCode;
  }

  async getThreads(): Promise<DebugProtocol.Thread[]> {
    const response = await this.client.sendRequest("threads");
    return (response.body?.threads as DebugProtocol.Thread[]) || [];
  }

  async getStackTrace(threadId: number, depth = 10): Promise<DebugProtocol.StackFrame[]> {
    const response = await this.client.sendRequest("stackTrace", {
      threadId,
      startFrame: 0,
      levels: depth,
    });
    return (response.body?.stackFrames as DebugProtocol.StackFrame[]) || [];
  }

  async getScopes(frameId: number): Promise<DebugProtocol.Scope[]> {
    const response = await this.client.sendRequest("scopes", { frameId });
    return (response.body?.scopes as DebugProtocol.Scope[]) || [];
  }

  async getVariables(
    variablesReference: number,
    depth = 1
  ): Promise<Variable[]> {
    const response = await this.client.sendRequest("variables", { variablesReference });
    const vars: Variable[] = ((response.body?.variables as DebugProtocol.Variable[]) || []).map((v) => ({
      name: v.name,
      value: v.value,
      type: v.type,
      hasChildren: (v.variablesReference ?? 0) > 0,
      variablesReference: v.variablesReference ?? 0,
    }));
    if (depth > 1) {
      for (const v of vars) {
        if (v.hasChildren) {
          v.children = await this.getVariables(v.variablesReference, depth - 1);
        }
      }
    }
    return vars;
  }

  async evaluate(
    expression: string,
    frameId?: number,
    context: "repl" | "watch" | "hover" = "repl"
  ): Promise<{
    result: string;
    type?: string;
    hasChildren: boolean;
    variablesReference: number;
  }> {
    let resolvedFrameId = frameId;
    if (resolvedFrameId === undefined && this._state === "stopped") {
      const frames = await this.getStackTrace(this.stoppedThreadId ?? 1, 1);
      resolvedFrameId = frames[0]?.id;
    }
    const args: Record<string, unknown> = { expression, context };
    if (resolvedFrameId !== undefined) args.frameId = resolvedFrameId;
    const response = await this.client.sendRequest("evaluate", args);
    return {
      result: (response.body?.result as string) ?? "",
      type: response.body?.type as string | undefined,
      hasChildren: ((response.body?.variablesReference as number) ?? 0) > 0,
      variablesReference: (response.body?.variablesReference as number) ?? 0,
    };
  }

  private async getExceptionDetails(threadId: number): Promise<ExceptionDetails | undefined> {
    if (this.capabilities.supportsExceptionInfoRequest) {
      try {
        const response = await this.client.sendRequest("exceptionInfo", { threadId });
        const body = response.body as DebugProtocol.ExceptionInfoResponse["body"] | undefined;
        if (body) {
          return {
            id: body.exceptionId,
            description: body.description ?? body.details?.message,
            breakMode: body.breakMode,
          };
        }
      } catch {
        /* Fall back to what the stopped event said */
      }
    }
    return this.stoppedDescription ? { description: this.stoppedDescription } : undefined;
  }

  /**
   * Output no earlier state has reported yet, capped to the newest entries.
   * The full buffer always stays available through getOutput().
   */
  unreportedOutput(consume: boolean): { output?: string[]; outputOmitted?: number } {
    const since = this.lastReportedOutputSeq;
    const entries = this.outputBuffer.getFiltered((e) => e.seq > since);
    if (consume && entries.length > 0) {
      this.lastReportedOutputSeq = entries[entries.length - 1].seq;
    }
    if (entries.length === 0) return {};
    const omitted = Math.max(0, entries.length - MAX_STATE_OUTPUT_ENTRIES);
    return {
      output: entries.slice(omitted).map((e) => e.text),
      outputOmitted: omitted > 0 ? omitted : undefined,
    };
  }

  async collectState(
    threadId?: number,
    depth = 10,
    variableDepth = 1,
    options: CollectStateOptions = {}
  ): Promise<StoppedState> {
    const tid = threadId ?? this.stoppedThreadId ?? 1;
    const threads = await this.getThreads();
    const frames = await this.getStackTrace(tid, depth);
    const topFrame = frames[0];
    const location = topFrame
      ? {
          file: topFrame.source?.path || topFrame.source?.name || "<unknown>",
          line: topFrame.line,
          column: topFrame.column,
          functionName: topFrame.name,
        }
      : { file: "<unknown>", line: 0 };

    const scopes: StoppedState["scopes"] = [];
    const omittedScopes: string[] = [];
    if (topFrame) {
      const requested = options.scopes?.map((name) => name.toLowerCase());
      const rawScopes = await this.getScopes(topFrame.id);
      for (const scope of rawScopes) {
        const wanted = requested
          ? requested.includes(scope.name.toLowerCase())
          : !isRegistersScope(scope) && (!options.localsOnly || isFrameLocalScope(scope));
        if (!wanted) {
          omittedScopes.push(scope.name);
          continue;
        }
        const variables = await this.getVariables(scope.variablesReference, variableDepth);
        scopes.push({ name: scope.name, variables });
      }
    }
    const reason = this.stoppedReason || "unknown";
    const exception = reason === "exception" ? await this.getExceptionDetails(tid) : undefined;
    return {
      status: "stopped",
      reason,
      exception,
      location,
      threads: threads.map((t) => ({ id: t.id, name: t.name, stopped: t.id === tid })),
      stackTrace: frames.map((f) => ({
        id: f.id,
        name: f.name,
        file: f.source?.path || f.source?.name || "<unknown>",
        line: f.line,
        column: f.column,
      })),
      scopes,
      omittedScopes: omittedScopes.length > 0 ? omittedScopes : undefined,
      ...this.unreportedOutput(options.consumeOutput ?? false),
    };
  }

  addOutput(category: string, text: string): void {
    this.outputBuffer.push({
      seq: this.nextOutputSeq++,
      category,
      text,
      timestamp: new Date().toISOString(),
    });
  }

  getOutput(
    category?: string,
    clear = false,
    since?: number
  ): { output: OutputEntry[]; truncated: boolean; nextSince: number } {
    const matches = (e: OutputEntry): boolean => {
      if (category && e.category !== category) return false;
      if (since !== undefined && e.seq <= since) return false;
      return true;
    };
    const entries =
      category !== undefined || since !== undefined
        ? this.outputBuffer.getFiltered(matches)
        : this.outputBuffer.getAll();
    const truncated = this.outputBuffer.truncated;
    if (clear) {
      if (category) {
        this.outputBuffer.removeMatching((e) => e.category === category);
      } else {
        this.outputBuffer.clear();
      }
    }
    const lastInResult = entries.length > 0 ? entries[entries.length - 1].seq : undefined;
    const nextSince = lastInResult ?? since ?? this.nextOutputSeq - 1;
    return { output: entries, truncated, nextSince };
  }

  async disconnect(terminateDebuggee?: boolean): Promise<void> {
    const terminate = terminateDebuggee ?? this.launchMode === "launch";
    try {
      await this.client.sendRequest("disconnect", { terminateDebuggee: terminate }, 5000);
    } catch {
      /* Ignore — adapter may have already exited */
    }
    this._state = "terminated";
    this.resolveTerminatedWaiters();
    this.resolveLifecycleWaiters({ status: "terminated" });
    await this.client.dispose();
  }

  getLaunchConfig(): Record<string, unknown> | undefined {
    // Only returns a value for launched sessions, not attached
    if (this.launchMode === "attach") return undefined;
    return this.launchConfig;
  }

  getAttachConfig(): Record<string, unknown> | undefined {
    return this.attachConfig;
  }

  getLaunchMode(): "launch" | "attach" {
    return this.launchMode;
  }

  getAdapterConfig(): AdapterConfig {
    return this.adapterConfig;
  }

  getBreakpoints(): Map<string, BreakpointConfig[]> {
    return this.breakpointsMap;
  }

  getBreakpointResults(): Map<string, BreakpointResult[]> {
    return this.breakpointResults;
  }

  private applyBreakpointUpdate(body: DebugProtocol.BreakpointEvent["body"]): void {
    const breakpoint = body.breakpoint;
    // DAP IDs identify breakpoints across the session. A reported source can
    // be canonicalized or remapped and must not veto a matching ID.
    for (const values of this.breakpointResults.values()) {
      const existing = values.find((value) => value.id === breakpoint.id);
      if (!existing) continue;
      existing.verified = body.reason === "removed" ? false : breakpoint.verified;
      if (breakpoint.line !== undefined) existing.line = breakpoint.line;
      existing.message = breakpoint.message;
      break;
    }
  }

  private handleEvent(event: DebugProtocol.Event): void {
    switch (event.event) {
      case "breakpoint": {
        const body = event.body as DebugProtocol.BreakpointEvent["body"] | undefined;
        const breakpoint = body?.breakpoint;
        if (!body || typeof breakpoint?.id !== "number") break;
        if (this.pendingBreakpointRequests > 0) this.pendingBreakpointUpdates.set(breakpoint.id, body);
        this.applyBreakpointUpdate(body);
        break;
      }
      case "initialized":
        this._initializedReceived = true;
        for (const resolve of this.initializedResolvers) resolve();
        this.initializedResolvers = [];
        break;
      case "stopped":
        this._state = "stopped";
        this.stoppedThreadId = event.body?.threadId as number | undefined;
        this.stoppedReason = event.body?.reason as string | undefined;
        this.stoppedDescription = (event.body?.text ?? event.body?.description) as string | undefined;
        {
          const resolvers = this.stoppedResolvers;
          this.stoppedResolvers = [];
          for (const resolve of resolvers) resolve(event as DebugProtocol.StoppedEvent);
        }
        this.resolveLifecycleWaiters({
          status: "stopped",
          event: event as DebugProtocol.StoppedEvent,
        });
        break;
      case "continued":
        this._state = "running";
        break;
      case "output":
        if (event.body?.output)
          this.addOutput(
            (event.body.category as string) || "console",
            event.body.output as string
          );
        break;
      case "terminated":
      case "exited":
        if (event.event === "exited" && typeof event.body?.exitCode === "number") {
          this._exitCode = event.body.exitCode;
          for (const resolve of [...this.exitCodeResolvers]) resolve();
        }
        this._state = "terminated";
        this.resolveTerminatedWaiters();
        this.resolveLifecycleWaiters({ status: "terminated" });
        break;
    }
  }
}
