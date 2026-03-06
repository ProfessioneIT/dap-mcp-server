---
name: dap-debugging
description: Use when debugging a program — when you need to set breakpoints, step through code, inspect variables, or understand runtime behavior instead of guessing with print statements.
---

# Debugging with DAP MCP Server

You have access to a real debugger via the `dap` MCP server. **Use it instead of adding print/log statements** whenever you need to understand runtime behavior, track down a bug, or verify a fix.

## When to Use the Debugger

- A test fails and the cause is not obvious from the error message or stack trace
- You need to inspect the value of variables at a specific point in execution
- You suspect a logic error in a loop, conditional, or data transformation
- A function returns an unexpected result and you want to trace the execution path
- You want to verify your fix actually changes behavior at the right point

## Quick Start

1. Check available adapters: call `list_adapters` to see what's installed.
2. Launch with breakpoints in a single call:

```
debug_launch({
  adapter: "python",         // or "node", "go", "cpp"
  program: "/absolute/path/to/file.py",
  stopOnEntry: false,
  breakpoints: [
    { file: "/absolute/path/to/file.py", line: 42 }
  ]
})
```

3. When the program stops, the response already contains the full state (threads, stack, scopes, variables). Read it — no extra call needed.
4. Step through code with `step({ action: "next" })` — the response includes the new state.
5. Evaluate expressions with `evaluate({ expression: "len(items)" })`.
6. When done, call `debug_disconnect`.

## Key Rules

- **Do NOT call `get_state` after `step`** — `step` already returns the new stopped state.
- **Omit `sessionId`** when only one debug session is active — the server resolves it automatically.
- **Use absolute paths** for `program` and breakpoint `file` parameters.
- **Prefer `stopOnEntry: false` with breakpoints** over `stopOnEntry: true` — it gets you directly to the interesting code.
- **Check `get_output`** for program stdout/stderr if you need to see what the program printed.

## Debugging Strategies

### Narrowing down a bug
1. Set a breakpoint where you know the state is still correct.
2. Set another breakpoint where the state is wrong.
3. Use `step` with `action: "next"` to walk through the code between them.
4. Use `evaluate` to check intermediate values.

### Understanding a crash
1. Launch with `exceptionBreakpoints: ["uncaughtExceptions"]`.
2. When it stops on the exception, inspect the stack and variables.

### Verifying a fix
1. Set a breakpoint at the fixed code.
2. Run to it, inspect variables, confirm the new behavior.
3. Continue to verify the program completes successfully.
