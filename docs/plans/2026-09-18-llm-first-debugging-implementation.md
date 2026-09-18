# LLM-First Debugging Implementation Plan

## Objective

Turn `dap-mcp-server` from a low-level DAP control surface into a debugger that coding agents can discover, configure, and use successfully with one primary call. Preserve all existing tools and configuration files so current users are not broken.

Success means:

- an MCP host receives short, trigger-oriented server instructions;
- common Python, Node.js/TypeScript, and Go projects receive an actionable readiness report without starting a debuggee;
- a one-shot inspection can infer a usable adapter when the caller omits one;
- launch-with-breakpoints returns a stopped snapshot, termination result, or explicit timeout instead of a misleading `running` response;
- Node TCP overrides inherit the built-in transport settings;
- structured MCP results and safety annotations are present on the new high-level tools;
- Claude Code users can install the MCP server and its skill as one plugin.

## Compatibility and Non-Goals

Existing tool names and accepted arguments remain valid. Existing adapter JSON continues to load. Text content remains in every result for clients that do not consume `structuredContent`.

This iteration will not install debuggers automatically, diagnose arbitrary bugs with an embedded LLM, guarantee tool selection in every MCP host, or fully normalize every adapter-specific launch schema. It will provide deterministic discovery and well-tested presets plus escape hatches for custom adapters.

## Phase 1 — Adapter Configuration and Readiness

1. Make registry resolution merge layers field-by-field: built-in < global < project. A project override that changes only `program` must retain the built-in TCP transport, port matcher, arguments, and launch defaults.
2. Extend `configure_adapter` with `transport` and `portMatcher`.
3. Add configuration-aware availability checks:
   - verify the runtime executable;
   - for Python `-m`, verify that the requested module can be imported;
   - for runtime-hosted scripts such as `dapDebugServer.js`, verify the script path or PATH entry;
   - retain the simple executable check for stdio binaries.
4. Add a read-only `debug_doctor` tool accepting `cwd` and optional `adapter`. It will detect project signals (`pyproject.toml`, virtualenvs, `package.json`, `go.mod`, `.vscode/launch.json`), report adapter readiness, choose a recommended adapter, and return exact remediation messages. It performs no installs or project writes.

Tests will cover layered merging, Python module probes, missing Node scripts, project detection, and recommendations.

## Phase 2 — Predictable One-Shot Debugging

1. Add a session primitive that waits for either `stopped`, `terminated`, or timeout without leaving stale waiters.
2. Change `debug_launch` behavior when breakpoints or exception breakpoints are supplied: wait for the first stop, termination, or caller-configurable timeout. Return a stopped snapshot when stopped and output/status when terminated.
3. Preserve a non-blocking launch escape hatch through `waitForStop: false`.
4. Surface breakpoint verification results instead of silently discarding them.
5. Update `debug_inspect` to distinguish unverified breakpoint, early termination, and timeout.
6. Add `debug_at`, a high-level alias around one-shot inspection. It accepts `cwd`, file, line, expressions, and an optional adapter. When omitted, the adapter is inferred by `debug_doctor` project detection.

`debug_test` is deferred until launch-configuration presets can be proven against real pytest, Vitest/Jest, and Go projects. `debug_at` plus adapter inference supplies the reusable core without presenting unverified test-runner behavior as universal.

## Phase 3 — MCP Contract Quality

1. Replace the 2.3 KB server instructions with a sub-2 KB version whose first paragraph contains natural activation triggers: non-trivial failing tests, runtime-state bugs, swallowed exceptions, and failed speculative fixes.
2. Register `debug_doctor` and `debug_at` with:
   - explicit titles;
   - Zod input and output schemas;
   - `structuredContent` plus backward-compatible JSON text;
   - accurate annotations. `debug_doctor` is read-only/idempotent; `debug_at` executes local code and is not read-only.
3. Add annotations to straightforward existing tools where safety semantics are unambiguous, especially discovery and state-reading tools.
4. Prefix new public operations with `debug_` so deferred tool search can associate names with debugging.

## Phase 4 — Skill, Documentation, and Claude Plugin

1. Rewrite the root `SKILL.md` using progressive disclosure: keep activation rules and the preferred `debug_doctor` → `debug_at` workflow in the entrypoint; retain only essential advanced-session guidance.
2. Correct Claude Code setup commands. A standalone skill must live at `.claude/skills/dap-debugging/SKILL.md`; global npm installation must not be documented as though it created a local `node_modules` tree.
3. Add a self-contained Claude plugin under `integrations/claude/dap-debugging/` with:
   - `.claude-plugin/plugin.json`;
   - `.mcp.json` launching `npx -y dap-mcp-server`;
   - `skills/dap-debugging/SKILL.md`.
4. Document local plugin validation and `claude --plugin-dir` usage. Do not add a marketplace entry or perform an external installation.

## Phase 5 — Verification

Run, in order:

1. targeted Vitest suites for adapters, sessions, and high-level tools;
2. full `npm test` outside process-restricting sandboxes when required;
3. `npm run typecheck` and `npm run build`;
4. skill frontmatter validation;
5. `claude plugin validate integrations/claude/dap-debugging`;
6. an MCP catalog smoke test confirming instruction length, schemas, annotations, and tool registration;
7. `git diff --check` and a final review for accidental generated output or unrelated changes.

## Follow-Up Evaluation

After release, add host-level tool-selection evaluations. Positive prompts should cover opaque test failures, state-dependent bugs, swallowed exceptions, and a failed first fix. Negative prompts should cover syntax errors, simple static explanations, and failures already explained by a clear stack trace. Track discovery rate, first-call validity, successful snapshot rate, tool-call count, latency, and unnecessary debugger use. These evaluations require model/API execution and are intentionally separate from deterministic repository tests.
