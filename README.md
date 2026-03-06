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
| C/C++ | lldb-dap | `apt install lldb` / `brew install llvm` |

Additional adapters (e.g. Node.js via js-debug) can be registered via the `configure_adapter` tool or config files.

## MCP Tools

| Tool | Description |
|------|-------------|
| `debug_launch` | Start a debug session (launch a program with breakpoints) |
| `debug_attach` | Attach to a running process |
| `debug_restart` | Restart with the same configuration |
| `debug_disconnect` | End a debug session |
| `set_breakpoints` | Set/replace breakpoints in a file |
| `set_exception_breakpoints` | Break on exceptions |
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

Add to your MCP configuration (`~/.claude/mcp.json` or project `.mcp.json`):

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

A `SKILL.md` file is included in the package. Copy it to `.claude/skills/` in your project to teach Claude Code when and how to use the debugger:

```bash
mkdir -p .claude/skills
cp node_modules/dap-mcp-server/SKILL.md .claude/skills/dap-debugging.md
```

## Design

Tools are deliberately coarse-grained. A single `get_state` call returns threads, stack trace, scopes, and variables — instead of requiring 4 separate calls. The `step` tool blocks synchronously until the debuggee stops again and returns the new state. This minimizes round-trips for AI agents that think in terms of "step forward and show me what happened."

Session IDs are optional when only one debug session is active. Breakpoints can be set inline with `debug_launch` for single-call debugging setup.

See [docs/plans/2026-03-05-dap-wrapper-mcp-design.md](docs/plans/2026-03-05-dap-wrapper-mcp-design.md) for the full design document.

## Configuration

Adapter configurations are stored in:
- `~/.dap-mcp/adapters.json` — global defaults
- `./.dap-mcp/adapters.json` — project-local overrides

## License

MIT
