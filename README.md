# dap-mcp-server

An MCP (Model Context Protocol) server that wraps the Debug Adapter Protocol (DAP), enabling AI agents to use real debuggers instead of relying on print statements and log analysis.

## What This Is

When AI coding agents encounter bugs, they typically resort to adding `console.log` statements or reading stack traces. This MCP server gives them access to actual debuggers — setting breakpoints, stepping through code, inspecting variables, and evaluating expressions — through any debug adapter that implements DAP.

The server spawns debug adapters as child processes and exposes a small set of coarse-grained MCP tools optimized for how an AI agent thinks about debugging: "launch this program, stop here, show me what's happening."

## Supported Debug Adapters

Any DAP-compliant debug adapter works. Built-in defaults for:

| Language | Adapter | Install |
|----------|---------|---------|
| Python | debugpy | `pip install debugpy` |
| Go | Delve | `go install github.com/go-delve/delve/cmd/dlv@latest` |
| Node.js / TypeScript | vscode-js-debug | Configure its `dapDebugServer.js` path or install it in the project |
| C/C++ | lldb-dap | `apt install lldb` / `brew install llvm` |

Additional adapters, and project-specific paths for the built-ins, can be registered via `configure_adapter` or config files.

## MCP Tools

| Tool | Description |
|------|-------------|
| `debug_doctor` | **Start here:** detect the project, recommend an adapter, verify its complete command, and return setup remediation. |
| `debug_at` | **Primary debugging call:** infer the adapter, stop at a line, evaluate expressions, and clean up. |
| `debug_inspect` | **One-shot:** launch → run to breakpoint → evaluate expressions → disconnect when the adapter is already known. |
| `debug_run` | **One-shot:** launch → run to completion → return all output. Combine with logpoints for printf-style debugging without editing source. |
| `debug_launch` | Start an interactive debug session (launch a program with breakpoints) |
| `debug_attach` | Attach to a running process |
| `debug_restart` | Restart with the same configuration |
| `debug_disconnect` | End a debug session |
| `set_breakpoints` | Set/replace breakpoints in a file (use `logMessage` for logpoints) |
| `set_exception_breakpoints` | Break on exceptions |
| `list_breakpoints` | List currently-registered breakpoints for a session |
| `get_state` | Get threads, stack trace, scopes, and variables |
| `evaluate` | Evaluate an expression in the debuggee context |
| `step` | Continue, next, stepIn, stepOut, or pause |
| `get_output` | Get buffered stdout/stderr |
| `configure_adapter` | Register a custom debug adapter |
| `list_adapters` | List available adapters |

## Installation

```bash
npm install -g dap-mcp-server
```

Or from source:

```bash
git clone <repo-url>
cd dap-mcp-server
npm install
npm run build
```

## Usage with Claude Code

Register the server for the current user:

```bash
claude mcp add --scope user dap -- npx -y dap-mcp-server
```

The repository also contains a Claude Code plugin that bundles the MCP declaration and the activation skill. During local development, validate and load it with:

```bash
claude plugin validate integrations/claude/dap-debugging
claude --plugin-dir ./integrations/claude/dap-debugging
```

To configure MCP manually, use a project `.mcp.json`:

```json
{
  "mcpServers": {
    "dap": {
      "command": "npx",
      "args": ["-y", "dap-mcp-server"]
    }
  }
}
```

Or if installed globally:

```json
{
  "mcpServers": {
    "dap": {
      "command": "dap-mcp-server"
    }
  }
}
```

A `SKILL.md` file is included in the package. After a local package install, copy it to the required skill directory layout:

```bash
mkdir -p .claude/skills/dap-debugging
cp node_modules/dap-mcp-server/SKILL.md .claude/skills/dap-debugging/SKILL.md
```

For a global npm install, the source file is under `$(npm root -g)/dap-mcp-server/SKILL.md`, not the project's `node_modules`.

## Design

Tools are deliberately coarse-grained. `debug_doctor` makes setup failures actionable and `debug_at` performs the common detect → launch → stop → inspect → cleanup workflow in one call. A single `get_state` call returns threads, stack trace, scopes, and variables. The `step` tool blocks until the debuggee stops again and returns the new state.

Session IDs are optional when only one debug session is active. Breakpoints can be set inline with `debug_launch` for single-call debugging setup.

See [docs/plans/2026-03-05-dap-wrapper-mcp-design.md](docs/plans/2026-03-05-dap-wrapper-mcp-design.md) for the full design document.

## Configuration

Adapter configurations are stored in:
- `~/.dap-mcp/adapters.json` — global defaults
- `./.dap-mcp/adapters.json` — project-local overrides

## License

MIT
