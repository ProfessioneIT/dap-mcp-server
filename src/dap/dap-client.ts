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

import { spawn, ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { Socket, createConnection } from "node:net";
import type { Writable } from "node:stream";
import { DebugProtocol } from "@vscode/debugprotocol";
import { encodeMessage, MessageParser } from "./protocol.js";

export class DAPClientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DAPClientError";
  }
}

interface PendingRequest {
  resolve: (response: DebugProtocol.Response) => void;
  reject: (error: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
}

/**
 * One DAP transport connection. Multiple connections can exist when a
 * "parent" session (e.g. vscode-js-debug) spawns child sessions via the
 * `startDebugging` reverse request. Each connection has its own request
 * sequence counter and pending-request map; reading is via its parser.
 */
interface Conn {
  /** "parent" = the initial connection. "child" = spawned via startDebugging. */
  kind: "parent" | "child";
  /** DAP-message-framed write target. For stdio, the child stdin; for tcp, the socket. */
  writeStream: Writable;
  parser: MessageParser;
  pending: Map<number, PendingRequest>;
  seq: number;
  /** Present only for TCP connections. */
  socket?: Socket;
  /** True once the underlying transport is closed. */
  closed: boolean;
}

export interface DAPClientOptions {
  /** "stdio" (default) or "tcp". */
  transport?: "stdio" | "tcp";
  /**
   * Regex with one capture group that matches the TCP port the adapter is
   * listening on. Required when transport is "tcp". The regex is applied to
   * the cumulative adapter stdout text.
   */
  portMatcher?: string;
  /** Timeout waiting for the adapter to announce its TCP port, in ms. */
  tcpConnectTimeout?: number;
}

export class DAPClient extends EventEmitter {
  private runtime: string;
  private executable: string;
  private args: string[];
  private transport: "stdio" | "tcp";
  private portMatcher?: RegExp;
  private tcpConnectTimeout: number;
  private process?: ChildProcess;
  private conns: Conn[] = [];
  /** Index into `conns` of the connection that handles user-sent requests. */
  private activeIdx = -1;
  /** TCP target host (set during spawn for tcp mode). */
  private tcpHost?: string;
  /** TCP target port (set during spawn for tcp mode). */
  private tcpPort?: number;
  /**
   * While a startDebugging handler is bootstrapping a new child session
   * (initialize + launch), user-issued `sendRequest` calls await this so they
   * don't race the in-progress handshake.
   */
  private transitionLock?: Promise<void>;
  /**
   * Last setBreakpoints arguments per source path. Replayed onto new child
   * sessions when startDebugging causes the active connection to change —
   * adapters like vscode-js-debug spawn a child for the actual debuggee
   * AFTER the parent has accepted setBreakpoints, so the child wouldn't know
   * about them otherwise.
   */
  private bpHistory: Map<string, Record<string, unknown>> = new Map();
  private excBpHistory?: Record<string, unknown>;
  private configurationDoneSent = false;
  private stderrOutput: string[] = [];
  private stdoutPreamble = "";
  private _exited = false;
  private _exitCode?: number;

  constructor(
    runtime: string,
    executable: string,
    args: string[] = [],
    options: DAPClientOptions = {}
  ) {
    super();
    this.runtime = runtime;
    this.executable = executable;
    this.args = args;
    this.transport = options.transport ?? "stdio";
    if (this.transport === "tcp") {
      if (!options.portMatcher) {
        throw new DAPClientError(
          "portMatcher is required when transport is 'tcp'"
        );
      }
      this.portMatcher = new RegExp(options.portMatcher);
    }
    this.tcpConnectTimeout = options.tcpConnectTimeout ?? 10000;
  }

  async spawn(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const runtimeArgs = this.runtime
        ? [this.executable, ...this.args]
        : this.args;
      const cmd = this.runtime || this.executable;

      this.process = spawn(cmd, runtimeArgs, {
        stdio: ["pipe", "pipe", "pipe"],
        detached: true,
      });

      // Detached child must be unref'd so the parent Node process can exit
      // even if the adapter is still running (cleanup happens via dispose()).
      this.process.unref();

      this.process.stderr!.on("data", (data: Buffer) => {
        this.stderrOutput.push(data.toString());
      });

      // Suppress EPIPE and other stream errors on stdin; the exit handler handles cleanup
      this.process.stdin!.on("error", () => {
        // ignore — exit event will reject pending requests
      });

      this.process.on("error", (err) => {
        reject(new DAPClientError(`Failed to spawn adapter: ${err.message}`));
      });

      this.process.on("exit", (code, signal) => {
        this._exited = true;
        this._exitCode = code ?? undefined;
        // Reject pending across all connections.
        for (const conn of this.conns) {
          for (const [, req] of conn.pending) {
            if (req.timer) clearTimeout(req.timer);
            req.reject(
              new DAPClientError(
                `Adapter exited (code=${code}, signal=${signal}). stderr: ${this.stderrOutput.join("")}`
              )
            );
          }
          conn.pending.clear();
        }
        this.emit("exit", code, signal);
      });

      if (this.transport === "stdio") {
        // DAP messages flow over the adapter's stdin/stdout. Single connection
        // (no startDebugging support over stdio).
        const conn = this.makeConn("parent", this.process.stdin!, this.process.stdout!);
        this.conns.push(conn);
        this.activeIdx = 0;
        // Resolve once the process is spawned (use flag to prevent double-resolve)
        let resolved = false;
        this.process.stdout!.once("readable", () => {
          if (!resolved) { resolved = true; resolve(); }
        });
        setTimeout(() => {
          if (!resolved) { resolved = true; resolve(); }
        }, 100);
      } else {
        // TCP transport: read the adapter's stdout banner to discover the
        // port, then connect via TCP and route DAP messages over the socket.
        let portFound = false;
        const connectTimer = setTimeout(() => {
          if (!portFound) {
            reject(
              new DAPClientError(
                `Timed out waiting for adapter to announce TCP port. ` +
                `Pattern: ${this.portMatcher!.source}. ` +
                `Stdout so far: ${this.stdoutPreamble.slice(0, 500)}`
              )
            );
          }
        }, this.tcpConnectTimeout);

        this.process.stdout!.on("data", (data: Buffer) => {
          this.stdoutPreamble += data.toString();
          if (portFound) return;
          const m = this.portMatcher!.exec(this.stdoutPreamble);
          if (m) {
            portFound = true;
            clearTimeout(connectTimer);
            const port = Number(m[1]);
            if (!Number.isFinite(port) || port <= 0) {
              reject(
                new DAPClientError(
                  `Invalid port matched from adapter stdout: '${m[1]}'`
                )
              );
              return;
            }
            this.tcpHost = "127.0.0.1";
            this.tcpPort = port;
            this.openTcpConnection("parent")
              .then((conn) => {
                this.conns.push(conn);
                this.activeIdx = 0;
                resolve();
              })
              .catch(reject);
          }
        });
      }
    });
  }

  /**
   * Record session-shaping requests so we can replay them on child sessions.
   * `setBreakpoints` and `setExceptionBreakpoints` need to be re-sent because
   * each DAP session has its own breakpoint state. `configurationDone` is
   * tracked so we know whether the parent has already finished its
   * configuration phase — if so, child sessions need the same signal.
   */
  private trackOutgoing(command: string, args: Record<string, unknown> | undefined): void {
    if (command === "setBreakpoints" && args) {
      const src = (args.source as { path?: string } | undefined)?.path;
      if (src) {
        this.bpHistory.set(src, args);
      }
    } else if (command === "setExceptionBreakpoints" && args) {
      this.excBpHistory = args;
    } else if (command === "configurationDone") {
      this.configurationDoneSent = true;
    }
  }

  /** Build a Conn around a writable/readable stream pair. */
  private makeConn(kind: "parent" | "child", writeStream: Writable, dataStream: NodeJS.ReadableStream): Conn {
    const conn: Conn = {
      kind,
      writeStream,
      parser: new MessageParser((msg) => this.handleMessage(msg, conn)),
      pending: new Map(),
      seq: 1,
      closed: false,
    };
    dataStream.on("data", (data: Buffer) => conn.parser.feed(data));
    return conn;
  }

  /** Open a fresh TCP connection to the adapter's DAP server. */
  private openTcpConnection(kind: "parent" | "child"): Promise<Conn> {
    return new Promise<Conn>((resolve, reject) => {
      if (this.tcpHost === undefined || this.tcpPort === undefined) {
        reject(new DAPClientError("TCP target host/port not set"));
        return;
      }
      const sock = createConnection({ host: this.tcpHost, port: this.tcpPort }, () => {
        const conn = this.makeConn(kind, sock, sock);
        conn.socket = sock;
        sock.on("close", () => this.onConnClose(conn));
        sock.on("error", (err) => {
          this.stderrOutput.push(`socket error (${kind}): ${err.message}\n`);
        });
        resolve(conn);
      });
      sock.once("error", (err) => {
        reject(
          new DAPClientError(
            `Failed to connect to adapter TCP port ${this.tcpPort}: ${err.message}`
          )
        );
      });
    });
  }

  private onConnClose(conn: Conn): void {
    if (conn.closed) return;
    conn.closed = true;
    for (const [, req] of conn.pending) {
      if (req.timer) clearTimeout(req.timer);
      req.reject(
        new DAPClientError(
          `DAP ${conn.kind} connection closed before response. stderr: ${this.stderrOutput.join("")}`
        )
      );
    }
    conn.pending.clear();
    // If the active connection just closed, fall back to the most recent
    // non-closed one. If none remain, leave activeIdx pointing at the closed
    // conn — sendRequest will fail with "transport is not writable".
    if (this.conns[this.activeIdx] === conn) {
      for (let i = this.conns.length - 1; i >= 0; i--) {
        if (!this.conns[i].closed) {
          this.activeIdx = i;
          break;
        }
      }
    }
  }

  async sendRequest(
    command: string,
    args?: Record<string, unknown>,
    timeout = 10000
  ): Promise<DebugProtocol.Response> {
    if (this._exited) {
      throw new DAPClientError(
        `Adapter has exited (code=${this._exitCode}). stderr: ${this.stderrOutput.join("")}`
      );
    }
    // Wait for any in-progress session transition (e.g. handleStartDebugging
    // setting up a child session) before sending. Otherwise the request would
    // race the handshake or land on a half-initialized child connection.
    if (this.transitionLock) {
      await this.transitionLock;
    }
    return this.sendRequestOn(this.conns[this.activeIdx], command, args, timeout);
  }

  /** Internal: send a request on a specific connection. */
  private sendRequestOn(
    conn: Conn | undefined,
    command: string,
    args: Record<string, unknown> | undefined,
    timeout: number
  ): Promise<DebugProtocol.Response> {
    if (!conn || conn.closed || !conn.writeStream.writable) {
      throw new DAPClientError("Adapter transport is not writable");
    }
    this.trackOutgoing(command, args);
    const seq = conn.seq++;
    const request: DebugProtocol.Request = {
      seq,
      type: "request",
      command,
      arguments: args,
    };
    return new Promise<DebugProtocol.Response>((resolve, reject) => {
      const pending: PendingRequest = { resolve, reject };
      if (timeout > 0) {
        pending.timer = setTimeout(() => {
          conn.pending.delete(seq);
          reject(new DAPClientError(`Request '${command}' timeout after ${timeout}ms`));
        }, timeout);
      }
      conn.pending.set(seq, pending);
      try {
        conn.writeStream.write(encodeMessage(request), (err) => {
          if (err) {
            const p = conn.pending.get(seq);
            if (p) {
              if (p.timer) clearTimeout(p.timer);
              conn.pending.delete(seq);
              p.reject(new DAPClientError(`Write to adapter failed: ${err.message}`));
            }
          }
        });
      } catch (err) {
        conn.pending.delete(seq);
        if (pending.timer) clearTimeout(pending.timer);
        reject(new DAPClientError(`Write to adapter failed: ${(err as Error).message}`));
      }
    });
  }

  private handleMessage(msg: DebugProtocol.ProtocolMessage, conn: Conn): void {
    if (msg.type === "response") {
      const response = msg as DebugProtocol.Response;
      const pending = conn.pending.get(response.request_seq);
      if (pending) {
        if (pending.timer) clearTimeout(pending.timer);
        conn.pending.delete(response.request_seq);
        if (response.success) {
          pending.resolve(response);
        } else {
          pending.reject(
            new DAPClientError(
              `DAP error on '${response.command}': ${response.message || "unknown error"}`
            )
          );
        }
      }
    } else if (msg.type === "request") {
      const req = msg as DebugProtocol.Request;
      if (req.command === "startDebugging" && this.transport === "tcp") {
        // The active session is asking us to open a child session for a
        // newly-spawned target (vscode-js-debug does this for every node
        // process it attaches to). Handle natively rather than rejecting.
        this.handleStartDebugging(req, conn).catch((err) => {
          this.stderrOutput.push(`startDebugging handler failed: ${(err as Error).message}\n`);
        });
        return;
      }
      // Reject other reverse requests — the MCP server has no terminal etc.
      this.replyToReverseRequest(conn, req, {
        success: false,
        message: `Reverse request '${req.command}' is not supported by this client`,
      });
    } else if (msg.type === "event") {
      const event = msg as DebugProtocol.Event;
      this.emit(event.event, event);
      this.emit("event", event);
    }
  }

  /** Reply to a reverse request, on the connection that sent it. */
  private replyToReverseRequest(
    conn: Conn,
    req: DebugProtocol.Request,
    result: { success: boolean; message?: string; body?: Record<string, unknown> }
  ): void {
    const response: DebugProtocol.Response = {
      seq: conn.seq++,
      type: "response",
      request_seq: req.seq,
      command: req.command,
      success: result.success,
      message: result.message,
      body: result.body,
    };
    try {
      conn.writeStream.write(encodeMessage(response));
    } catch {
      // ignore — transport may have closed
    }
  }

  /**
   * Handle a `startDebugging` reverse request from an active session.
   *
   * Per the DAP startDebugging protocol, the client should open a new DAP
   * session for the supplied configuration and run the launch/attach
   * handshake against the SAME adapter. For TCP-server adapters like
   * vscode-js-debug, we open a fresh TCP connection to the same port, run
   * initialize + launch (or attach) using the request's configuration, and
   * make that new connection the active one for subsequent user requests.
   *
   * The `transitionLock` prevents user `sendRequest` calls from racing the
   * handshake.
   */
  private async handleStartDebugging(req: DebugProtocol.Request, fromConn: Conn): Promise<void> {
    let resolveLock: (() => void) | undefined;
    this.transitionLock = new Promise<void>((r) => { resolveLock = r; });
    try {
      const argsObj = (req.arguments ?? {}) as {
        configuration?: Record<string, unknown>;
        request?: "launch" | "attach";
      };
      const childConfig = argsObj.configuration ?? {};
      const childRequest = argsObj.request ?? "launch";

      const childConn = await this.openTcpConnection("child");
      this.conns.push(childConn);
      const newIdx = this.conns.length - 1;
      // Make it active so the silent handshake calls below go to the child.
      this.activeIdx = newIdx;

      // Run initialize on the child. The adapterID is taken from the supplied
      // configuration when present (vscode-js-debug uses "pwa-node").
      await this.sendRequestOn(
        childConn,
        "initialize",
        {
          adapterID: (childConfig.type as string | undefined) ?? "child",
          clientID: "dap-mcp-server",
          clientName: "DAP MCP Server",
          linesStartAt1: true,
          columnsStartAt1: true,
          pathFormat: "path",
        },
        10000
      );

      // Run launch/attach with the provided configuration. The configuration
      // typically carries adapter-specific fields like __pendingTargetId that
      // bind the new session to a specific target. Fire-and-forget — the
      // adapter blocks the response until configurationDone, which we issue
      // ourselves below after replaying breakpoints.
      const childLaunchPromise = this.sendRequestOn(
        childConn,
        childRequest,
        childConfig,
        30000
      );
      childLaunchPromise.catch(() => { /* nothing awaits this directly */ });

      // Replay configuration state established on the previous active
      // connection so the new child session honors the same breakpoints.
      // Without this, vscode-js-debug-style adapters (where the parent
      // accepts setBreakpoints but the child is what actually runs the
      // debuggee) would never pause at user-set breakpoints.
      for (const args of this.bpHistory.values()) {
        try {
          await this.sendRequestOn(childConn, "setBreakpoints", args, 10000);
        } catch {
          // Best-effort replay — keep going.
        }
      }
      if (this.excBpHistory) {
        try {
          await this.sendRequestOn(
            childConn,
            "setExceptionBreakpoints",
            this.excBpHistory,
            10000
          );
        } catch {
          // ignore
        }
      }
      if (this.configurationDoneSent) {
        try {
          await this.sendRequestOn(childConn, "configurationDone", undefined, 10000);
        } catch {
          // ignore
        }
      }

      // Acknowledge the reverse request so the parent can proceed.
      this.replyToReverseRequest(fromConn, req, { success: true });
    } catch (err) {
      this.replyToReverseRequest(fromConn, req, {
        success: false,
        message: `Failed to start child debug session: ${(err as Error).message}`,
      });
    } finally {
      resolveLock?.();
      this.transitionLock = undefined;
    }
  }

  get exited(): boolean {
    return this._exited;
  }

  get stderr(): string {
    return this.stderrOutput.join("");
  }

  async dispose(): Promise<void> {
    for (const conn of this.conns) {
      if (conn.socket && !conn.socket.destroyed) {
        try { conn.socket.destroy(); } catch { /* ignore */ }
      }
    }
    if (this.process && !this._exited) {
      this.process.stdin?.end();
      this.process.kill("SIGTERM");
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          this.process?.kill("SIGKILL");
          resolve();
        }, 3000);
        this.process!.on("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    this.removeAllListeners();
  }
}
