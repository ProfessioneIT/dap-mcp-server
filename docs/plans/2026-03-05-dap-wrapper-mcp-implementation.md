# DAP Wrapper MCP Server — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build an MCP server that wraps the Debug Adapter Protocol, enabling AI agents to use real debuggers via coarse-grained MCP tools.

**Architecture:** MCP server (stdio transport) manages debug sessions. Each session spawns a DAP-compliant debug adapter as a child process (stdin/stdout). A custom DAP client handles Content-Length framing and request/response correlation. The session layer adds state tracking, output buffering, and composite state collection.

**Tech Stack:** TypeScript, Node.js, `@modelcontextprotocol/sdk` + `zod` (MCP server), `@vscode/debugprotocol` (DAP types), `vitest` (testing)

---

## Task 1: Project Scaffolding

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `src/index.ts` (empty entry point)

**Step 1: Create package.json**

```json
{
  "name": "dap-mcp-server",
  "version": "0.1.0",
  "description": "MCP server wrapping the Debug Adapter Protocol for AI-driven debugging",
  "type": "module",
  "main": "build/index.js",
  "bin": {
    "dap-mcp-server": "build/index.js"
  },
  "scripts": {
    "build": "tsc",
    "dev": "tsc --watch",
    "test": "vitest run",
    "test:watch": "vitest",
    "start": "node build/index.js"
  },
  "license": "MIT"
}
```

**Step 2: Create tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "Node16",
    "moduleResolution": "Node16",
    "outDir": "./build",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "declaration": true,
    "sourceMap": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "build", "**/*.test.ts"]
}
```

**Step 3: Create .gitignore**

```
node_modules/
build/
.dap-mcp/
```

**Step 4: Install dependencies**

Run:
```bash
npm install @modelcontextprotocol/sdk zod @vscode/debugprotocol
npm install -D typescript @types/node vitest
```

**Step 5: Create empty entry point**

Create `src/index.ts`:
```typescript
#!/usr/bin/env node
console.error("dap-mcp-server starting...");
```

**Step 6: Verify build**

Run: `npx tsc --noEmit`
Expected: no errors

**Step 7: Commit**

```bash
git add package.json tsconfig.json .gitignore src/index.ts package-lock.json
git commit -m "feat: project scaffolding with dependencies"
```

---

## Task 2: DAP Protocol Types

**Files:**
- Create: `src/dap/types.ts`

**Step 1: Create shared types used across the project**

These are our internal types — not duplicating `@vscode/debugprotocol` but defining the shapes our MCP tools return.

```typescript
// src/dap/types.ts

export type SessionState = "idle" | "configuring" | "running" | "stopped" | "terminated";

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
    variables: Array<{
      name: string;
      value: string;
      type?: string;
      hasChildren: boolean;
      variablesReference: number;
    }>;
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
}

export interface OutputEntry {
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
  id: number;
  verified: boolean;
  line: number;
  message?: string;
}
```

**Step 2: Commit**

```bash
git add src/dap/types.ts
git commit -m "feat: add shared DAP/MCP type definitions"
```

---

## Task 3: Output Ring Buffer

**Files:**
- Create: `src/dap/ring-buffer.ts`
- Create: `src/dap/ring-buffer.test.ts`

**Step 1: Write the failing tests**

```typescript
// src/dap/ring-buffer.test.ts
import { describe, it, expect } from "vitest";
import { RingBuffer } from "./ring-buffer.js";

describe("RingBuffer", () => {
  it("stores and retrieves entries", () => {
    const buf = new RingBuffer<string>(100);
    buf.push("a");
    buf.push("b");
    expect(buf.getAll()).toEqual(["a", "b"]);
    expect(buf.truncated).toBe(false);
  });

  it("drops oldest entries when full", () => {
    const buf = new RingBuffer<string>(3);
    buf.push("a");
    buf.push("b");
    buf.push("c");
    buf.push("d");
    expect(buf.getAll()).toEqual(["b", "c", "d"]);
    expect(buf.truncated).toBe(true);
  });

  it("clears entries", () => {
    const buf = new RingBuffer<string>(10);
    buf.push("a");
    buf.push("b");
    buf.clear();
    expect(buf.getAll()).toEqual([]);
    expect(buf.truncated).toBe(false);
  });

  it("filters entries", () => {
    const buf = new RingBuffer<{ cat: string; text: string }>(10);
    buf.push({ cat: "stdout", text: "hello" });
    buf.push({ cat: "stderr", text: "error" });
    buf.push({ cat: "stdout", text: "world" });
    const filtered = buf.getFiltered((e) => e.cat === "stdout");
    expect(filtered).toEqual([
      { cat: "stdout", text: "hello" },
      { cat: "stdout", text: "world" },
    ]);
  });

  it("reports size correctly", () => {
    const buf = new RingBuffer<string>(5);
    expect(buf.size).toBe(0);
    buf.push("a");
    buf.push("b");
    expect(buf.size).toBe(2);
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run src/dap/ring-buffer.test.ts`
Expected: FAIL — module not found

**Step 3: Implement RingBuffer**

```typescript
// src/dap/ring-buffer.ts
export class RingBuffer<T> {
  private buffer: T[] = [];
  private maxSize: number;
  private _truncated = false;

  constructor(maxSize: number) {
    this.maxSize = maxSize;
  }

  push(item: T): void {
    if (this.buffer.length >= this.maxSize) {
      this.buffer.shift();
      this._truncated = true;
    }
    this.buffer.push(item);
  }

  getAll(): T[] {
    return [...this.buffer];
  }

  getFiltered(predicate: (item: T) => boolean): T[] {
    return this.buffer.filter(predicate);
  }

  clear(): void {
    this.buffer = [];
    this._truncated = false;
  }

  get size(): number {
    return this.buffer.length;
  }

  get truncated(): boolean {
    return this._truncated;
  }
}
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run src/dap/ring-buffer.test.ts`
Expected: all 5 tests PASS

**Step 5: Commit**

```bash
git add src/dap/ring-buffer.ts src/dap/ring-buffer.test.ts
git commit -m "feat: add output ring buffer with max size and truncation tracking"
```

---

## Task 4: DAP Client — Protocol Framing

**Files:**
- Create: `src/dap/protocol.ts`
- Create: `src/dap/protocol.test.ts`

The DAP wire protocol uses `Content-Length: <N>\r\n\r\n<JSON body>` framing over streams. We need an encoder and a stream parser.

**Step 1: Write the failing tests**

```typescript
// src/dap/protocol.test.ts
import { describe, it, expect } from "vitest";
import { encodeMessage, MessageParser } from "./protocol.js";
import { DebugProtocol } from "@vscode/debugprotocol";

describe("encodeMessage", () => {
  it("encodes a DAP message with Content-Length header", () => {
    const msg: DebugProtocol.Request = {
      seq: 1,
      type: "request",
      command: "initialize",
      arguments: { adapterID: "test" },
    };
    const encoded = encodeMessage(msg);
    const str = encoded.toString("utf-8");
    const json = JSON.stringify(msg);
    expect(str).toBe(`Content-Length: ${Buffer.byteLength(json)}\r\n\r\n${json}`);
  });
});

describe("MessageParser", () => {
  it("parses a single complete message", () => {
    const messages: DebugProtocol.ProtocolMessage[] = [];
    const parser = new MessageParser((msg) => messages.push(msg));

    const body = JSON.stringify({ seq: 1, type: "response", command: "initialize", success: true, request_seq: 1 });
    const raw = `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
    parser.feed(Buffer.from(raw));

    expect(messages).toHaveLength(1);
    expect(messages[0].seq).toBe(1);
  });

  it("handles messages split across multiple chunks", () => {
    const messages: DebugProtocol.ProtocolMessage[] = [];
    const parser = new MessageParser((msg) => messages.push(msg));

    const body = JSON.stringify({ seq: 1, type: "event", event: "initialized" });
    const raw = `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
    const mid = Math.floor(raw.length / 2);

    parser.feed(Buffer.from(raw.slice(0, mid)));
    expect(messages).toHaveLength(0);
    parser.feed(Buffer.from(raw.slice(mid)));
    expect(messages).toHaveLength(1);
  });

  it("handles multiple messages in one chunk", () => {
    const messages: DebugProtocol.ProtocolMessage[] = [];
    const parser = new MessageParser((msg) => messages.push(msg));

    const body1 = JSON.stringify({ seq: 1, type: "event", event: "initialized" });
    const body2 = JSON.stringify({ seq: 2, type: "event", event: "stopped" });
    const raw = `Content-Length: ${Buffer.byteLength(body1)}\r\n\r\n${body1}Content-Length: ${Buffer.byteLength(body2)}\r\n\r\n${body2}`;
    parser.feed(Buffer.from(raw));

    expect(messages).toHaveLength(2);
    expect(messages[0].seq).toBe(1);
    expect(messages[1].seq).toBe(2);
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run src/dap/protocol.test.ts`
Expected: FAIL — module not found

**Step 3: Implement protocol encoder and parser**

```typescript
// src/dap/protocol.ts
import { DebugProtocol } from "@vscode/debugprotocol";

const TWO_CRLF = "\r\n\r\n";
const CONTENT_LENGTH = "Content-Length: ";

export function encodeMessage(msg: DebugProtocol.ProtocolMessage): Buffer {
  const json = JSON.stringify(msg);
  const header = `${CONTENT_LENGTH}${Buffer.byteLength(json)}${TWO_CRLF}`;
  return Buffer.from(header + json, "utf-8");
}

export class MessageParser {
  private buffer = Buffer.alloc(0);
  private contentLength = -1;
  private onMessage: (msg: DebugProtocol.ProtocolMessage) => void;

  constructor(onMessage: (msg: DebugProtocol.ProtocolMessage) => void) {
    this.onMessage = onMessage;
  }

  feed(data: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, data]);
    this.parse();
  }

  private parse(): void {
    while (true) {
      if (this.contentLength === -1) {
        const headerEnd = this.buffer.indexOf(TWO_CRLF);
        if (headerEnd === -1) return;

        const header = this.buffer.subarray(0, headerEnd).toString("utf-8");
        const match = header.match(/Content-Length:\s*(\d+)/i);
        if (!match) {
          // Skip malformed header — advance past it
          this.buffer = this.buffer.subarray(headerEnd + TWO_CRLF.length);
          continue;
        }
        this.contentLength = parseInt(match[1], 10);
        this.buffer = this.buffer.subarray(headerEnd + TWO_CRLF.length);
      }

      if (this.buffer.length < this.contentLength) return;

      const body = this.buffer.subarray(0, this.contentLength).toString("utf-8");
      this.buffer = this.buffer.subarray(this.contentLength);
      this.contentLength = -1;

      try {
        const msg = JSON.parse(body) as DebugProtocol.ProtocolMessage;
        this.onMessage(msg);
      } catch {
        // Skip malformed JSON
      }
    }
  }
}
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run src/dap/protocol.test.ts`
Expected: all tests PASS

**Step 5: Commit**

```bash
git add src/dap/protocol.ts src/dap/protocol.test.ts
git commit -m "feat: add DAP Content-Length protocol framing encoder and parser"
```

---

## Task 5: DAP Client — Process Spawning and Request/Response

**Files:**
- Create: `src/dap/dap-client.ts`
- Create: `src/dap/dap-client.test.ts`

The DAP client spawns a debug adapter as a child process, sends requests, and receives responses and events. It uses `EventEmitter` for events and `Promise` for request/response correlation.

**Step 1: Write the failing tests**

Use a mock adapter (a simple Node.js script that echoes back DAP responses) to test the client.

```typescript
// src/dap/dap-client.test.ts
import { describe, it, expect, afterEach } from "vitest";
import { DAPClient, DAPClientError } from "./dap-client.js";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe("DAPClient", () => {
  let client: DAPClient | undefined;

  afterEach(async () => {
    if (client) {
      try { await client.dispose(); } catch { /* ignore */ }
      client = undefined;
    }
  });

  it("spawns adapter and sends initialize request", async () => {
    client = new DAPClient("node", path.join(__dirname, "../test-fixtures/mock-adapter.js"));
    await client.spawn();
    const response = await client.sendRequest("initialize", {
      adapterID: "test",
      linesStartAt1: true,
      columnsStartAt1: true,
      pathFormat: "path",
    });
    expect(response.success).toBe(true);
    expect(response.command).toBe("initialize");
  });

  it("receives events from adapter", async () => {
    client = new DAPClient("node", path.join(__dirname, "../test-fixtures/mock-adapter.js"));
    await client.spawn();

    const eventPromise = new Promise<any>((resolve) => {
      client!.on("initialized", resolve);
    });

    await client.sendRequest("initialize", {
      adapterID: "test",
      linesStartAt1: true,
      columnsStartAt1: true,
      pathFormat: "path",
    });

    const event = await eventPromise;
    expect(event.event).toBe("initialized");
  });

  it("rejects on adapter exit during request", async () => {
    client = new DAPClient("node", path.join(__dirname, "../test-fixtures/crash-adapter.js"));
    await client.spawn();
    await expect(
      client.sendRequest("initialize", { adapterID: "test" })
    ).rejects.toThrow();
  });

  it("times out if adapter does not respond", async () => {
    client = new DAPClient("node", path.join(__dirname, "../test-fixtures/silent-adapter.js"));
    await client.spawn();
    await expect(
      client.sendRequest("initialize", { adapterID: "test" }, 500)
    ).rejects.toThrow(/timeout/i);
  });
});
```

**Step 2: Create test fixture — mock adapter**

Create `src/test-fixtures/mock-adapter.js` — a minimal DAP adapter that handles `initialize`:

```javascript
// src/test-fixtures/mock-adapter.js
// Minimal DAP mock adapter for testing
const TWO_CRLF = "\r\n\r\n";
let buffer = Buffer.alloc(0);
let contentLength = -1;

process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  while (true) {
    if (contentLength === -1) {
      const idx = buffer.indexOf(TWO_CRLF);
      if (idx === -1) return;
      const header = buffer.subarray(0, idx).toString();
      const match = header.match(/Content-Length:\s*(\d+)/i);
      if (!match) return;
      contentLength = parseInt(match[1], 10);
      buffer = buffer.subarray(idx + TWO_CRLF.length);
    }
    if (buffer.length < contentLength) return;
    const body = buffer.subarray(0, contentLength).toString();
    buffer = buffer.subarray(contentLength);
    contentLength = -1;
    handleMessage(JSON.parse(body));
  }
});

function send(msg) {
  const json = JSON.stringify(msg);
  const header = `Content-Length: ${Buffer.byteLength(json)}${TWO_CRLF}`;
  process.stdout.write(header + json);
}

let seq = 1;
function handleMessage(msg) {
  if (msg.type === "request") {
    if (msg.command === "initialize") {
      send({
        seq: seq++, type: "response", request_seq: msg.seq,
        command: "initialize", success: true,
        body: { supportsConfigurationDoneRequest: true }
      });
      send({ seq: seq++, type: "event", event: "initialized", body: {} });
    } else if (msg.command === "disconnect") {
      send({
        seq: seq++, type: "response", request_seq: msg.seq,
        command: "disconnect", success: true
      });
      process.exit(0);
    } else {
      send({
        seq: seq++, type: "response", request_seq: msg.seq,
        command: msg.command, success: true, body: {}
      });
    }
  }
}
```

Create `src/test-fixtures/crash-adapter.js`:

```javascript
// src/test-fixtures/crash-adapter.js
// Adapter that crashes immediately
process.exit(1);
```

Create `src/test-fixtures/silent-adapter.js`:

```javascript
// src/test-fixtures/silent-adapter.js
// Adapter that accepts input but never responds
process.stdin.on("data", () => {});
process.stdin.resume();
```

**Step 3: Run tests to verify they fail**

Run: `npx vitest run src/dap/dap-client.test.ts`
Expected: FAIL — module not found

**Step 4: Implement DAPClient**

```typescript
// src/dap/dap-client.ts
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

      this.process.on("error", (err) => {
        reject(new DAPClientError(`Failed to spawn adapter: ${err.message}`));
      });

      this.process.on("exit", (code, signal) => {
        this._exited = true;
        this._exitCode = code ?? undefined;
        // Reject all pending requests
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

      // Resolve once the process is spawned (stdout is piped)
      this.process.stdout!.once("readable", () => resolve());
      // Also resolve on a short timeout in case readable fires before we listen
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
          reject(new DAPClientError(`Request '${command}' timed out after ${timeout}ms`));
        }, timeout);
      }
      this.pending.set(seq, pending);
      this.process!.stdin!.write(encodeMessage(request));
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
```

**Step 5: Run tests to verify they pass**

Run: `npx vitest run src/dap/dap-client.test.ts`
Expected: all 4 tests PASS

**Step 6: Commit**

```bash
git add src/dap/dap-client.ts src/dap/dap-client.test.ts src/test-fixtures/
git commit -m "feat: add DAP client with process spawning, request/response, and event handling"
```

---

## Task 6: Adapter Registry

**Files:**
- Create: `src/adapters/registry.ts`
- Create: `src/adapters/builtin.ts`
- Create: `src/adapters/registry.test.ts`

**Step 1: Write the failing tests**

```typescript
// src/adapters/registry.test.ts
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { AdapterRegistry } from "./registry.js";
import { AdapterConfig } from "../dap/types.js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

describe("AdapterRegistry", () => {
  let tmpDir: string;
  let registry: AdapterRegistry;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "dap-mcp-test-"));
    registry = new AdapterRegistry(tmpDir, tmpDir);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("returns built-in adapters", () => {
    const adapters = registry.listAll();
    expect(adapters.some((a) => a.type === "python")).toBe(true);
    expect(adapters.some((a) => a.type === "node")).toBe(true);
  });

  it("registers a custom adapter", () => {
    registry.register({
      type: "ruby",
      program: "/usr/bin/rdbg",
      args: ["--open", "--dap"],
    });
    const ruby = registry.get("ruby");
    expect(ruby).toBeDefined();
    expect(ruby!.program).toBe("/usr/bin/rdbg");
  });

  it("project-local overrides built-in", () => {
    registry.register({
      type: "python",
      program: "/custom/debugpy",
    });
    const python = registry.get("python");
    expect(python!.program).toBe("/custom/debugpy");
  });

  it("saves and loads config from disk", async () => {
    registry.register({
      type: "ruby",
      program: "/usr/bin/rdbg",
    });
    await registry.save("project");

    const registry2 = new AdapterRegistry(tmpDir, tmpDir);
    await registry2.load();
    const ruby = registry2.get("ruby");
    expect(ruby).toBeDefined();
    expect(ruby!.program).toBe("/usr/bin/rdbg");
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run src/adapters/registry.test.ts`
Expected: FAIL — module not found

**Step 3: Implement built-in adapter defaults**

```typescript
// src/adapters/builtin.ts
import { AdapterConfig } from "../dap/types.js";

export const BUILTIN_ADAPTERS: AdapterConfig[] = [
  {
    type: "python",
    runtime: "python3",
    program: "-m",
    args: ["debugpy.adapter"],
    installHint: "pip install debugpy",
  },
  {
    type: "node",
    runtime: "node",
    program: "",  // Will be resolved at runtime; js-debug needs special handling
    args: [],
    installHint: "npm install -g @vscode/js-debug",
  },
  {
    type: "go",
    program: "dlv",
    args: ["dap"],
    installHint: "go install github.com/go-delve/delve/cmd/dlv@latest",
  },
  {
    type: "cppdbg",
    program: "lldb-dap",
    args: [],
    installHint: "apt install lldb (Debian/Ubuntu) or brew install llvm (macOS)",
  },
];
```

**Step 4: Implement AdapterRegistry**

```typescript
// src/adapters/registry.ts
import { AdapterConfig } from "../dap/types.js";
import { BUILTIN_ADAPTERS } from "./builtin.js";
import fs from "node:fs/promises";
import path from "node:path";

export class AdapterRegistry {
  private builtins: Map<string, AdapterConfig>;
  private global: Map<string, AdapterConfig> = new Map();
  private project: Map<string, AdapterConfig> = new Map();
  private globalDir: string;
  private projectDir: string;

  constructor(globalDir: string, projectDir: string) {
    this.globalDir = globalDir;
    this.projectDir = projectDir;
    this.builtins = new Map(BUILTIN_ADAPTERS.map((a) => [a.type, a]));
  }

  get(type: string): AdapterConfig | undefined {
    // Priority: project > global > builtin
    return this.project.get(type) ?? this.global.get(type) ?? this.builtins.get(type);
  }

  register(config: AdapterConfig, scope: "global" | "project" = "project"): void {
    const map = scope === "global" ? this.global : this.project;
    map.set(config.type, config);
  }

  listAll(): Array<AdapterConfig & { source: "builtin" | "global" | "project" }> {
    const result = new Map<string, AdapterConfig & { source: "builtin" | "global" | "project" }>();

    for (const [type, config] of this.builtins) {
      result.set(type, { ...config, source: "builtin" });
    }
    for (const [type, config] of this.global) {
      result.set(type, { ...config, source: "global" });
    }
    for (const [type, config] of this.project) {
      result.set(type, { ...config, source: "project" });
    }

    return Array.from(result.values());
  }

  async load(): Promise<void> {
    this.global = await this.loadFile(path.join(this.globalDir, "adapters.json"));
    this.project = await this.loadFile(path.join(this.projectDir, "adapters.json"));
  }

  async save(scope: "global" | "project"): Promise<void> {
    const dir = scope === "global" ? this.globalDir : this.projectDir;
    const map = scope === "global" ? this.global : this.project;
    await fs.mkdir(dir, { recursive: true });
    const data = Object.fromEntries(map);
    await fs.writeFile(path.join(dir, "adapters.json"), JSON.stringify(data, null, 2));
  }

  private async loadFile(filePath: string): Promise<Map<string, AdapterConfig>> {
    try {
      const data = await fs.readFile(filePath, "utf-8");
      const parsed = JSON.parse(data) as Record<string, AdapterConfig>;
      return new Map(Object.entries(parsed));
    } catch {
      return new Map();
    }
  }
}
```

**Step 5: Run tests to verify they pass**

Run: `npx vitest run src/adapters/registry.test.ts`
Expected: all 4 tests PASS

**Step 6: Commit**

```bash
git add src/adapters/registry.ts src/adapters/builtin.ts src/adapters/registry.test.ts
git commit -m "feat: add adapter registry with built-in defaults and config persistence"
```

---

## Task 7: Debug Session

**Files:**
- Create: `src/session/session.ts`
- Create: `src/session/session.test.ts`

The Session wraps a DAPClient and adds: state tracking, breakpoint storage, output buffering, and composite state collection.

**Step 1: Write the failing tests**

```typescript
// src/session/session.test.ts
import { describe, it, expect, afterEach } from "vitest";
import { DebugSession } from "./session.js";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MOCK_ADAPTER = path.join(__dirname, "../test-fixtures/mock-adapter.js");

describe("DebugSession", () => {
  let session: DebugSession | undefined;

  afterEach(async () => {
    if (session) {
      try { await session.disconnect(); } catch { /* ignore */ }
      session = undefined;
    }
  });

  it("initializes and tracks state", async () => {
    session = new DebugSession("test-1", {
      type: "mock",
      runtime: "node",
      program: MOCK_ADAPTER,
    });
    expect(session.state).toBe("idle");
    await session.initialize();
    expect(session.state).toBe("configuring");
  });

  it("has a unique session ID", () => {
    session = new DebugSession("my-session", {
      type: "mock",
      runtime: "node",
      program: MOCK_ADAPTER,
    });
    expect(session.id).toBe("my-session");
  });

  it("buffers output events", async () => {
    session = new DebugSession("test-2", {
      type: "mock",
      runtime: "node",
      program: MOCK_ADAPTER,
    });
    // Simulate output
    session.addOutput("stdout", "hello world");
    const output = session.getOutput();
    expect(output.output).toHaveLength(1);
    expect(output.output[0].text).toBe("hello world");
    expect(output.output[0].category).toBe("stdout");
  });

  it("detects adapter crash", async () => {
    const crashAdapter = path.join(__dirname, "../test-fixtures/crash-adapter.js");
    session = new DebugSession("test-crash", {
      type: "mock",
      runtime: "node",
      program: crashAdapter,
    });
    await expect(session.initialize()).rejects.toThrow();
    expect(session.state).toBe("terminated");
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run src/session/session.test.ts`
Expected: FAIL — module not found

**Step 3: Implement DebugSession**

```typescript
// src/session/session.ts
import { DAPClient, DAPClientError } from "../dap/dap-client.js";
import { RingBuffer } from "../dap/ring-buffer.js";
import {
  SessionState,
  StoppedState,
  RunningState,
  DebugState,
  AdapterConfig,
  OutputEntry,
  BreakpointConfig,
  BreakpointResult,
} from "../dap/types.js";
import { DebugProtocol } from "@vscode/debugprotocol";
import path from "node:path";

const MAX_OUTPUT_LINES = 10000;
const DEFAULT_TIMEOUT = 30000;

export class DebugSession {
  readonly id: string;
  private client: DAPClient;
  private adapterConfig: AdapterConfig;
  private _state: SessionState = "idle";
  private outputBuffer = new RingBuffer<OutputEntry>(MAX_OUTPUT_LINES);
  private breakpointsMap = new Map<string, BreakpointConfig[]>();
  private capabilities: DebugProtocol.Capabilities = {};
  private stoppedThreadId?: number;
  private stoppedReason?: string;
  private launchConfig?: Record<string, unknown>;
  private launchMode: "launch" | "attach" = "launch";

  // Promise-based event waiting
  private stoppedResolve?: (event: DebugProtocol.StoppedEvent) => void;

  constructor(id: string, config: AdapterConfig) {
    this.id = id;
    this.adapterConfig = config;

    const runtime = config.runtime || "";
    const program = config.program;
    const args = config.args || [];

    this.client = new DAPClient(runtime, program, args);

    this.client.on("event", (event: DebugProtocol.Event) => {
      this.handleEvent(event);
    });

    this.client.on("exit", (_code: number, _signal: string) => {
      if (this._state !== "terminated") {
        this._state = "terminated";
      }
    });
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
        linesStartAt1: true,
        columnsStartAt1: true,
        pathFormat: "path",
      });
      this.capabilities = response.body || {};
      this._state = "configuring";
      return this.capabilities;
    } catch (err) {
      this._state = "terminated";
      throw err;
    }
  }

  async setBreakpoints(
    filePath: string,
    breakpoints: BreakpointConfig[]
  ): Promise<BreakpointResult[]> {
    const absPath = path.resolve(filePath);
    this.breakpointsMap.set(absPath, breakpoints);

    const response = await this.client.sendRequest("setBreakpoints", {
      source: { path: absPath },
      breakpoints: breakpoints.map((bp) => ({
        line: bp.line,
        condition: bp.condition,
        hitCondition: bp.hitCondition,
        logMessage: bp.logMessage,
      })),
    });

    return (response.body?.breakpoints || []).map((bp: any) => ({
      id: bp.id ?? 0,
      verified: bp.verified ?? false,
      line: bp.line ?? 0,
      message: bp.message,
    }));
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
    await this.client.sendRequest("launch", config);
    this._state = "running";
  }

  async attach(config: Record<string, unknown>): Promise<void> {
    this.launchConfig = config;
    this.launchMode = "attach";
    await this.client.sendRequest("attach", config);
    this._state = "running";
  }

  async continueExecution(threadId?: number): Promise<void> {
    const tid = threadId ?? this.stoppedThreadId ?? 1;
    await this.client.sendRequest("continue", { threadId: tid });
    this._state = "running";
  }

  async next(threadId?: number): Promise<void> {
    const tid = threadId ?? this.stoppedThreadId ?? 1;
    await this.client.sendRequest("next", { threadId: tid });
    this._state = "running";
  }

  async stepIn(threadId?: number): Promise<void> {
    const tid = threadId ?? this.stoppedThreadId ?? 1;
    await this.client.sendRequest("stepIn", { threadId: tid });
    this._state = "running";
  }

  async stepOut(threadId?: number): Promise<void> {
    const tid = threadId ?? this.stoppedThreadId ?? 1;
    await this.client.sendRequest("stepOut", { threadId: tid });
    this._state = "running";
  }

  async pause(threadId?: number): Promise<void> {
    const tid = threadId ?? this.stoppedThreadId ?? 1;
    await this.client.sendRequest("pause", { threadId: tid });
  }

  async waitForStopped(timeout = DEFAULT_TIMEOUT): Promise<DebugProtocol.StoppedEvent> {
    if (this._state === "stopped") {
      // Already stopped — build a synthetic event
      return {
        seq: 0,
        type: "event",
        event: "stopped",
        body: {
          reason: this.stoppedReason || "unknown",
          threadId: this.stoppedThreadId,
        },
      } as DebugProtocol.StoppedEvent;
    }

    return new Promise<DebugProtocol.StoppedEvent>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.stoppedResolve = undefined;
        reject(new Error("timeout"));
      }, timeout);

      this.stoppedResolve = (event) => {
        clearTimeout(timer);
        this.stoppedResolve = undefined;
        resolve(event);
      };
    });
  }

  async getThreads(): Promise<DebugProtocol.Thread[]> {
    const response = await this.client.sendRequest("threads");
    return response.body?.threads || [];
  }

  async getStackTrace(
    threadId: number,
    depth = 10
  ): Promise<DebugProtocol.StackFrame[]> {
    const response = await this.client.sendRequest("stackTrace", {
      threadId,
      startFrame: 0,
      levels: depth,
    });
    return response.body?.stackFrames || [];
  }

  async getScopes(frameId: number): Promise<DebugProtocol.Scope[]> {
    const response = await this.client.sendRequest("scopes", { frameId });
    return response.body?.scopes || [];
  }

  async getVariables(
    variablesReference: number,
    depth = 1
  ): Promise<Array<{
    name: string;
    value: string;
    type?: string;
    hasChildren: boolean;
    variablesReference: number;
  }>> {
    const response = await this.client.sendRequest("variables", {
      variablesReference,
    });
    const vars = (response.body?.variables || []).map((v: any) => ({
      name: v.name,
      value: v.value,
      type: v.type,
      hasChildren: (v.variablesReference ?? 0) > 0,
      variablesReference: v.variablesReference ?? 0,
    }));

    // Recursively expand children if depth > 1
    if (depth > 1) {
      for (const v of vars) {
        if (v.hasChildren) {
          const children = await this.getVariables(v.variablesReference, depth - 1);
          // Attach children as a stringified nested value
          v.value = `${v.value} { ${children.map((c) => `${c.name}: ${c.value}`).join(", ")} }`;
        }
      }
    }

    return vars;
  }

  async evaluate(
    expression: string,
    frameId?: number,
    context: "repl" | "watch" | "hover" = "repl"
  ): Promise<{ result: string; type?: string; hasChildren: boolean; variablesReference: number }> {
    const args: Record<string, unknown> = { expression, context };
    if (frameId !== undefined) args.frameId = frameId;

    const response = await this.client.sendRequest("evaluate", args);
    return {
      result: response.body?.result ?? "",
      type: response.body?.type,
      hasChildren: (response.body?.variablesReference ?? 0) > 0,
      variablesReference: response.body?.variablesReference ?? 0,
    };
  }

  async collectState(
    threadId?: number,
    depth = 10,
    variableDepth = 1
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

    // Collect scopes and variables for the top frame
    const scopes: StoppedState["scopes"] = [];
    if (topFrame) {
      const rawScopes = await this.getScopes(topFrame.id);
      for (const scope of rawScopes) {
        const variables = await this.getVariables(scope.variablesReference, variableDepth);
        scopes.push({ name: scope.name, variables });
      }
    }

    // Drain any pending output
    const output = this.outputBuffer.getAll().map((e) => e.text);

    return {
      status: "stopped",
      reason: this.stoppedReason || "unknown",
      location,
      threads: threads.map((t) => ({
        id: t.id,
        name: t.name,
        stopped: t.id === tid,
      })),
      stackTrace: frames.map((f) => ({
        id: f.id,
        name: f.name,
        file: f.source?.path || f.source?.name || "<unknown>",
        line: f.line,
        column: f.column,
      })),
      scopes,
      output: output.length > 0 ? output : undefined,
    };
  }

  addOutput(category: string, text: string): void {
    this.outputBuffer.push({
      category,
      text,
      timestamp: new Date().toISOString(),
    });
  }

  getOutput(
    category?: string,
    clear = false
  ): { output: OutputEntry[]; truncated: boolean } {
    const entries = category
      ? this.outputBuffer.getFiltered((e) => e.category === category)
      : this.outputBuffer.getAll();
    const truncated = this.outputBuffer.truncated;
    if (clear) this.outputBuffer.clear();
    return { output: entries, truncated };
  }

  async disconnect(terminateDebuggee?: boolean): Promise<void> {
    const terminate = terminateDebuggee ?? (this.launchMode === "launch");
    try {
      await this.client.sendRequest("disconnect", { terminateDebuggee: terminate }, 5000);
    } catch {
      // Ignore — adapter may have already exited
    }
    this._state = "terminated";
    await this.client.dispose();
  }

  getLaunchConfig(): Record<string, unknown> | undefined {
    return this.launchConfig;
  }

  getLaunchMode(): "launch" | "attach" {
    return this.launchMode;
  }

  getAdapterConfig(): AdapterConfig {
    return this.adapterConfig;
  }

  private handleEvent(event: DebugProtocol.Event): void {
    switch (event.event) {
      case "stopped":
        this._state = "stopped";
        this.stoppedThreadId = event.body?.threadId;
        this.stoppedReason = event.body?.reason;
        if (this.stoppedResolve) {
          this.stoppedResolve(event as DebugProtocol.StoppedEvent);
        }
        break;
      case "continued":
        this._state = "running";
        break;
      case "output":
        if (event.body?.output) {
          this.addOutput(
            event.body.category || "console",
            event.body.output
          );
        }
        break;
      case "terminated":
      case "exited":
        this._state = "terminated";
        break;
    }
  }
}
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run src/session/session.test.ts`
Expected: all 4 tests PASS

**Step 5: Commit**

```bash
git add src/session/session.ts src/session/session.test.ts
git commit -m "feat: add DebugSession with state tracking, output buffering, and composite state collection"
```

---

## Task 8: Session Manager

**Files:**
- Create: `src/session/session-manager.ts`
- Create: `src/session/session-manager.test.ts`

**Step 1: Write the failing tests**

```typescript
// src/session/session-manager.test.ts
import { describe, it, expect } from "vitest";
import { SessionManager } from "./session-manager.js";

describe("SessionManager", () => {
  it("generates unique session IDs", () => {
    const manager = new SessionManager();
    const id1 = manager.generateId();
    const id2 = manager.generateId();
    expect(id1).not.toBe(id2);
  });

  it("stores and retrieves sessions by ID", () => {
    const manager = new SessionManager();
    const mockSession = { id: "test-1" } as any;
    manager.add(mockSession);
    expect(manager.get("test-1")).toBe(mockSession);
  });

  it("removes sessions", () => {
    const manager = new SessionManager();
    const mockSession = { id: "test-1" } as any;
    manager.add(mockSession);
    manager.remove("test-1");
    expect(manager.get("test-1")).toBeUndefined();
  });

  it("resolves single session when no ID provided", () => {
    const manager = new SessionManager();
    const mockSession = { id: "test-1" } as any;
    manager.add(mockSession);
    expect(manager.resolve(undefined)).toBe(mockSession);
  });

  it("throws when resolving without ID and multiple sessions exist", () => {
    const manager = new SessionManager();
    manager.add({ id: "s1" } as any);
    manager.add({ id: "s2" } as any);
    expect(() => manager.resolve(undefined)).toThrow(/multiple/i);
  });

  it("throws when resolving non-existent session", () => {
    const manager = new SessionManager();
    expect(() => manager.resolve("nope")).toThrow(/not found/i);
  });

  it("lists all sessions", () => {
    const manager = new SessionManager();
    manager.add({ id: "s1" } as any);
    manager.add({ id: "s2" } as any);
    expect(manager.listAll()).toHaveLength(2);
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run src/session/session-manager.test.ts`
Expected: FAIL

**Step 3: Implement SessionManager**

```typescript
// src/session/session-manager.ts
import { DebugSession } from "./session.js";
import { randomUUID } from "node:crypto";

export class SessionManager {
  private sessions = new Map<string, DebugSession>();

  generateId(): string {
    return randomUUID().slice(0, 8);
  }

  add(session: DebugSession): void {
    this.sessions.set(session.id, session);
  }

  get(id: string): DebugSession | undefined {
    return this.sessions.get(id);
  }

  remove(id: string): void {
    this.sessions.delete(id);
  }

  resolve(sessionId: string | undefined): DebugSession {
    if (sessionId) {
      const session = this.sessions.get(sessionId);
      if (!session) {
        const available = Array.from(this.sessions.keys()).join(", ");
        throw new Error(
          `Session '${sessionId}' not found. Available sessions: ${available || "none"}`
        );
      }
      return session;
    }

    if (this.sessions.size === 0) {
      throw new Error("No active debug sessions. Use debug_launch or debug_attach first.");
    }
    if (this.sessions.size === 1) {
      return this.sessions.values().next().value!;
    }

    const available = Array.from(this.sessions.keys()).join(", ");
    throw new Error(
      `Multiple active sessions: ${available}. Specify sessionId.`
    );
  }

  listAll(): DebugSession[] {
    return Array.from(this.sessions.values());
  }
}
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run src/session/session-manager.test.ts`
Expected: all 7 tests PASS

**Step 5: Commit**

```bash
git add src/session/session-manager.ts src/session/session-manager.test.ts
git commit -m "feat: add session manager with auto-resolve for single sessions"
```

---

## Task 9: MCP Server — Core Setup and Adapter Tools

**Files:**
- Create: `src/server.ts`
- Modify: `src/index.ts`

This task sets up the MCP server with the two adapter management tools (`list_adapters`, `configure_adapter`) and the `dap://sessions` resource.

**Step 1: Implement the MCP server core**

```typescript
// src/server.ts
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { SessionManager } from "./session/session-manager.js";
import { AdapterRegistry } from "./adapters/registry.js";
import { DebugSession } from "./session/session.js";
import { AdapterConfig, DebugState } from "./dap/types.js";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export function createServer(): McpServer {
  const globalConfigDir = path.join(os.homedir(), ".dap-mcp");
  const projectConfigDir = path.join(process.cwd(), ".dap-mcp");

  const registry = new AdapterRegistry(globalConfigDir, projectConfigDir);
  const sessions = new SessionManager();

  // Load config asynchronously on first use
  let configLoaded = false;
  async function ensureConfig() {
    if (!configLoaded) {
      await registry.load();
      configLoaded = true;
    }
  }

  const server = new McpServer({
    name: "dap-mcp-server",
    version: "0.1.0",
  });

  // === Tool: list_adapters ===
  server.tool(
    "list_adapters",
    "List available debug adapter configurations with availability status",
    {},
    async () => {
      await ensureConfig();
      const adapters = registry.listAll();

      const results = await Promise.all(
        adapters.map(async (adapter) => {
          let available = false;
          try {
            if (adapter.runtime) {
              await execFileAsync("which", [adapter.runtime]);
              available = true;
            } else if (adapter.program) {
              await execFileAsync("which", [adapter.program]);
              available = true;
            }
          } catch {
            available = false;
          }
          return {
            type: adapter.type,
            source: adapter.source,
            available,
            program: adapter.runtime
              ? `${adapter.runtime} ${adapter.program}`
              : adapter.program,
            installHint: adapter.installHint,
          };
        })
      );

      return {
        content: [{ type: "text" as const, text: JSON.stringify(results, null, 2) }],
      };
    }
  );

  // === Tool: configure_adapter ===
  server.tool(
    "configure_adapter",
    "Register or update a debug adapter configuration",
    {
      type: z.string().describe("Adapter type identifier (e.g., 'ruby', 'python')"),
      runtime: z.string().optional().describe("Runtime command (e.g., 'node', 'python3')"),
      program: z.string().describe("Path to adapter binary or module"),
      args: z.array(z.string()).optional().describe("Arguments to pass when spawning the adapter"),
      launchDefaults: z.record(z.unknown()).optional().describe("Default launch configuration"),
      scope: z.enum(["global", "project"]).optional().describe("Where to save the config (default: project)"),
    },
    async ({ type, runtime, program, args, launchDefaults, scope }) => {
      await ensureConfig();
      const config: AdapterConfig = { type, program, runtime, args, launchDefaults };
      const targetScope = scope || "project";
      registry.register(config, targetScope);
      await registry.save(targetScope);

      return {
        content: [{ type: "text" as const, text: `Adapter '${type}' configured (${targetScope}).` }],
      };
    }
  );

  // === Tool: debug_launch ===
  server.tool(
    "debug_launch",
    "Start a new debug session by launching a program. Sets breakpoints and stops on entry by default.",
    {
      adapter: z.string().describe("Adapter type: 'python', 'node', 'go', 'cppdbg', or custom"),
      program: z.string().describe("Path to the program to debug"),
      args: z.array(z.string()).optional().describe("Program arguments"),
      cwd: z.string().optional().describe("Working directory"),
      env: z.record(z.string()).optional().describe("Environment variables"),
      stopOnEntry: z.boolean().optional().describe("Stop on entry (default: true)"),
      breakpoints: z
        .array(
          z.object({
            file: z.string(),
            lines: z.array(
              z.object({
                line: z.number(),
                condition: z.string().optional(),
                hitCondition: z.string().optional(),
                logMessage: z.string().optional(),
              })
            ),
          })
        )
        .optional()
        .describe("Initial breakpoints"),
      exceptionBreakpoints: z.array(z.string()).optional().describe("Exception breakpoint filters"),
      adapterConfig: z.record(z.unknown()).optional().describe("Additional adapter-specific launch config"),
    },
    async ({ adapter, program, args, cwd, env, stopOnEntry, breakpoints, exceptionBreakpoints, adapterConfig }) => {
      try {
        await ensureConfig();
        const adapterCfg = registry.get(adapter);
        if (!adapterCfg) {
          return {
            content: [{ type: "text" as const, text: `Unknown adapter '${adapter}'. Run list_adapters to see available adapters.` }],
            isError: true,
          };
        }

        const sessionId = sessions.generateId();
        const session = new DebugSession(sessionId, adapterCfg);
        sessions.add(session);

        // Initialize
        await session.initialize();

        // Wait for 'initialized' event (brief wait)
        await new Promise((r) => setTimeout(r, 200));

        // Set breakpoints
        if (breakpoints) {
          for (const bp of breakpoints) {
            await session.setBreakpoints(
              bp.file,
              bp.lines.map((l) => ({
                line: l.line,
                condition: l.condition,
                hitCondition: l.hitCondition,
                logMessage: l.logMessage,
              }))
            );
          }
        }

        // Set exception breakpoints
        if (exceptionBreakpoints) {
          await session.setExceptionBreakpoints(exceptionBreakpoints);
        }

        // Configuration done
        await session.configurationDone();

        // Launch
        const launchArgs: Record<string, unknown> = {
          program: path.resolve(program),
          args: args || [],
          cwd: cwd || process.cwd(),
          stopOnEntry: stopOnEntry !== false,
          ...adapterCfg.launchDefaults,
          ...adapterConfig,
        };
        if (env) launchArgs.env = env;

        await session.launch(launchArgs);

        // Wait for stopped event if stopOnEntry
        if (stopOnEntry !== false) {
          try {
            await session.waitForStopped(10000);
            const state = await session.collectState();
            return {
              content: [{ type: "text" as const, text: JSON.stringify({ sessionId, ...state }, null, 2) }],
            };
          } catch {
            return {
              content: [{ type: "text" as const, text: JSON.stringify({ sessionId, status: "running", output: [] }, null, 2) }],
            };
          }
        }

        return {
          content: [{ type: "text" as const, text: JSON.stringify({ sessionId, status: "running" }, null, 2) }],
        };
      } catch (err: any) {
        return {
          content: [{ type: "text" as const, text: `Launch failed: ${err.message}` }],
          isError: true,
        };
      }
    }
  );

  // === Tool: debug_attach ===
  server.tool(
    "debug_attach",
    "Attach to a running process for debugging",
    {
      adapter: z.string().describe("Adapter type"),
      processId: z.number().optional().describe("Process ID to attach to"),
      host: z.string().optional().describe("Host for remote attach"),
      port: z.number().optional().describe("Port for remote attach"),
      adapterConfig: z.record(z.unknown()).optional().describe("Additional adapter-specific config"),
    },
    async ({ adapter, processId, host, port, adapterConfig }) => {
      try {
        await ensureConfig();
        const adapterCfg = registry.get(adapter);
        if (!adapterCfg) {
          return {
            content: [{ type: "text" as const, text: `Unknown adapter '${adapter}'.` }],
            isError: true,
          };
        }

        const sessionId = sessions.generateId();
        const session = new DebugSession(sessionId, adapterCfg);
        sessions.add(session);

        await session.initialize();
        await new Promise((r) => setTimeout(r, 200));
        await session.configurationDone();

        const attachArgs: Record<string, unknown> = { ...adapterConfig };
        if (processId !== undefined) attachArgs.processId = processId;
        if (host) attachArgs.host = host;
        if (port) attachArgs.port = port;

        await session.attach(attachArgs);

        return {
          content: [{ type: "text" as const, text: JSON.stringify({ sessionId, status: "running" }, null, 2) }],
        };
      } catch (err: any) {
        return {
          content: [{ type: "text" as const, text: `Attach failed: ${err.message}` }],
          isError: true,
        };
      }
    }
  );

  // === Tool: set_breakpoints ===
  server.tool(
    "set_breakpoints",
    "Set or replace breakpoints in a source file. Replaces all breakpoints in the specified file (DAP semantics).",
    {
      sessionId: z.string().optional().describe("Session ID (optional if single session)"),
      file: z.string().describe("Source file path"),
      breakpoints: z.array(
        z.object({
          line: z.number(),
          condition: z.string().optional(),
          hitCondition: z.string().optional(),
          logMessage: z.string().optional(),
        })
      ).describe("Breakpoints to set"),
    },
    async ({ sessionId, file, breakpoints }) => {
      try {
        const session = sessions.resolve(sessionId);
        const results = await session.setBreakpoints(file, breakpoints);
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ breakpoints: results }, null, 2) }],
        };
      } catch (err: any) {
        return {
          content: [{ type: "text" as const, text: err.message }],
          isError: true,
        };
      }
    }
  );

  // === Tool: set_exception_breakpoints ===
  server.tool(
    "set_exception_breakpoints",
    "Configure which exceptions cause the debugger to break",
    {
      sessionId: z.string().optional().describe("Session ID (optional if single session)"),
      filters: z.array(z.string()).describe("Exception breakpoint filters (adapter-specific, e.g., ['uncaught', 'raised'])"),
    },
    async ({ sessionId, filters }) => {
      try {
        const session = sessions.resolve(sessionId);
        await session.setExceptionBreakpoints(filters);
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ filters }, null, 2) }],
        };
      } catch (err: any) {
        return {
          content: [{ type: "text" as const, text: err.message }],
          isError: true,
        };
      }
    }
  );

  // === Tool: get_state ===
  server.tool(
    "get_state",
    "Get current debuggee state. When stopped: threads, stack trace, scopes, and variables. When running: status and buffered output.",
    {
      sessionId: z.string().optional().describe("Session ID (optional if single session)"),
      threadId: z.number().optional().describe("Thread to inspect (default: stopped thread)"),
      depth: z.number().optional().describe("Stack frames to return (default: 10)"),
      variableDepth: z.number().optional().describe("Nested variable expansion depth (default: 1)"),
      timeout: z.number().optional().describe("Ms to wait if running (default: 0, return immediately)"),
    },
    async ({ sessionId, threadId, depth, variableDepth, timeout }) => {
      try {
        const session = sessions.resolve(sessionId);

        if (session.state === "running" && timeout && timeout > 0) {
          try {
            await session.waitForStopped(timeout);
          } catch {
            const { output } = session.getOutput();
            return {
              content: [{
                type: "text" as const,
                text: JSON.stringify({ status: "running", output: output.map((o) => o.text) }, null, 2),
              }],
            };
          }
        }

        if (session.state === "stopped") {
          const state = await session.collectState(threadId, depth ?? 10, variableDepth ?? 1);
          return {
            content: [{ type: "text" as const, text: JSON.stringify(state, null, 2) }],
          };
        }

        if (session.state === "terminated") {
          const { output } = session.getOutput();
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({ status: "terminated", output: output.map((o) => o.text) }, null, 2),
            }],
          };
        }

        // Running
        const { output } = session.getOutput();
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({ status: "running", output: output.map((o) => o.text) }, null, 2),
          }],
        };
      } catch (err: any) {
        return {
          content: [{ type: "text" as const, text: err.message }],
          isError: true,
        };
      }
    }
  );

  // === Tool: evaluate ===
  server.tool(
    "evaluate",
    "Evaluate an expression in the debuggee's context (only works when stopped)",
    {
      sessionId: z.string().optional().describe("Session ID (optional if single session)"),
      expression: z.string().describe("Expression to evaluate"),
      frameId: z.number().optional().describe("Stack frame ID (default: top frame)"),
      context: z.enum(["repl", "watch", "hover"]).optional().describe("Evaluation context (default: repl)"),
    },
    async ({ sessionId, expression, frameId, context }) => {
      try {
        const session = sessions.resolve(sessionId);
        if (session.state !== "stopped") {
          return {
            content: [{ type: "text" as const, text: "Cannot evaluate: debuggee is not stopped." }],
            isError: true,
          };
        }
        const result = await session.evaluate(expression, frameId, context ?? "repl");
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (err: any) {
        return {
          content: [{ type: "text" as const, text: `Evaluation error: ${err.message}` }],
          isError: true,
        };
      }
    }
  );

  // === Tool: step ===
  server.tool(
    "step",
    "Control execution. Blocks until the debuggee stops again or timeout. Returns the new stopped state.",
    {
      sessionId: z.string().optional().describe("Session ID (optional if single session)"),
      action: z.enum(["continue", "next", "stepIn", "stepOut", "pause"]).describe("Execution action"),
      threadId: z.number().optional().describe("Thread ID (default: focused thread)"),
      timeout: z.number().optional().describe("Ms to wait for stop (default: 30000)"),
    },
    async ({ sessionId, action, threadId, timeout }) => {
      try {
        const session = sessions.resolve(sessionId);
        const timeoutMs = timeout ?? 30000;

        // Execute the action
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

        // Wait for stopped
        try {
          await session.waitForStopped(timeoutMs);
          const state = await session.collectState(threadId);
          return {
            content: [{ type: "text" as const, text: JSON.stringify(state, null, 2) }],
          };
        } catch {
          if (session.state === "terminated") {
            const { output } = session.getOutput();
            return {
              content: [{
                type: "text" as const,
                text: JSON.stringify({ status: "terminated", output: output.map((o) => o.text) }, null, 2),
              }],
            };
          }
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({ status: "running", elapsedMs: timeoutMs }, null, 2),
            }],
          };
        }
      } catch (err: any) {
        return {
          content: [{ type: "text" as const, text: err.message }],
          isError: true,
        };
      }
    }
  );

  // === Tool: get_output ===
  server.tool(
    "get_output",
    "Get buffered program output (stdout, stderr, console messages)",
    {
      sessionId: z.string().optional().describe("Session ID (optional if single session)"),
      category: z.enum(["stdout", "stderr", "console"]).optional().describe("Filter by category (default: all)"),
      clear: z.boolean().optional().describe("Clear the buffer after reading (default: false)"),
    },
    async ({ sessionId, category, clear }) => {
      try {
        const session = sessions.resolve(sessionId);
        const result = session.getOutput(category, clear ?? false);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (err: any) {
        return {
          content: [{ type: "text" as const, text: err.message }],
          isError: true,
        };
      }
    }
  );

  // === Tool: debug_disconnect ===
  server.tool(
    "debug_disconnect",
    "End a debug session. Terminates the debuggee for launched sessions by default.",
    {
      sessionId: z.string().optional().describe("Session ID (optional if single session)"),
      terminateDebuggee: z.boolean().optional().describe("Kill the debuggee process (default: true for launch, false for attach)"),
    },
    async ({ sessionId, terminateDebuggee }) => {
      try {
        const session = sessions.resolve(sessionId);
        await session.disconnect(terminateDebuggee);
        sessions.remove(session.id);
        return {
          content: [{ type: "text" as const, text: `Session '${session.id}' disconnected.` }],
        };
      } catch (err: any) {
        return {
          content: [{ type: "text" as const, text: err.message }],
          isError: true,
        };
      }
    }
  );

  // === Tool: debug_restart ===
  server.tool(
    "debug_restart",
    "Restart the current debug session with the same configuration",
    {
      sessionId: z.string().optional().describe("Session ID (optional if single session)"),
    },
    async ({ sessionId }) => {
      try {
        const session = sessions.resolve(sessionId);
        const launchConfig = session.getLaunchConfig();
        const launchMode = session.getLaunchMode();
        const adapterConfig = session.getAdapterConfig();

        if (!launchConfig) {
          return {
            content: [{ type: "text" as const, text: "Cannot restart: no launch configuration stored." }],
            isError: true,
          };
        }

        // Disconnect old session
        await session.disconnect();
        sessions.remove(session.id);

        // Create new session with same config
        const newId = sessions.generateId();
        const newSession = new DebugSession(newId, adapterConfig);
        sessions.add(newSession);

        await newSession.initialize();
        await new Promise((r) => setTimeout(r, 200));
        await newSession.configurationDone();

        if (launchMode === "launch") {
          await newSession.launch(launchConfig);
        } else {
          await newSession.attach(launchConfig);
        }

        try {
          await newSession.waitForStopped(10000);
          const state = await newSession.collectState();
          return {
            content: [{ type: "text" as const, text: JSON.stringify({ sessionId: newId, ...state }, null, 2) }],
          };
        } catch {
          return {
            content: [{ type: "text" as const, text: JSON.stringify({ sessionId: newId, status: "running" }, null, 2) }],
          };
        }
      } catch (err: any) {
        return {
          content: [{ type: "text" as const, text: `Restart failed: ${err.message}` }],
          isError: true,
        };
      }
    }
  );

  // === Resource: dap://sessions ===
  server.resource(
    "debug-sessions",
    "dap://sessions",
    {
      description: "List of active debug sessions with their current status",
      mimeType: "application/json",
    },
    async (uri) => {
      const allSessions = sessions.listAll();
      const summary = allSessions.map((s) => ({
        id: s.id,
        state: s.state,
        adapter: s.getAdapterConfig().type,
        mode: s.getLaunchMode(),
      }));
      return {
        contents: [{ uri: uri.href, text: JSON.stringify(summary, null, 2) }],
      };
    }
  );

  return server;
}
```

**Step 2: Update entry point**

```typescript
// src/index.ts
#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";

const server = createServer();
const transport = new StdioServerTransport();
await server.connect(transport);
console.error("dap-mcp-server running on stdio");
```

**Step 3: Build and verify**

Run: `npx tsc --noEmit`
Expected: no errors

**Step 4: Run all tests**

Run: `npx vitest run`
Expected: all tests PASS

**Step 5: Commit**

```bash
git add src/server.ts src/index.ts
git commit -m "feat: add MCP server with all 12 tools and sessions resource"
```

---

## Task 10: Integration Test with Mock Adapter

**Files:**
- Modify: `src/test-fixtures/mock-adapter.js` (extend to handle full lifecycle)
- Create: `src/integration/debug-lifecycle.test.ts`

**Step 1: Extend the mock adapter to support a complete debug lifecycle**

Update `src/test-fixtures/mock-adapter.js` to handle: `initialize`, `setBreakpoints`, `configurationDone`, `launch`, `threads`, `stackTrace`, `scopes`, `variables`, `continue`, `next`, `evaluate`, `disconnect`.

The mock simulates a simple program with a single thread, 3 stack frames, and some variables.

```javascript
// src/test-fixtures/mock-adapter.js
// Full-lifecycle DAP mock adapter for testing
const TWO_CRLF = "\r\n\r\n";
let buffer = Buffer.alloc(0);
let contentLength = -1;

process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  while (true) {
    if (contentLength === -1) {
      const idx = buffer.indexOf(TWO_CRLF);
      if (idx === -1) return;
      const header = buffer.subarray(0, idx).toString();
      const match = header.match(/Content-Length:\s*(\d+)/i);
      if (!match) return;
      contentLength = parseInt(match[1], 10);
      buffer = buffer.subarray(idx + TWO_CRLF.length);
    }
    if (buffer.length < contentLength) return;
    const body = buffer.subarray(0, contentLength).toString();
    buffer = buffer.subarray(contentLength);
    contentLength = -1;
    handleMessage(JSON.parse(body));
  }
});

function send(msg) {
  const json = JSON.stringify(msg);
  const header = `Content-Length: ${Buffer.byteLength(json)}${TWO_CRLF}`;
  process.stdout.write(header + json);
}

let seq = 1;
let currentLine = 1;
const breakpoints = new Map();

function handleMessage(msg) {
  if (msg.type !== "request") return;

  switch (msg.command) {
    case "initialize":
      send({
        seq: seq++, type: "response", request_seq: msg.seq,
        command: "initialize", success: true,
        body: { supportsConfigurationDoneRequest: true, supportsEvaluateForHovers: true }
      });
      send({ seq: seq++, type: "event", event: "initialized", body: {} });
      break;

    case "setBreakpoints": {
      const file = msg.arguments.source.path;
      const bps = (msg.arguments.breakpoints || []).map((bp, i) => ({
        id: i + 1, verified: true, line: bp.line
      }));
      breakpoints.set(file, bps.map(bp => bp.line));
      send({
        seq: seq++, type: "response", request_seq: msg.seq,
        command: "setBreakpoints", success: true,
        body: { breakpoints: bps }
      });
      break;
    }

    case "setExceptionBreakpoints":
      send({
        seq: seq++, type: "response", request_seq: msg.seq,
        command: "setExceptionBreakpoints", success: true, body: {}
      });
      break;

    case "configurationDone":
      send({
        seq: seq++, type: "response", request_seq: msg.seq,
        command: "configurationDone", success: true, body: {}
      });
      break;

    case "launch":
      currentLine = 1;
      send({
        seq: seq++, type: "response", request_seq: msg.seq,
        command: "launch", success: true, body: {}
      });
      // Emit output
      send({
        seq: seq++, type: "event", event: "output",
        body: { category: "stdout", output: "Program started\n" }
      });
      // Stop on entry if requested
      if (msg.arguments.stopOnEntry) {
        setTimeout(() => {
          send({
            seq: seq++, type: "event", event: "stopped",
            body: { reason: "entry", threadId: 1, allThreadsStopped: true }
          });
        }, 50);
      }
      break;

    case "threads":
      send({
        seq: seq++, type: "response", request_seq: msg.seq,
        command: "threads", success: true,
        body: { threads: [{ id: 1, name: "MainThread" }] }
      });
      break;

    case "stackTrace":
      send({
        seq: seq++, type: "response", request_seq: msg.seq,
        command: "stackTrace", success: true,
        body: {
          stackFrames: [
            { id: 1, name: "main", source: { path: "/test/app.py" }, line: currentLine, column: 1 },
            { id: 2, name: "helper", source: { path: "/test/utils.py" }, line: 10, column: 1 },
          ],
          totalFrames: 2
        }
      });
      break;

    case "scopes":
      send({
        seq: seq++, type: "response", request_seq: msg.seq,
        command: "scopes", success: true,
        body: {
          scopes: [
            { name: "Locals", variablesReference: 100, expensive: false },
            { name: "Globals", variablesReference: 200, expensive: true },
          ]
        }
      });
      break;

    case "variables":
      if (msg.arguments.variablesReference === 100) {
        send({
          seq: seq++, type: "response", request_seq: msg.seq,
          command: "variables", success: true,
          body: {
            variables: [
              { name: "x", value: "42", type: "int", variablesReference: 0 },
              { name: "name", value: "'hello'", type: "str", variablesReference: 0 },
              { name: "data", value: "[1, 2, 3]", type: "list", variablesReference: 300 },
            ]
          }
        });
      } else {
        send({
          seq: seq++, type: "response", request_seq: msg.seq,
          command: "variables", success: true,
          body: { variables: [] }
        });
      }
      break;

    case "evaluate":
      send({
        seq: seq++, type: "response", request_seq: msg.seq,
        command: "evaluate", success: true,
        body: {
          result: "42",
          type: "int",
          variablesReference: 0
        }
      });
      break;

    case "continue":
      send({
        seq: seq++, type: "response", request_seq: msg.seq,
        command: "continue", success: true, body: { allThreadsContinued: true }
      });
      // Simulate running then stopping at a breakpoint
      currentLine += 5;
      setTimeout(() => {
        send({
          seq: seq++, type: "event", event: "stopped",
          body: { reason: "breakpoint", threadId: 1, allThreadsStopped: true }
        });
      }, 50);
      break;

    case "next":
      send({
        seq: seq++, type: "response", request_seq: msg.seq,
        command: "next", success: true, body: {}
      });
      currentLine++;
      setTimeout(() => {
        send({
          seq: seq++, type: "event", event: "stopped",
          body: { reason: "step", threadId: 1, allThreadsStopped: true }
        });
      }, 50);
      break;

    case "stepIn":
      send({
        seq: seq++, type: "response", request_seq: msg.seq,
        command: "stepIn", success: true, body: {}
      });
      currentLine++;
      setTimeout(() => {
        send({
          seq: seq++, type: "event", event: "stopped",
          body: { reason: "step", threadId: 1, allThreadsStopped: true }
        });
      }, 50);
      break;

    case "stepOut":
      send({
        seq: seq++, type: "response", request_seq: msg.seq,
        command: "stepOut", success: true, body: {}
      });
      setTimeout(() => {
        send({
          seq: seq++, type: "event", event: "stopped",
          body: { reason: "step", threadId: 1, allThreadsStopped: true }
        });
      }, 50);
      break;

    case "disconnect":
      send({
        seq: seq++, type: "response", request_seq: msg.seq,
        command: "disconnect", success: true, body: {}
      });
      setTimeout(() => process.exit(0), 50);
      break;

    default:
      send({
        seq: seq++, type: "response", request_seq: msg.seq,
        command: msg.command, success: true, body: {}
      });
  }
}
```

**Step 2: Write the integration test**

```typescript
// src/integration/debug-lifecycle.test.ts
import { describe, it, expect, afterEach } from "vitest";
import { DebugSession } from "../session/session.js";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MOCK_ADAPTER = path.join(__dirname, "../test-fixtures/mock-adapter.js");

describe("Debug Lifecycle Integration", () => {
  let session: DebugSession | undefined;

  afterEach(async () => {
    if (session && session.state !== "terminated") {
      try { await session.disconnect(); } catch { /* ignore */ }
    }
    session = undefined;
  });

  it("full debug lifecycle: launch, stop, inspect, step, evaluate, disconnect", async () => {
    session = new DebugSession("integ-1", {
      type: "mock",
      runtime: "node",
      program: MOCK_ADAPTER,
    });

    // Initialize
    const caps = await session.initialize();
    expect(caps.supportsConfigurationDoneRequest).toBe(true);
    expect(session.state).toBe("configuring");

    // Set breakpoints
    const bps = await session.setBreakpoints("/test/app.py", [{ line: 5 }, { line: 10 }]);
    expect(bps).toHaveLength(2);
    expect(bps[0].verified).toBe(true);

    // Configuration done + launch
    await session.configurationDone();
    await session.launch({ program: "/test/app.py", stopOnEntry: true });

    // Wait for stopped on entry
    const stoppedEvent = await session.waitForStopped(5000);
    expect(stoppedEvent.body.reason).toBe("entry");
    expect(session.state).toBe("stopped");

    // Collect composite state
    const state = await session.collectState(1, 10, 1);
    expect(state.status).toBe("stopped");
    expect(state.reason).toBe("entry");
    expect(state.threads).toHaveLength(1);
    expect(state.threads[0].name).toBe("MainThread");
    expect(state.stackTrace.length).toBeGreaterThan(0);
    expect(state.scopes.length).toBeGreaterThan(0);

    // Check variables
    const locals = state.scopes.find(s => s.name === "Locals");
    expect(locals).toBeDefined();
    expect(locals!.variables.some(v => v.name === "x" && v.value === "42")).toBe(true);
    expect(locals!.variables.some(v => v.name === "name")).toBe(true);

    // Step next
    await session.next(1);
    const stoppedAfterStep = await session.waitForStopped(5000);
    expect(stoppedAfterStep.body.reason).toBe("step");

    // Evaluate expression
    const evalResult = await session.evaluate("x + 1", 1);
    expect(evalResult.result).toBe("42");

    // Continue
    await session.continueExecution(1);
    const stoppedAtBp = await session.waitForStopped(5000);
    expect(stoppedAtBp.body.reason).toBe("breakpoint");

    // Check output
    const output = session.getOutput();
    expect(output.output.some(o => o.text.includes("Program started"))).toBe(true);

    // Disconnect
    await session.disconnect();
    expect(session.state).toBe("terminated");
  });

  it("handles adapter crash gracefully", async () => {
    const crashAdapter = path.join(__dirname, "../test-fixtures/crash-adapter.js");
    session = new DebugSession("integ-crash", {
      type: "mock",
      runtime: "node",
      program: crashAdapter,
    });

    await expect(session.initialize()).rejects.toThrow();
    expect(session.state).toBe("terminated");
  });
});
```

**Step 3: Run integration tests**

Run: `npx vitest run src/integration/`
Expected: all tests PASS

**Step 4: Run all tests**

Run: `npx vitest run`
Expected: all tests PASS

**Step 5: Commit**

```bash
git add src/test-fixtures/mock-adapter.js src/integration/
git commit -m "test: add integration tests for full debug lifecycle with mock adapter"
```

---

## Task 11: Adapter Availability Check

**Files:**
- Create: `src/adapters/detect.ts`
- Create: `src/adapters/detect.test.ts`

**Step 1: Write the failing test**

```typescript
// src/adapters/detect.test.ts
import { describe, it, expect } from "vitest";
import { checkAdapterAvailable } from "./detect.js";

describe("checkAdapterAvailable", () => {
  it("detects 'node' as available", async () => {
    const result = await checkAdapterAvailable("node");
    expect(result).toBe(true);
  });

  it("detects non-existent binary as unavailable", async () => {
    const result = await checkAdapterAvailable("definitely-not-a-real-binary-xyz");
    expect(result).toBe(false);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/adapters/detect.test.ts`
Expected: FAIL

**Step 3: Implement**

```typescript
// src/adapters/detect.ts
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function checkAdapterAvailable(command: string): Promise<boolean> {
  try {
    await execFileAsync("which", [command]);
    return true;
  } catch {
    return false;
  }
}
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run src/adapters/detect.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/adapters/detect.ts src/adapters/detect.test.ts
git commit -m "feat: add adapter binary availability detection"
```

---

## Task 12: Final Build, Full Test Suite, and Package

**Files:**
- Modify: `package.json` (add bin shebang support)
- Verify all tests pass
- Full build

**Step 1: Ensure shebang in index.ts**

Verify `src/index.ts` starts with `#!/usr/bin/env node`.

**Step 2: Build**

Run: `npm run build`
Expected: no errors, output in `build/`

**Step 3: Run full test suite**

Run: `npm test`
Expected: all tests PASS

**Step 4: Test the server manually with MCP Inspector (optional)**

Run: `npx @modelcontextprotocol/inspector node build/index.js`
Expected: Inspector UI opens, tools are listed

**Step 5: Commit**

```bash
git add -A
git commit -m "feat: complete dap-mcp-server v0.1.0"
```

---

## Summary

| Task | Component | Tests |
|------|-----------|-------|
| 1 | Project scaffolding | — |
| 2 | DAP types | — |
| 3 | Ring buffer | 5 unit tests |
| 4 | Protocol framing | 3 unit tests |
| 5 | DAP client | 4 unit tests |
| 6 | Adapter registry | 4 unit tests |
| 7 | Debug session | 4 unit tests |
| 8 | Session manager | 7 unit tests |
| 9 | MCP server + all 12 tools | — (covered by integration) |
| 10 | Integration tests | 2 integration tests |
| 11 | Adapter detection | 2 unit tests |
| 12 | Final build & verification | — |

Total: ~31 tests across 12 tasks.
