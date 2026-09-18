---
name: dap-debugging
description: Use a real debugger for opaque test failures, crashes, swallowed exceptions, incorrect runtime state, or a bug that remains unexplained after static inspection or a failed fix. Prefer this over adding multiple print statements when actual values, branches, or call stacks are needed.
---

# Debug Code with DAP

Use the `dap` MCP server as the default next step when static evidence is insufficient. It can stop a local program at a source line, inspect stack frames and variables, evaluate expressions, and collect output without editing the source.

Do not invoke a debugger for syntax errors, obvious type errors, or failures already explained completely by a short traceback. Debugging executes local code and may trigger the program's normal side effects; do not run untrusted targets.

## Preferred Workflow

1. Call `debug_doctor` with the project `cwd`. It detects project signals, recommends an adapter, validates the complete adapter command, and returns exact remediation if setup is incomplete.
2. Select an executable code line close to where the first incorrect value is observable. Avoid comments, declarations without executable code, and lines that the failing path never reaches.
3. Call `debug_at` with the source `file`, `line`, and only the expressions needed to test the current hypothesis. Omit `adapter` unless doctor recommends overriding detection.

```json
{
  "cwd": "/workspace/project",
  "program": "/workspace/project/app.py",
  "file": "/workspace/project/app.py",
  "line": 42,
  "expressions": ["request.user", "result", "len(items)"]
}
```

Interpret the result before changing code:

- `hit: true` includes the stopped location, evaluated values, and captured output.
- `status: terminated` means execution finished before reaching the line; verify the program, arguments, path, and branch.
- `timedOut: true` means it neither stopped nor terminated in time; inspect output and narrow the target.
- With `hit: false`, `breakpoint.verified: false` means the adapter could not bind that source location; move to executable code or verify source mapping.

Use `launchConfig` for adapter-specific DAP fields such as a module, request type, runtime executable, or source-map option.

## Failing Tests

Run the smallest failing test, not the full suite. Pass the test runner as `program` (or through adapter-specific `launchConfig`) and the test selector in `args`. Test-runner launch semantics vary by adapter, so use `debug_doctor` first and preserve known-good fields from `.vscode/launch.json` in `launchConfig`.

Choose a breakpoint in application code before the assertion or exception boundary. For exceptions hidden by a test framework, use an interactive launch and `set_exception_breakpoints`.

## Interactive Exploration

Use `debug_launch` only when one-shot inspection is insufficient, such as multiple stops or step-by-step control. With breakpoints, it waits by default and explicitly reports stopped, terminated, or timeout.

1. `debug_launch` with breakpoints and optional `launchConfig`.
2. Inspect the returned state; do not immediately duplicate it with `get_state`.
3. Use `evaluate` for a focused question.
4. Use `step` with `next` by default; use `stepIn` only when the called function is suspect.
5. Use `set_breakpoints` to move or add breakpoints.
6. Always finish with `debug_disconnect`.

Omit `sessionId` when exactly one session is active. Use absolute paths for programs and source files.

## Output-First Debugging

Use `debug_run` when completion status and stdout/stderr are sufficient. For repeated observations without pausing, create logpoints with `set_breakpoints` and `logMessage`, continue execution, then read `get_output`. This provides runtime traces without modifying source files.

If doctor reports an unavailable adapter, follow its `nextSteps` before retrying. Do not repeatedly launch a configuration that readiness checks have already rejected.
