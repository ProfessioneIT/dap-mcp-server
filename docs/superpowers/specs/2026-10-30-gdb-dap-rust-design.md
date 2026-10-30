# GDB/DAP support for Rust

Status: approved by the user on 2026-10-30.

## Intent and scope

Make Rust debugging on Linux usable through the existing high-level MCP tools by
supporting GDB's native DAP interpreter. Retain LLDB and all existing adapter IDs,
tool names, configuration layers, and non-Rust defaults. Reuse the current DAP
transport and session lifecycle; no new npm dependency is required.

This change affects this MCP repository, not BrewScaler or other debug targets.
It must not install system packages or rewrite user adapter/client configuration
automatically. GUI debugging, new remote-debugging features, and universal Rust
expression support are outside this change.

## Approaches

1. Replace LLDB globally with GDB: changes unrelated C/C++ and platform defaults;
   rejected because the evidence concerns Rust on Linux.
2. Offer GDB only through an explicit adapter override: minimizes selection changes
   but leaves the normal Rust workflow using LLDB's expression limitations.
3. Prefer GDB for Rust on Linux, with LLDB available as a pre-launch fallback and
   explicit alternative: recommended, consistent with the preceding discussion.

The following defaults are the proposed engineering choices for approach 3.

## Selection and readiness

- Add a built-in `gdb` adapter using `gdb --nx --quiet --interpreter=dap` over stdio.
- An explicit `adapter` argument always takes precedence. Preserve project/global
  overrides for each adapter; do not rewrite or rename existing configurations.
- Without an explicit adapter, Rust on Linux prefers GDB when a bounded readiness
  probe confirms DAP support. Otherwise select the existing `cppdbg` LLDB adapter.
- Keep existing Rust defaults on other platforms and all non-Rust defaults.
- Fallback happens only during selection. Never run the target again under another
  debugger after launch or target execution has started.
- Doctor output must explain the selected engine, missing DAP support, and optional
  formatter prerequisites rather than checking only for an executable on PATH.

## Compatibility changes

- Evaluate automatic one-shot expressions in `watch` context. This fixes the shared
  path used by `debug_at` and `debug_inspect`. Preserve the public `evaluate` tool's
  existing `repl` default and explicit context argument for console compatibility.
- Apply compiled-program requirements and existing Cargo executable discovery to
  both native adapters, not only the `cppdbg` ID. Keep explicit executables valid
  for workspace integration-test binaries such as BrewScaler's.
- Translate public local-attach `processId` to GDB's `pid`. Keep advanced
  engine-specific fields in the existing launch/attach configuration objects.
- Normalize GDB's environment handling to the MCP's override-style behavior.
  Do not send LLDB-only initialization commands to GDB.
- Load trusted, installed Rust GDB formatters when available; report their absence
  without blocking scalar debugging. Do not broadly relax GDB auto-load safety or
  execute formatter scripts from an untrusted project automatically.
- Preserve frame ID zero, negotiate variable-type support, and handle breakpoint
  verification updates so pending breakpoints are not presented as permanent
  failures after GDB resolves them.

## Verification and acceptance

Use failing regression tests before production changes. Cover expression versus
console contexts, DAP readiness failures and timeouts, explicit selection, Linux
preference and LLDB fallback, unchanged non-Rust behavior, compiled-program
resolution, PID/environment translation, pending breakpoints, and cleanup.

Run the complete Vitest suite, TypeScript checks, and build. Then test the newly
built server over real stdio MCP against GDB and LLDB: doctor, high-level one-shot
inspection, stepping, conditional breakpoints, normal termination, and disconnect.
Verify Rust casts and the five existing BrewScaler calculation tests. Extend
formatting checks to standard-library containers when formatter prerequisites are
available; report any remaining limitations explicitly.

Keep all verification artifacts outside BrewScaler, under `/tmp`, and compare
source/configuration hashes around the tests. Do not launch its GUI or database.
No release-version bump, push, or global client reconfiguration is part of this
implementation request.
