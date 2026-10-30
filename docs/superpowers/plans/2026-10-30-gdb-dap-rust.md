# GDB/DAP Rust Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prefer a verified GDB/DAP adapter for Rust on Linux while retaining LLDB, existing MCP tools, and safe one-shot debugging.

**Architecture:** Extend the existing adapter registry, readiness checks, native launch recipes, and shared inspection path. Keep the DAP transport and session model; distinguish expression evaluation from debugger-console commands. Select fallback engines before execution, never after a target starts.

**Tech Stack:** TypeScript strict ESM, Node.js, MCP SDK, DAP, Vitest, system GDB and LLDB; no new npm dependency.

**Spec:** `docs/superpowers/specs/2026-10-30-gdb-dap-rust-design.md`

## Global Constraints

- Retain LLDB and all existing adapter IDs, tool names, configuration layers, and non-Rust defaults.
- An explicit `adapter` argument always takes precedence.
- Keep existing Rust defaults on other platforms and all non-Rust defaults.
- Never run the target again under another debugger after launch or target execution has started.
- Preserve the public `evaluate` tool's existing `repl` default and explicit context argument for console compatibility.
- Do not install system packages or rewrite user adapter/client configuration automatically.
- Keep all verification artifacts outside BrewScaler, under `/tmp`, and compare source/configuration hashes around the tests.
- No release-version bump, push, or global client reconfiguration is part of this implementation request.
- Use an approved isolated worktree; preserve MIT headers, `.js` relative imports, and the existing `AGENTS.md`.

## Review Focus

1. A working `gdb` executable that does not speak DAP, emits malformed output, exits early, or never replies must not be reported ready or leave a process behind (Task 1).
2. Explicit adapters and non-Linux/non-Rust selection must not silently change; selection must never retry target execution under a second engine (Tasks 2 and 5).
3. Frame ID `0`, pending breakpoint updates, and console commands must survive the expression-context fix (Task 3).
4. Environment values, path quoting, formatter symlinks, and configuration precedence must not change unrelated adapters or execute untrusted scripts (Task 4).
5. A virtual Cargo workspace or missing executable must produce an actionable error, not launch an `.rs` file; cleanup must occur on evaluation/launch errors (Tasks 2, 3 and 5).

---

### Task 1: Built-in GDB and bounded DAP readiness

**Files:** Modify `src/adapters/builtin.ts`, `src/adapters/detect.ts`, `src/adapters/detect.test.ts`; create `src/test-fixtures/gdb-mock-adapter.js`.

**Interfaces:** Preserve `inspectAdapterAvailability(config: AdapterConfig): Promise<AdapterAvailability>`. Add built-in `type: "gdb"`, `program: "gdb"`, `args: ["--nx", "--quiet", "--interpreter=dap"]`, `transport: "stdio"`. The test fixture speaks real framed DAP and accepts a mode argument for ready, rejected initialization, malformed output, and silence.

- [ ] Write readiness regressions against the real availability function: successful initialize gives `expect(result.available).toBe(true)`; rejected initialization, malformed output, early exit, silence, and a missing executable give `expect(result.available).toBe(false)` and a useful reason. Assert bounded completion and adapter cleanup, not fixture constants.
- [ ] Run `npx vitest run src/adapters/detect.test.ts`; expected: new GDB readiness cases fail before implementation.
- [ ] Implement GDB registration and an initialize-only readiness probe using the existing `DAPClient`. Use a 2,000 ms request deadline, bounded startup, an error handler, and `dispose()` in `finally`; never send a target launch. Test the configured command including runtime/arguments, not only `gdb --version`.
- [ ] Run the focused test and then `npm test`; expected: all tests pass, including unchanged availability checks for existing adapters.
- [ ] Commit approved design/plan and this task as `feat: add GDB DAP adapter and readiness checks`.

### Task 2: Rust selection and compiled-program handling

**Files:** Modify `src/diagnostics/doctor.ts`, `src/diagnostics/doctor.test.ts`, `src/server.ts`, `src/server.test.ts`.

**Interfaces:** Keep MCP argument/output schemas unchanged. Extend the internal resolver to `resolveProjectAdapter(registry, options = {}, platform: NodeJS.Platform = process.platform): Promise<ResolvedProjectAdapter>` for deterministic platform-policy checks. Allow `createServer(options: { globalDir?: string; projectDir?: string } = {})` to construct isolated real registries in MCP tests; defaults remain unchanged.

- [ ] Add resolver tests with real registry/project detection and a controlled availability boundary: Linux Rust chooses ready GDB; unavailable GDB selects LLDB; both unavailable report not-ready and remediation; explicit unavailable GDB does not fall back; explicit LLDB remains LLDB; macOS/Windows Rust and C/C++ retain `cppdbg`; Node/Python/Go/PHP/Java policies remain unchanged.
- [ ] Add MCP tests with temporary configuration directories. For both native adapters, a built Cargo package resolves its executable; an explicit workspace test binary is retained; a missing executable or virtual workspace without `program` returns an actionable error. Pin the latter with `expect(result.isError).toBe(true)` and no target launch.
- [ ] Run `npx vitest run src/diagnostics/doctor.test.ts src/server.test.ts`; expected: GDB preference and native-target cases fail before implementation.
- [ ] Resolve availability before choosing an automatic engine. Preserve explicit selection and configuration layers. Extend compiled-target checks/discovery from `cppdbg` to both `cppdbg` and `gdb`; explain fallback and missing GDB DAP support in doctor output. Do not introduce runtime retry/fallback.
- [ ] Run focused tests and `npm test`; expected: deterministic selection and no existing-language regressions.
- [ ] Commit as `feat: prefer ready GDB for Rust on Linux`.

### Task 3: Expressions and GDB session compatibility

**Files:** Modify `src/session/inspect.ts`, `src/session/inspect.test.ts`, `src/session/session.ts`, `src/session/session.test.ts`, `src/dap/dap-client.ts`, and the GDB fixture from Task 1.

**Interfaces:** Keep `DebugSession.evaluate(expression, frameId?, context = "repl")` and public tool defaults unchanged. Automatic inspection calls `session.evaluate(expr, topFrameId, "watch")`. Both parent and reverse-request child initialization advertise `supportsVariableType: true`. Breakpoint events update existing public breakpoint results by ID/source.

- [ ] Extend the fixture with GDB's documented `repl` versus `watch` behavior, top frame ID `0`, negotiated variable types, and pending-to-verified breakpoint events.
- [ ] Add a one-shot regression where a plain expression in `repl` is rejected but `watch` succeeds: assert `expect(result.values?.x.result).toBe("42")` and session cleanup. Cover frame ID `0` and per-expression failures without losing other values.
- [ ] Add session regressions preserving explicit/default console commands, returning negotiated type metadata, and updating a pending breakpoint to its resolved line and verification status. Assert observable session state, not private implementation layout.
- [ ] Run `npx vitest run src/session/inspect.test.ts src/session/session.test.ts src/dap/dap-client.test.ts`; expected: new context, type-negotiation and breakpoint-event cases fail before implementation.
- [ ] Implement explicit `watch` for automatic expressions, variable-type negotiation on both initialization paths, and breakpoint event handling. Preserve valid zero IDs and existing console behavior.
- [ ] Run focused tests and `npm test`; expected: existing and new session lifecycles pass.
- [ ] Commit as `fix: evaluate one-shot expressions outside debugger consoles`.

### Task 4: Native parameters and trusted Rust formatters

**Files:** Modify `src/adapters/recipes.ts`, `src/adapters/recipes.test.ts`, `src/server.ts`, `src/server.test.ts`, `src/session/inspect.ts`, `src/session/run.ts`, and corresponding lifecycle tests.

**Interfaces:** Retain `buildLaunchArgs` and add `buildAttachArgs(config: AdapterConfig, options: { processId?: number; host?: string; port?: number; attachConfig?: Record<string, unknown> }): Record<string, unknown>`. Add `prepareNativeAdapterConfig(config: AdapterConfig, options: { cwd?: string; sourceFiles?: string[] }, resolveRustSysroot?: () => Promise<string | undefined>): Promise<AdapterConfig>`; return a prepared configuration without mutating the registry. Invoke preparation before constructing sessions in launch, inspect, run, and attach; restart reuses the saved prepared configuration.

- [ ] Add recipe tests: GDB receives `pid: 42`, existing adapters retain `processId: 42`, and explicit common fields win over configuration defaults. GDB environment overrides retain inherited variables; absent `env` remains absent; unrelated adapters retain current behavior.
- [ ] Add formatter tests using a fake SDK outside the project: trusted installed GDB formatter setup is added only for Rust/GDB, user arguments remain intact, and the registry object is not mutated. Missing scripts do not block launch. Reject scripts resolving into the project or escaping the trusted SDK through symlinks; quote paths containing spaces/quotes safely. Keep LLDB formatter tests unchanged.
- [ ] Run `npx vitest run src/adapters/recipes.test.ts src/server.test.ts src/session/inspect.test.ts src/session/run.test.ts`; expected: new GDB preparation and parameter cases fail before implementation.
- [ ] Implement parameter translation and pre-spawn configuration preparation using the installed Rust toolchain's trusted formatter entry points. Do not send LLDB `initCommands` to GDB, relax auto-load safety globally, or install packages. Add useful doctor remediation when optional GDB Rust formatters are absent.
- [ ] Test failed preparation/launch cleanup and saved configuration reuse on restart, then run `npm test`; expected: the complete suite passes.
- [ ] Commit as `feat: normalize GDB native debugging parameters`.

### Task 5: Documentation and real stdio acceptance

**Files:** Modify `README.md`; extend `src/integration/debug-lifecycle.test.ts` and/or add a focused GDB lifecycle integration test with the existing fixtures. Keep environment-specific smoke harnesses/results under `/tmp`.

**Interfaces:** Existing MCP tools remain the acceptance boundary: `debug_doctor`, `debug_at`, `debug_inspect`, `debug_launch`, `evaluate`, `step`, `debug_run`, `debug_restart`, `debug_disconnect`.

- [ ] Add integration regressions for automatic Rust selection into a strict GDB-like adapter, successful plain-expression one-shot inspection, unavailable-GDB fallback, explicit engine selection, and cleanup on failure. Use temporary project/global config directories and no developer-machine paths.
- [ ] Run the focused integration tests; expected: all acceptance cases pass with the completed implementation, independently of locally installed GDB/LLDB.
- [ ] Document GDB prerequisites, Linux Rust preference, explicit LLDB selection, `watch` expressions versus `repl` commands, optional formatter requirements, and the no-reexecution fallback policy.
- [ ] Run `npm test`, `npm run typecheck`, `npm run build`, `git diff --check`, and `npm pack --dry-run`; expected: zero test/type/build failures and a package containing the updated server/documentation, with no generated build files staged.
- [ ] Start the newly built server via the MCP SDK's stdio client in a temporary working directory. Reuse/build BrewScaler's five calculation tests only under `/tmp`; hash its core/configuration files before and after. Verify doctor, automatic/explicit GDB `debug_at`, `debug_inspect`, Rust casts, conditional breakpoints, stepping, normal exit, restart, disconnect, and the five-test `debug_run`. Repeat scalar one-shot inspection with explicit LLDB.
- [ ] Exercise GDB local attach on an isolated temporary target when host ptrace policy permits; report policy restrictions rather than relaxing system security. Check `String`, `Vec`, and `HashMap` with trusted formatters if installed; otherwise record the missing prerequisite explicitly.
- [ ] Perform a fresh whole-branch review and fix important findings with failing regression tests. Expected: no unresolved critical/important findings, passing final suite, unchanged BrewScaler core/configuration hashes, and no lingering sessions from the smoke test.
- [ ] Commit verified docs/integration coverage as `test: cover GDB and LLDB Rust debugging lifecycles`; leave merge, push, release and global installation for explicit user direction.

## Self-review

The five tasks cover the approved selection, expression, native-parameter,
formatter, lifecycle, security, and verification requirements. Shared interfaces
are additive and retain existing defaults. Task 4 prepares configuration before
spawn; Task 3 remains responsible for expression context, not debugger startup.
All real-target verification is scoped to temporary artifacts and read-only
BrewScaler sources. No task assumes that this development checkout changes the
already running, globally installed MCP process.
