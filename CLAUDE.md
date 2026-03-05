# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

MCP server wrapping the Debug Adapter Protocol (DAP) for AI agent-driven debugging. TypeScript, Node.js, ESM modules.

## Commands

```bash
npm run build          # TypeScript compilation → build/
npm test               # vitest run (all tests)
npm run test:watch     # vitest in watch mode
npm run dev            # tsc --watch
npm start              # Run the MCP server (stdio transport)
npx vitest run src/path/to/file.test.ts   # Run a single test file
```

## Architecture

Three layers, top to bottom:

1. **MCP Layer** (`src/server.ts`, `src/index.ts`) — `McpServer` with 12 tools + 1 resource (`dap://sessions`). All tool handlers return `{ content: [{ type: "text", text: JSON.stringify(...) }] }` with `isError: true` on failure. Entry point connects via `StdioServerTransport`.

2. **Session Layer** (`src/session/`) — `DebugSession` wraps a `DAPClient` with state machine (`idle → configuring → running ↔ stopped → terminated`), output buffering (`RingBuffer<OutputEntry>`), and composite state collection (`collectState()` fetches threads + stack + scopes + variables in one call). `SessionManager` handles multi-session tracking with auto-resolution (single active session doesn't need explicit ID).

3. **DAP Layer** (`src/dap/`) — `DAPClient` spawns adapter as child process, communicates via stdin/stdout using DAP wire protocol (Content-Length headers + JSON bodies, same framing as LSP). `MessageParser` handles incremental parsing. `DAPClient` extends `EventEmitter`, emitting DAP events and tracking pending request/response correlation by sequence number.

4. **Adapters** (`src/adapters/`) — `AdapterRegistry` with three tiers: builtins (`builtin.ts`) < global (`~/.dap-mcp/adapters.json`) < project (`./.dap-mcp/adapters.json`). Higher tiers override lower. `detect.ts` checks adapter binary availability via `which`/`where`.

### Request Lifecycle

`MCP tool call → server.ts handler → SessionManager.resolve(sessionId) → DebugSession method → DAPClient.sendRequest(command, args) → serialize to DAP wire format → adapter stdin → adapter stdout → MessageParser → response correlation by seq number → resolve Promise`

Events flow the reverse direction: adapter emits events → `DAPClient` re-emits → `DebugSession.handleEvent()` updates state machine, resolves waiters, buffers output.

## Code Conventions

- ESM modules (`"type": "module"` in package.json)
- Import paths use `.js` extension (e.g., `import { Foo } from "./foo.js"`)
- Never `console.log()` in server code — stdout is MCP wire protocol; use `console.error()` for diagnostics
- All tool execution errors use `isError: true` in MCP results, not JSON-RPC protocol errors
- Types from `@vscode/debugprotocol` for DAP message types
- Internal/MCP-facing types in `src/dap/types.ts`

## Testing

- Framework: vitest (no config file — uses defaults)
- Unit tests: co-located with source (`*.test.ts`)
- Integration tests: `src/integration/` — test full DAP lifecycle against mock adapters
- Test fixtures: `src/test-fixtures/` — mock DAP adapters written in **plain JS** (not TypeScript), implementing enough of the DAP protocol to test against. `mock-adapter.js` is the full-featured one; `crash-adapter.js` and `silent-adapter.js` test error cases.

## Key Design Decisions

1. **Coarse-grained tools**: `get_state` returns threads+stack+scopes+variables in one call to minimize AI agent round-trips
2. **Synchronous stepping**: `step` blocks until stopped, returns new state
3. **Auto-session resolution**: `sessionId` optional when single session active
4. **Output ring buffer**: 10K lines max, oldest dropped
5. **Own DAP client**: Custom implementation (not `@vscode/debugadapter-testsupport`) for full control over event buffering and crash detection

## Design Documents

- Design: `docs/plans/2026-03-05-dap-wrapper-mcp-design.md`
- Implementation plan: `docs/plans/2026-03-05-dap-wrapper-mcp-implementation.md`
