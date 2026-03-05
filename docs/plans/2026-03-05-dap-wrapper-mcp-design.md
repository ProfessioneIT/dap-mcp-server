# DAP Wrapper MCP Server — Design Document

**Date**: 2026-03-05
**Status**: Approved

## Purpose

An MCP server that wraps the Debug Adapter Protocol (DAP), enabling AI agents (Claude, etc.) to use real debuggers instead of relying on print statements and log analysis. The server spawns debug adapters as child processes and exposes a coarse-grained set of MCP tools optimized for agent-driven debugging workflows.

## Decisions

- **Language**: TypeScript (Node.js)
- **Transport**: MCP over stdio; DAP over child process stdin/stdout
- **Adapter management**: Config-based with a registration tool + built-in defaults for Python (debugpy), Node.js (js-debug), Go (delve), C/C++ (lldb-dap)
- **Tool granularity**: Coarse-grained (~12 tools), composite responses
- **Execution model**: Synchronous stepping with configurable timeout — `step` blocks until the debuggee stops and returns the new state

## Architecture

```
┌──────────────────────────────────────────────────┐
│                MCP Server (Node.js)               │
│                                                   │
│  ┌──────────┐  ┌─────────────────────────────┐   │
│  │ Adapter   │  │ Session Manager              │   │
│  │ Registry  │  │                              │   │
│  │           │  │  Session ──► DAP Client ─────┼───┼──► adapter (child process)
│  │ - python  │  │    • state (running/stopped) │   │      (stdin/stdout)
│  │ - node    │  │    • breakpoints map         │   │
│  │ - go      │  │    • output ring buffer      │   │
│  │ - cppdbg  │  │    • event queue             │   │
│  │ - custom  │  │    • focused thread          │   │
│  └──────────┘  └─────────────────────────────┘   │
│                                                   │
│  ┌───────────────────────────────────────────┐   │
│  │ MCP Layer (stdio transport)                │   │
│  │  - 12 Tool handlers                        │   │
│  │  - Resource: dap://sessions                │   │
│  └───────────────────────────────────────────┘   │
└──────────────────────────────────────────────────┘
```

### Components

1. **Adapter Registry** — Stores adapter configurations. Each config: `type`, `runtime` (optional), `program` (path to adapter binary), `args`, `launchDefaults`. Built-in defaults for common adapters. Persisted to `~/.dap-mcp/adapters.json` (global) and `./.dap-mcp/adapters.json` (project-local).

2. **Session Manager** — Manages active debug sessions. Each session owns a `DAPClient`, tracks state (`idle | configuring | running | stopped | terminated`), maintains breakpoints map, buffers output in a ring buffer (10,000 lines max), and handles adapter crash detection.

3. **DAP Client** — Low-level protocol handler. Spawns adapter child process, sends/receives DAP messages with `Content-Length` framing, correlates request/response by `seq`, emits events to the session. Includes startup timeout (10s default).

4. **MCP Layer** — Registers tools, handles tool calls, serves the `dap://sessions` resource.

## Tools (12)

### Session Lifecycle

#### `debug_launch`
Start a new debug session by launching a program.

```typescript
Input: {
  adapter: string,                    // "python" | "node" | "go" | "cppdbg" | custom
  program: string,
  args?: string[],
  cwd?: string,
  env?: Record<string, string>,
  stopOnEntry?: boolean,              // default: true
  breakpoints?: Array<{
    file: string,
    lines: Array<{
      line: number,
      condition?: string,
      hitCondition?: string,
      logMessage?: string
    }>
  }>,
  exceptionBreakpoints?: string[],    // e.g., ["uncaught"]
  adapterConfig?: Record<string, any> // pass-through to adapter
}
Output: { sessionId: string, state: StoppedState | RunningState }
```

#### `debug_attach`
Attach to a running process.

```typescript
Input: {
  adapter: string,
  processId?: number,
  host?: string,
  port?: number,
  adapterConfig?: Record<string, any>
}
Output: { sessionId: string, state: StoppedState | RunningState }
```

#### `debug_restart`
Restart the current debug session with the same configuration.

```typescript
Input: { sessionId?: string }
Output: { sessionId: string, state: StoppedState | RunningState }
```

#### `debug_disconnect`
End a debug session.

```typescript
Input: {
  sessionId?: string,
  terminateDebuggee?: boolean         // default: true for launch, false for attach
}
Output: { success: boolean }
```

### Breakpoints

#### `set_breakpoints`
Set or replace breakpoints in a source file. Replaces all breakpoints in the specified file (DAP semantics).

```typescript
Input: {
  sessionId?: string,
  file: string,
  breakpoints: Array<{
    line: number,
    condition?: string,
    hitCondition?: string,
    logMessage?: string
  }>
}
Output: {
  breakpoints: Array<{
    id: number,
    verified: boolean,
    line: number,
    message?: string
  }>
}
```

#### `set_exception_breakpoints`
Configure which exceptions cause the debugger to break.

```typescript
Input: {
  sessionId?: string,
  filters: string[]                   // adapter-specific, e.g., ["uncaught", "raised"]
}
Output: { filters: string[] }
```

### State Inspection

#### `get_state`
Get current debuggee state. When stopped: threads + stack trace + scopes + variables. When running: status + buffered output.

```typescript
Input: {
  sessionId?: string,
  threadId?: number,                  // default: thread that triggered stop
  depth?: number,                     // stack frames to return, default 10
  variableDepth?: number,             // nested expansion depth, default 1
  timeout?: number                    // ms to wait if running, default 0
}
Output: StoppedState | RunningState
```

#### `evaluate`
Evaluate an expression in the debuggee's context.

```typescript
Input: {
  sessionId?: string,
  expression: string,
  frameId?: number,                   // default: top frame
  context?: "repl" | "watch" | "hover"  // default: "repl"
}
Output: {
  result: string,
  type?: string,
  hasChildren: boolean,
  variablesReference: number
}
```

#### `get_output`
Get buffered program output.

```typescript
Input: {
  sessionId?: string,
  category?: "stdout" | "stderr" | "console",  // default: all
  clear?: boolean                     // clear buffer after reading, default false
}
Output: {
  output: Array<{ category: string, text: string, timestamp: string }>,
  truncated: boolean
}
```

### Execution Control

#### `step`
Control execution. Synchronous: blocks until debuggee stops or timeout.

```typescript
Input: {
  sessionId?: string,
  action: "continue" | "next" | "stepIn" | "stepOut" | "pause",
  threadId?: number,
  timeout?: number                    // ms, default 30000
}
Output: StoppedState | { status: "running", elapsedMs: number }
```

### Adapter Management

#### `configure_adapter`
Register or update a debug adapter configuration.

```typescript
Input: {
  type: string,                       // adapter identifier
  runtime?: string,                   // e.g., "node", "python3"
  program: string,                    // path to adapter binary/script
  args?: string[],
  launchDefaults?: Record<string, any>,
  scope?: "global" | "project"        // default: "project"
}
Output: { success: boolean }
```

#### `list_adapters`
List available debug adapter configurations with availability status.

```typescript
Input: {}
Output: {
  adapters: Array<{
    type: string,
    source: "builtin" | "global" | "project",
    available: boolean,               // binary exists on system
    program: string,
    installHint?: string              // e.g., "pip install debugpy"
  }>
}
```

## Common Response Types

```typescript
interface StoppedState {
  status: "stopped";
  reason: "breakpoint" | "step" | "exception" | "pause" | "entry";
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

interface RunningState {
  status: "running";
  output?: string[];
}
```

## Built-in Adapter Defaults

| Type | Adapter | Detection | Install Hint |
|---|---|---|---|
| `python` | debugpy | `python3 -c "import debugpy"` | `pip install debugpy` |
| `node` | js-debug-dap | `which js-debug-dap` or bundled | Ships with MCP |
| `go` | delve | `which dlv` | `go install github.com/go-delve/delve/cmd/dlv@latest` |
| `cppdbg` | lldb-dap | `which lldb-dap` | `apt install lldb` / `brew install llvm` |

## Error Handling

All execution errors use MCP's `isError: true` in tool results (not JSON-RPC protocol errors), so the AI can read and self-correct.

| Scenario | Behavior |
|---|---|
| Adapter binary not found | `isError: true` with install instructions |
| Adapter crash (child exit) | Session marked `terminated`, stderr in error message |
| DAP protocol error | Adapter's error message surfaced verbatim |
| Timeout on step/continue | Return `{ status: "running", elapsedMs }` — not an error |
| Invalid session ID | Error listing available sessions |
| Expression eval failure | Adapter's error message (e.g., "NameError: ...") |

## MCP Resource

- `dap://sessions` — List of active sessions with status summary. Subscribable (emits `notifications/resources/updated` on session state changes).

## Config Files

- `~/.dap-mcp/adapters.json` — Global adapter configurations
- `./.dap-mcp/adapters.json` — Project-local adapter overrides (takes precedence)

## Key Design Principles

1. **One call, maximum info**: Composite responses (stack + variables + threads) reduce round-trips
2. **Smart defaults**: Auto-select single session, auto-select stopped thread, `stopOnEntry: true`
3. **Errors are information**: Execution errors in results (not protocol errors) let the AI self-correct
4. **Bounded resources**: Output ring buffer (10K lines), variable depth limits, stack frame limits
5. **Crash resilience**: Adapter process monitoring with clear error reporting
