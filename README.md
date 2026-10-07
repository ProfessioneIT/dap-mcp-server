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
| Rust | lldb-dap (same `cppdbg` adapter) | as above, plus the Rust LLDB formatters (bundled with rustup toolchains; the `rust-lldb` package on distro-packaged Rust) |
| PHP | vscode-php-debug + xdebug 3 | Install xdebug, then point the `php` adapter's `program` at `out/phpDebug.js` |

Additional adapters, and project-specific paths for the built-ins, can be registered via `configure_adapter` or config files.

### Launch recipes are built in

The per-language incantations that usually stand between an agent and its first breakpoint ship with the server:

- **PHP** — the `php` adapter's `launchDefaults` carry the xdebug `runtimeArgs` and listen port. They are merged into a user-configured `php` entry, so you only supply the `phpDebug.js` path. If PHP still runs past a breakpoint, the result carries a `hint` pointing at xdebug.
- **Rust** — sessions that break in `.rs` files load `lldb_lookup.py` from the active toolchain's sysroot, so `String`, `&str`, `Vec` and `HashMap` render as values instead of raw structs. `debug_at` defaults `program` to `target/debug/<package name>`.
- **Go** — `cwd` is mirrored to `dlvCwd` so delve builds from the module directory.
- **Java / JDWP** — `debug_doctor` prints the `-agentlib:jdwp=…` line to start the JVM with; `debug_attach` accepts `breakpoints` so they bind before a `suspend=y` VM resumes.

`debug_doctor` and `debug_at` detect the language from manifests (`pyproject.toml`, `go.mod`, `Cargo.toml`, `composer.json`, `pom.xml`, `build.gradle`, `CMakeLists.txt`, `package.json`), from the breakpoint file's extension, and — for manifest-less script directories — from the source files in `cwd` and `cwd/src`.

## MCP Tools

| Tool | Description |
|------|-------------|
| `debug_doctor` | **Start here:** detect the project, recommend an adapter, verify its complete command, and return setup remediation. |
| `debug_at` | **Primary debugging call:** infer the adapter, stop at a line, evaluate expressions, and clean up. |
| `debug_inspect` | **One-shot:** launch → run to breakpoint → evaluate expressions → disconnect when the adapter is already known. |
| `debug_run` | **One-shot:** launch → run to completion → return all output. Combine with logpoints for printf-style debugging without editing source. |
| `debug_launch` | Start an interactive debug session (launch a program with breakpoints) |
| `debug_attach` | Attach to a running process; pass `breakpoints` / `exceptionBreakpoints` to bind them before it resumes |
| `debug_restart` | Restart with the same configuration |
| `debug_disconnect` | End a debug session |
| `set_breakpoints` | Set/replace breakpoints in a file (use `logMessage` for logpoints) |
| `set_exception_breakpoints` | Break on exceptions |
| `list_breakpoints` | List currently-registered breakpoints for a session |
| `get_state` | Get threads, stack trace, scopes, and variables (`scopes: ["Registers"]` to opt into CPU registers, `detail: "compact"` for a slim view) |
| `evaluate` | Evaluate an expression in the debuggee context |
| `step` | Continue, next, stepIn, stepOut, or pause; answers compactly by default (`detail: "full"` for the `get_state` shape) |
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

## Usage with Codex

Choose either direct MCP registration or the plugin; installing both exposes the same
debugger twice. The plugin also supplies the activation skill.

### Direct MCP registration

Register the stdio server in Codex CLI (the CLI and IDE extension share this configuration):

```bash
codex mcp add dap -- npx -y dap-mcp-server
codex mcp list
```

For a source checkout, build first and register the absolute entry-point path instead:

```bash
npm ci
npm run build
codex mcp add dap -- node "$(pwd)/build/index.js"
```

Direct registration exposes the tools but does not install the activation skill. To add
the skill to a project after a global npm install:

```bash
mkdir -p .agents/skills/dap-debugging
cp "$(npm root -g)/dap-mcp-server/SKILL.md" .agents/skills/dap-debugging/SKILL.md
```

### Plugin: MCP server and activation skill

The npm package also ships a Codex plugin that bundles the MCP declaration with the
`dap-debugging` activation skill. After a global install, register its marketplace and
install the plugin:

```bash
npm install -g dap-mcp-server
codex plugin marketplace add "$(npm root -g)/dap-mcp-server/integrations/codex"
codex plugin add dap-debugging@dap-mcp-server
```

From a source checkout, the marketplace path is `"$(pwd)/integrations/codex"`. The
plugin launches the published npm server via `npx`; use direct registration with
`build/index.js` to test changes to the server itself.

Start a new Codex session after installation. Ask Codex to run `debug_doctor` with the
project's absolute `cwd`, then use `debug_at` for one-shot breakpoint inspection.
The activation skill provides this workflow when installed. Debug adapters must still
be installed separately (see the supported-adapters table above).

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

Responses are budgeted for an LLM's context window:

- CPU register scopes are never fetched unless asked for by name; skipped scopes are listed in `omittedScopes`.
- `step` returns a compact state: frame-local scopes only, a 5-frame stack, no thread list for single-threaded programs, minified JSON.
- A state carries only output that no earlier `debug_launch`/`step` response has reported (capped at the newest 50 entries, with `outputOmitted`); `get_output` always has the whole buffer.
- `debug_doctor` details only the selected adapter (`verbose: true` for all); a not-ready `debug_at` answers with a one-line summary.

Stops on an exception include `exception: { id, description, breakMode }`. When the program ends, `debug_run`, `debug_at`, `debug_launch` and `step` report its `exitCode` if the adapter provides one.

Session IDs are optional when only one debug session is active. Breakpoints can be set inline with `debug_launch` for single-call debugging setup.

See [docs/plans/2026-03-05-dap-wrapper-mcp-design.md](docs/plans/2026-03-05-dap-wrapper-mcp-design.md) for the full design document.

## Configuration

Adapter configurations are stored in:
- `~/.dap-mcp/adapters.json` — global defaults
- `./.dap-mcp/adapters.json` — project-local overrides

## License

MIT
