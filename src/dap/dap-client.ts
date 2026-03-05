import { spawn, ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
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

export class DAPClient extends EventEmitter {
  private runtime: string;
  private executable: string;
  private args: string[];
  private process?: ChildProcess;
  private parser?: MessageParser;
  private seq = 1;
  private pending = new Map<number, PendingRequest>();
  private stderrOutput: string[] = [];
  private _exited = false;
  private _exitCode?: number;

  constructor(runtime: string, executable: string, args: string[] = []) {
    super();
    this.runtime = runtime;
    this.executable = executable;
    this.args = args;
  }

  async spawn(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const runtimeArgs = this.runtime
        ? [this.executable, ...this.args]
        : this.args;
      const cmd = this.runtime || this.executable;

      this.process = spawn(cmd, runtimeArgs, {
        stdio: ["pipe", "pipe", "pipe"],
      });

      this.parser = new MessageParser((msg) => this.handleMessage(msg));

      this.process.stdout!.on("data", (data: Buffer) => {
        this.parser!.feed(data);
      });

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
        for (const [, req] of this.pending) {
          if (req.timer) clearTimeout(req.timer);
          req.reject(
            new DAPClientError(
              `Adapter exited (code=${code}, signal=${signal}). stderr: ${this.stderrOutput.join("")}`
            )
          );
        }
        this.pending.clear();
        this.emit("exit", code, signal);
      });

      // Resolve once the process is spawned
      this.process.stdout!.once("readable", () => resolve());
      setTimeout(() => resolve(), 100);
    });
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
    if (!this.process?.stdin?.writable) {
      throw new DAPClientError("Adapter stdin is not writable");
    }

    const seq = this.seq++;
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
          this.pending.delete(seq);
          reject(new DAPClientError(`Request '${command}' timeout after ${timeout}ms`));
        }, timeout);
      }
      this.pending.set(seq, pending);
      try {
        this.process!.stdin!.write(encodeMessage(request), (err) => {
          if (err) {
            // Write failed (e.g. EPIPE); clean up and reject
            const p = this.pending.get(seq);
            if (p) {
              if (p.timer) clearTimeout(p.timer);
              this.pending.delete(seq);
              p.reject(new DAPClientError(`Write to adapter failed: ${err.message}`));
            }
          }
        });
      } catch (err) {
        this.pending.delete(seq);
        if (pending.timer) clearTimeout(pending.timer);
        reject(new DAPClientError(`Write to adapter failed: ${(err as Error).message}`));
      }
    });
  }

  private handleMessage(msg: DebugProtocol.ProtocolMessage): void {
    if (msg.type === "response") {
      const response = msg as DebugProtocol.Response;
      const pending = this.pending.get(response.request_seq);
      if (pending) {
        if (pending.timer) clearTimeout(pending.timer);
        this.pending.delete(response.request_seq);
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
    } else if (msg.type === "event") {
      const event = msg as DebugProtocol.Event;
      this.emit(event.event, event);
      this.emit("event", event);
    }
  }

  get exited(): boolean {
    return this._exited;
  }

  get stderr(): string {
    return this.stderrOutput.join("");
  }

  async dispose(): Promise<void> {
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
