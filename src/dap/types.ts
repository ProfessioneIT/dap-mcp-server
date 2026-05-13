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

// src/dap/types.ts

export type SessionState = "idle" | "configuring" | "running" | "stopped" | "terminated";

export interface Variable {
  name: string;
  value: string;
  type?: string;
  hasChildren: boolean;
  variablesReference: number;
  /** Populated when getVariables is called with depth > 1 and this variable has children. */
  children?: Variable[];
}

export interface StoppedState {
  status: "stopped";
  reason: string;
  location: {
    file: string;
    line: number;
    column?: number;
    functionName?: string;
  };
  threads: Array<{ id: number; name: string; stopped: boolean }>;
  stackTrace: Array<{
    id: number;
    name: string;
    file: string;
    line: number;
    column?: number;
  }>;
  scopes: Array<{
    name: string;
    variables: Variable[];
  }>;
  output?: string[];
}

export interface RunningState {
  status: "running";
  output?: string[];
  elapsedMs?: number;
}

export type DebugState = StoppedState | RunningState;

export interface AdapterConfig {
  type: string;
  runtime?: string;
  program: string;
  args?: string[];
  launchDefaults?: Record<string, unknown>;
  installHint?: string;
  /**
   * Transport mode for the adapter:
   * - "stdio" (default): DAP messages flow over the adapter's stdin/stdout.
   * - "tcp": the adapter is a TCP DAP server. After spawning, the client reads
   *   the listening address from the adapter's stdout (matched with
   *   `portMatcher`) and connects to it via a TCP socket. DAP messages then
   *   flow over that socket. Use this for adapters like `dlv dap` or
   *   vscode-js-debug's `dapDebugServer.js` that don't speak DAP on stdio.
   */
  transport?: "stdio" | "tcp";
  /**
   * Regular expression with a single capture group that yields the TCP port the
   * adapter is listening on. Matched against the adapter's stdout output.
   * Required (and only used) when `transport` is "tcp".
   * Example for delve: "DAP server listening at:\\s*\\S+:(\\d+)"
   */
  portMatcher?: string;
}

export interface OutputEntry {
  /** Monotonic per-session sequence number assigned at push time. Survives ring-buffer eviction. */
  seq: number;
  category: string;
  text: string;
  timestamp: string;
}

export interface BreakpointConfig {
  line: number;
  condition?: string;
  hitCondition?: string;
  logMessage?: string;
}

export interface BreakpointResult {
  id?: number;
  verified: boolean;
  line: number;
  message?: string;
}
