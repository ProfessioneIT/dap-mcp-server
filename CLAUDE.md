# DAP MCP Server — Project Instructions

## Project Overview

MCP server wrapping the Debug Adapter Protocol (DAP) for AI agent-driven debugging. TypeScript, Node.js, ESM modules.

## Key Architecture

- **MCP Layer** (`src/server.ts`, `src/index.ts`): McpServer with 12 tools + 1 resource via `@modelcontextprotocol/sdk`
- **Session Layer** (`src/session/`): `DebugSession` wraps a DAP client with state tracking, output buffering, composite state collection. `SessionManager` handles multi-session and auto-resolution.
- **DAP Layer** (`src/dap/`): `DAPClient` spawns adapter child processes (stdin/stdout), `MessageParser` handles Content-Length framing, `RingBuffer` for output.
- **Adapters** (`src/adapters/`): `AdapterRegistry` with built-in defaults + config file persistence.

## Commands

```bash
npm run build    # TypeScript compilation → build/
npm test         # vitest run (all tests)
npm run dev      # tsc --watch
npm start        # Run the MCP server
```

## Code Conventions

- ESM modules (`"type": "module"` in package.json)
- Import paths use `.js` extension (e.g., `import { Foo } from "./foo.js"`)
- Never `console.log()` in server code — use `console.error()` (stdout is MCP wire protocol)
- All tool execution errors use `isError: true` in MCP results, not JSON-RPC protocol errors
- Types from `@vscode/debugprotocol` for DAP message types
- Types in `src/dap/types.ts` for our internal/MCP-facing types

## Testing

- Framework: vitest
- Unit tests: co-located with source (`*.test.ts`)
- Integration tests: `src/integration/`
- Test fixtures: `src/test-fixtures/` (mock DAP adapters in plain JS)
- Run single file: `npx vitest run src/path/to/file.test.ts`

## Design Documents

- Design: `docs/plans/2026-03-05-dap-wrapper-mcp-design.md`
- Implementation plan: `docs/plans/2026-03-05-dap-wrapper-mcp-implementation.md`

## Key Design Decisions

1. **Coarse-grained tools**: `get_state` returns threads+stack+scopes+variables in one call
2. **Synchronous stepping**: `step` blocks until stopped, returns new state
3. **Auto-session resolution**: `sessionId` optional when single session active
4. **Output ring buffer**: 10K lines max, oldest dropped
5. **Own DAP client**: Custom implementation using `@vscode/debugprotocol` types (not `@vscode/debugadapter-testsupport`) for full control over event buffering and crash detection
