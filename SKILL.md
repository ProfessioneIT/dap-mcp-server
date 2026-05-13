---
name: dap-debugging
description: Use when debugging a program — when you need to set breakpoints, step through code, inspect variables, or understand runtime behavior instead of guessing with print statements.
---

# Debugging with DAP MCP Server

You have access to a real debugger via the `dap` MCP server. **Use it instead of adding print/log statements** whenever you need to understand runtime behavior, track down a bug, or verify a fix.

## When to switch from print() to the debugger

Reach for the debugger — don't keep guessing — when any of these are true:

- **Your first fix attempt was wrong.** Stop iterating on guesses. Inspect actual values.
- **You're about to add 3+ print statements.** Use a logpoint instead (see below) — same information, no code edits.
- **You need a value on iteration N of a loop.** Use `hitCondition: "N"` instead of conditional prints.
- **A test fails with a non-obvious traceback.** Launch the test under the debugger; you'll see locals at the failure site.
- **You're reasoning about state that's modified across many call sites.** A conditional breakpoint on the value beats grepping for assignments.

Print debugging is fine for: trivial one-line checks, scripts you'll throw away in the next message, or when you genuinely just want to see "did this code path execute?".

## Logpoints — print debugging without editing code

A **logpoint** is a breakpoint that doesn't pause execution. It just emits a formatted message every time it's hit. This is the single most useful feature for AI agents.

Set it via the `logMessage` field on a breakpoint:

```
set_breakpoints({
  file: "/abs/path/src/foo.py",
  breakpoints: [
    { line: 42, logMessage: "x={x} y={y} state={self.state}" },
    { line: 88, logMessage: "iteration {i}: items={len(items)}" }
  ]
})
```

Then `step({ action: "continue" })` and let the program run. Retrieve every log with `get_output`. You get the same information as inserting `print(f"x={x} y={y}")` at five places — without touching the source file, without re-running, and with the program's natural execution preserved.

**When to use logpoints over breakpoints**: when you want to *observe* values across many hits rather than *interrupt* execution to inspect one. They are the right tool ~70% of the time.

Expression syntax inside `{...}` depends on the adapter (debugpy: Python; node: JS). The expression is evaluated in the breakpoint's scope.

## Debugging a failing test

This is the dominant case. Use the test runner as the program, with the specific test as an argument.

### pytest

```
debug_launch({
  adapter: "python",
  program: "/abs/path/.venv/bin/pytest",
  args: ["tests/test_foo.py::test_bar", "-x", "--no-header"],
  cwd: "/abs/path",
  breakpoints: [{ file: "/abs/path/src/foo.py", line: 42 }],
  stopOnEntry: false,
})
```

For pytest, also consider setting `exceptionBreakpoints: ["raised"]` — pytest swallows exceptions before you see them, but the debugger will stop at the raise site.

### vitest / jest (Node.js)

Requires the `node` adapter configured (see "Node.js setup" below). Use the runner binary from `node_modules/.bin`:

```
debug_launch({
  adapter: "node",
  program: "${cwd}/node_modules/.bin/vitest",
  args: ["run", "tests/foo.test.ts", "-t", "the failing test name"],
  cwd: "/abs/path",
  breakpoints: [{ file: "/abs/path/src/foo.ts", line: 42 }],
  stopOnEntry: false,
})
```

### go test

```
debug_launch({
  adapter: "go",
  program: "${cwd}",   // delve takes a package dir, not a binary
  args: ["-test.run", "TestFoo", "-test.v"],
  cwd: "/abs/path",
  breakpoints: [{ file: "/abs/path/foo.go", line: 42 }],
  stopOnEntry: false,
})
```

Delve uses `dlv test` semantics under the hood when the program is a package directory containing test files.

### Node.js setup

If `list_adapters` shows no `node` entry, register it once (path depends on installed extension):

```
configure_adapter({
  type: "node",
  runtime: "node",
  program: "/abs/path/to/js-debug/src/dapDebugServer.js",
  args: [],
  scope: "global",
})
```

`js-debug-dap` ships with the VS Code Node debugger extension. Alternatively use `@vscode/js-debug` from npm.

## Quick Start (single-file program)

1. `list_adapters` — see what's installed.
2. Launch with breakpoints in one call:

```
debug_launch({
  adapter: "python",
  program: "/abs/path/file.py",
  stopOnEntry: false,
  breakpoints: [{ file: "/abs/path/file.py", line: 42 }],
})
```

3. The response already contains the full state (threads, stack, scopes, variables) when the breakpoint is hit. No follow-up `get_state` needed.
4. Step with `step({ action: "next" })` — response includes the new state.
5. `evaluate({ expression: "len(items)" })` for ad-hoc inspection.
6. `debug_disconnect` when done.

## Stepping strategy

- **`next`** (step over) is the default choice. Use it unless you have a specific reason not to.
- **`stepIn`** only when you suspect the bug is *inside* the function being called — not at the call site. Stepping into library code will get you lost fast.
- **`stepOut`** to bail out of a function you stepped into by mistake.
- **`continue`** to run to the next breakpoint. With logpoints set, this is how you collect runtime traces.

If you find yourself stepping line-by-line for more than ~10 steps, you're probably doing it wrong. Set a breakpoint at the next interesting location and continue to it.

## Worked example

Bug: `compute_total(items)` returns `0` when items contain a tax-exempt entry.

```
# Launch under pytest with a breakpoint at the suspect line
debug_launch({
  adapter: "python",
  program: "/proj/.venv/bin/pytest",
  args: ["tests/test_billing.py::test_tax_exempt", "-x"],
  cwd: "/proj",
  breakpoints: [{ file: "/proj/src/billing.py", line: 57 }],
  stopOnEntry: false,
})

# Response (paraphrased):
# {
#   sessionId: "s-1",
#   status: "stopped",
#   location: { file: ".../billing.py", line: 57, functionName: "compute_total" },
#   scopes: [{ name: "Locals", variables: [
#     { name: "items", value: "[{...}, {...}]", ... },
#     { name: "subtotal", value: "100", ... },
#     { name: "tax", value: "0", ... }
#   ] }]
# }

# Inspect the exempt item more closely
evaluate({ expression: "[i for i in items if i.get('tax_exempt')]" })
# → [{name: 'book', price: 100, tax_exempt: True}]

# Step over to see what compute_total actually returns
step({ action: "next" })
# → see that `total = subtotal + tax` returns 100, not 0. Bug is upstream.

# Continue to verify nothing else changes the return
step({ action: "continue" })

debug_disconnect()
```

Fix locally, re-run the test, done.

## Key Rules

- **Do NOT call `get_state` after `step`** — `step` already returns the new stopped state.
- **Omit `sessionId`** when only one debug session is active.
- **Use absolute paths** for `program` and breakpoint `file` parameters.
- **Prefer `stopOnEntry: false` with breakpoints** — it gets you directly to the interesting code.
- **Use `get_output`** for program stdout/stderr (including logpoint output).

## Debugging Strategies

### Narrowing down a bug
1. Set a breakpoint where state is known good.
2. Set another where state is wrong.
3. Use `step` with `next` to walk between them, or set intermediate logpoints.

### Understanding a crash
1. Launch with `exceptionBreakpoints: ["uncaughtExceptions"]` (or `"raised"` for any raise).
2. When stopped at the exception, inspect stack and locals.

### Verifying a fix
1. Set a breakpoint at the fixed code.
2. Run to it, inspect variables, confirm new behavior.
3. Continue to verify the program completes successfully.

### Observing a hot loop without stopping it
1. Set logpoints at the relevant lines with `{i}` and any state expression.
2. `continue`.
3. Read the trace via `get_output`. For long-running programs, poll incrementally:
   pass the `nextSince` value from each call as the `since` parameter of the next call
   to receive only newly-emitted entries.
