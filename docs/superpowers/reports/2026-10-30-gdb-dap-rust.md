# GDB/DAP Rust acceptance results

The development build was tested through a real MCP SDK stdio client on Fedora,
using system GDB and LLDB. No installed MCP package or persistent client/adapter
configuration was changed.

## Automated checks

- `npm test`: 137 passing tests across 18 files.
- `npm run typecheck`, `npm run build`, `git diff --check`: passed.
- `npm pack --dry-run`: includes the compiled server, README and integrations;
  generated build files are not committed.
- Coverage includes initialize-only readiness failures and process disposal,
  platform/explicit selection, virtual Cargo workspaces, frame ID zero,
  expression/console contexts, pending breakpoint updates, attach parameter
  precedence, environment inheritance and trusted formatter paths.

## Real targets

BrewScaler's core calculations integration executable was rebuilt offline with
`--locked --target-dir /tmp/...`, without editing the project. Its five tests
passed through `debug_run` under GDB/DAP.

The new server passed doctor selection, automatic and explicit GDB `debug_at`,
`debug_inspect`, conditional breakpoints, stepping, restart, normal exit and
disconnect. At the water-balance return, `total_l` was `29`, `sparge_l` was `12`,
and the Rust expression `sparge_l as u32` returned `12`. Explicit LLDB inspection
returned the same scalar values. The session resource was empty after cleanup.

Hashes of 27 core/source/configuration paths were compared before compilation
and after the debugger tests: no changes. Detailed stdio results and the hash
baseline remain in the temporary acceptance directory, outside BrewScaler.

A separate temporary C process was attached using the public `processId` field;
GDB stopped at its breakpoint and returned `value == 42`. Disconnect preserved
the target, which the harness then terminated. The existing host ptrace policy
allowed this; no policy was changed.

## Limitation

This host lacks the Rust GDB pretty-printer scripts. Doctor reports the missing
optional integration; live `String`, `Vec`, and `HashMap` formatting remains
unverified here. Automated tests cover trusted SDK preparation, quoting, missing
scripts and escaping symlinks. No system packages were installed.
