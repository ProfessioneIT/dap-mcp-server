---
name: dap-debugging
description: Use a real debugger for opaque test failures, crashes, swallowed exceptions, incorrect runtime state, or a bug that remains unexplained after static inspection or a failed fix. Prefer this over adding multiple print statements when actual values, branches, or call stacks are needed.
---

# Debug Code with DAP

Use the `dap` MCP server when static inspection cannot explain a runtime failure. Debugging executes local code and can trigger its normal side effects, so do not run untrusted targets.

## Preferred Workflow

1. Call `debug_doctor` with the project `cwd`. Follow its remediation when `ready` is false.
2. Choose an executable line near the first observable bad state.
3. Call `debug_at` with `file`, `line`, and a small set of hypothesis-driven `expressions`. It detects the adapter, launches, inspects, and cleans up in one call.

```json
{
  "cwd": "/workspace/project",
  "program": "/workspace/project/app.py",
  "file": "/workspace/project/app.py",
  "line": 42,
  "expressions": ["request.user", "result"]
}
```

Read the outcome precisely:

- `hit: true`: use the location and values as evidence.
- `status: terminated`: execution finished before the breakpoint; verify path, arguments, and branch.
- `timedOut: true`: inspect captured output and narrow the target.
- With `hit: false`, `breakpoint.verified: false` means the adapter could not bind the source location.

Pass adapter-specific fields through `launchConfig`. Use absolute program and source paths.

## Failing Tests

Debug the smallest failing test. Supply its runner as `program` or through `launchConfig`, and its selector in `args`. Launch conventions differ across adapters; retain known-good fields from `.vscode/launch.json`. Put the breakpoint in application code before the assertion or exception boundary.

## Interactive Exploration

Use `debug_launch` only for multiple stops or stepping. A launch with breakpoints waits by default and reports stopped, terminated, or timeout.

1. Inspect the state returned by `debug_launch`.
2. Use `evaluate` for focused questions.
3. Prefer `step` with `next`; use `stepIn` only when the callee is suspect.
4. Move breakpoints with `set_breakpoints` as the hypothesis changes.
5. Finish with `debug_disconnect`.

Omit `sessionId` when one session is active. Use `debug_run` when output and termination are sufficient. For repeated observations, use logpoints (`logMessage`) and read them with `get_output` instead of editing source to add prints.
