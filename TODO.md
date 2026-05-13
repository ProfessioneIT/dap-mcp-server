# DAP MCP Server — Improvement TODO

Findings from a self-review of how usable this MCP is for an AI agent. Ordered by priority (descending). Check items off as completed.

## Tier 1 — Documentation (SKILL.md). High leverage, low risk.

- [x] **P1 — Logpoints section.** `breakpoints[].logMessage` is already wired through (session.ts:138) but is invisible in SKILL.md. It is the closest thing to a drop-in replacement for `print()` debugging: no code edits, captures every hit, no execution pause. Should have its own headline section with an example.
- [x] **P2 — "Debug a failing test" section.** Most real bugs surface inside test runners (pytest, vitest, jest, go test, cargo test). Currently zero guidance. Add a per-framework template for launching a single test under the debugger.
- [x] **P3 — "Switch from print() to debugger" triggers.** Concrete rules an AI agent will actually follow: "if first fix attempt was wrong, stop guessing"; "if about to add 3+ prints, use logpoints"; "if reasoning about iteration N, use `hitCondition`"; "if traceback is non-obvious, launch test under debugger".
- [x] **P4 — Stepping strategy.** Default to `next`. Use `stepIn` only when you suspect the bug is *inside* the called function. Otherwise agents get lost in library internals.
- [x] **P5 — Full worked example.** Real bug → real `debug_launch` call → real returned state → identified fix. Replaces all the abstract advice with one concrete walkthrough.
- [x] **P5b — Node.js adapter recipe.** Builtin was removed; add a ready-to-paste `configure_adapter` snippet for `js-debug-dap`.

## Tier 2 — Code changes that materially improve UX.

- [x] **P6 — `debug_inspect` macro tool.** One call: launch, run to a breakpoint, evaluate a list of expressions, disconnect. Collapses a 5–7 round-trip workflow into 1. Most likely change to make me reach for the debugger reflexively.
- [x] **P7 — Flip `stopOnEntry` default to `false` when breakpoints are provided.** Today defaults to `true` regardless (server.ts:206). Doing the right thing automatically is better than relying on the agent reading the SKILL.md.
- [x] **P8 — Structured deep variables.** `getVariables` with `depth > 1` flattens children into the value string (session.ts:271–278). Hard for the AI to consume. Return nested `children: [...]` instead.
- [x] **P9 — `list_adapters` summary line + surfaced install hints.** Add `summary: "2/4 installed"` and lift `installHint` for missing adapters to the top level so it's scannable.
- [x] **P10 — `debug_run` macro tool.** Launch, run to completion, return all stdout/stderr. Zero breakpoints, zero round-trips. For "what does this script actually print/crash with?" cases.

## Tier 3 — Polish.

- [x] **P11 — Better "session is not stopped" error.** Currently says "use step with action: pause" (server.ts:549) — bad advice (Python `pause` lands in arbitrary library code). Suggest "set a breakpoint where you want to inspect, then continue to it".
- [x] **P12 — Version drift.** `McpServer` registers as `0.1.0` (server.ts:48); package.json is `0.1.10`. Read from `package.json`.
- [x] **P13 — `list_breakpoints` tool.** After several `set_breakpoints` calls, no way to introspect what's set. Minor.

## Tier 4 — Speculative.

- [x] **`get_output({ since })` for incremental polling.** Smaller substitute for streaming subscriptions. Caller passes the `nextSince` value from a prior call to receive only newly-emitted entries. Useful for watching logpoint output during `continue` against long-running programs.
- [ ] ~~Streaming output via MCP resource subscriptions.~~ AI agents don't watch streams in real time; the request/response pattern doesn't benefit. `since`-based polling covers the practical case.
- [ ] ~~Auto-detect test runner from program path.~~ Too magic; SKILL.md recipes (P2) make the right call explicit, and silent misfires would be worse than no detection at all.
