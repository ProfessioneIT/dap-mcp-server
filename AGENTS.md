# Repository Guidelines

## Project Structure & Module Organization

This TypeScript/Node.js MCP server wraps Debug Adapter Protocol (DAP) adapters. In `src/`, `server.ts` and `index.ts` expose MCP, while `dap/`, `session/`, and `adapters/` implement transport, lifecycle, and adapter configuration. Unit tests are colocated as `*.test.ts`; lifecycle tests live in `src/integration/`, with JavaScript mocks in `src/test-fixtures/`. `docs/plans/` contains design records. `build/` is generated; do not edit or commit it.

## Build, Test, and Development Commands

- `npm ci` installs the lockfile-pinned dependencies used by CI.
- `npm run build` compiles `src/` into `build/` with declarations and source maps.
- `npm run typecheck` runs strict TypeScript checks without emitting files.
- `npm test` runs the complete Vitest suite once.
- `npm run test:watch` reruns affected tests during development.
- `npx vitest run src/dap/protocol.test.ts` runs one test file.
- `npm run dev` watches TypeScript sources; after building, `npm start` runs the stdio server.

Before submitting changes, run `npm test`, `npm run typecheck`, and `npm run build`.

## Coding Style & Naming Conventions

Follow the existing two-space indentation, double quotes, semicolons, and trailing commas in multiline literals. The project uses strict TypeScript and ESM; relative imports must include the emitted `.js` extension. Name files and directories in kebab-case, classes/types in PascalCase, and variables/functions in camelCase. Preserve the MIT header on source files. Do not write diagnostics with `console.log`, because stdout carries the MCP protocol; use `console.error`. No formatter or linter is configured, so match nearby code.

## Testing Guidelines

Use Vitest's `describe`/`it`/`expect` APIs and name tests `*.test.ts`. Add focused unit coverage beside changed modules and integration coverage for cross-layer debug lifecycles. Reuse or extend the mock adapters for process, timeout, and protocol edge cases. There is no numeric coverage threshold; regressions and error paths should still receive explicit tests.

## Commit & Pull Request Guidelines

History primarily follows Conventional Commit prefixes: `feat:`, `fix:`, `test:`, `docs:`, `ci:`, and `chore:`. Keep subjects imperative and scoped to one logical change. Pull requests should explain behavior and motivation, link issues, list verification commands, and note protocol or configuration changes. Include screenshots only for visual changes; otherwise provide representative MCP/DAP output when useful. Do not create release-version commits—CI bumps patch versions on `main`.

## Configuration & Security

Project adapter overrides belong in `.dap-mcp/adapters.json`, which is ignored by Git; global defaults use `~/.dap-mcp/adapters.json`. Never commit credentials, machine-specific adapter paths, or npm tokens.
