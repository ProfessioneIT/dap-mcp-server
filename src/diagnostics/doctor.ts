/**
 * Copyright (c) 2026 Ivan Iraci <ivan.iraci@professioneit.com>
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { AdapterRegistry } from "../adapters/registry.js";
import { inspectAdapterAvailability } from "../adapters/detect.js";
import { adapterUsageNote, prepareNativeAdapterConfig } from "../adapters/recipes.js";
import { AdapterConfig } from "../dap/types.js";

export interface ProjectSignals {
  languages: string[];
  testFrameworks: string[];
  packageManager?: string;
  pythonPath?: string;
  launchJson?: string;
}

export interface DoctorAdapter {
  type: string;
  source: "builtin" | "global" | "project";
  selected: boolean;
  available: boolean;
  command: string;
  reason?: string;
  installHint?: string;
  runtime?: string;
  program: string;
  transport: "stdio" | "tcp";
}

export interface DoctorResult {
  cwd: string;
  ready: boolean;
  recommendedAdapter?: string;
  detected: ProjectSignals;
  /** The selected adapter only, unless the caller asked for a verbose report. */
  adapters: DoctorAdapter[];
  /** Compact roster of the adapters left out of `adapters`, e.g. "go (missing)". */
  otherAdapters?: string[];
  nextSteps: string[];
}

export interface ResolvedProjectAdapter {
  result: DoctorResult;
  config?: AdapterConfig;
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function firstExisting(paths: string[]): Promise<string | undefined> {
  for (const candidate of paths) {
    if (await exists(candidate)) return candidate;
  }
  return undefined;
}

async function readPackageJson(cwd: string): Promise<Record<string, unknown> | undefined> {
  try {
    return JSON.parse(await fs.readFile(path.join(cwd, "package.json"), "utf8"));
  } catch {
    return undefined;
  }
}

function packageNames(pkg: Record<string, unknown> | undefined): Set<string> {
  const names = new Set<string>();
  for (const key of ["dependencies", "devDependencies", "peerDependencies"]) {
    const deps = pkg?.[key];
    if (deps && typeof deps === "object") {
      for (const name of Object.keys(deps)) names.add(name);
    }
  }
  return names;
}

const EXTENSION_LANGUAGES: Record<string, string> = {
  ".py": "python",
  ".js": "node",
  ".jsx": "node",
  ".mjs": "node",
  ".cjs": "node",
  ".ts": "node",
  ".tsx": "node",
  ".go": "go",
  ".c": "cppdbg",
  ".cc": "cppdbg",
  ".cpp": "cppdbg",
  ".cxx": "cppdbg",
  ".h": "cppdbg",
  ".hpp": "cppdbg",
  ".rs": "rust",
  ".php": "php",
  ".java": "java",
};

const MANIFEST_LANGUAGES: Array<[string, string]> = [
  ["pyproject.toml", "python"],
  ["requirements.txt", "python"],
  ["setup.py", "python"],
  ["go.mod", "go"],
  ["Cargo.toml", "rust"],
  ["composer.json", "php"],
  ["pom.xml", "java"],
  ["build.gradle", "java"],
  ["build.gradle.kts", "java"],
  ["CMakeLists.txt", "cppdbg"],
];

/** Languages debugged through an adapter whose type differs from the language name. */
const LANGUAGE_ADAPTERS: Record<string, string> = {
  rust: "cppdbg",
};

function languageOf(filePath: string): string | undefined {
  return EXTENSION_LANGUAGES[path.extname(filePath).toLowerCase()];
}

/**
 * Fallback for manifest-less projects (scripts, pet projects): rank languages
 * by how many source files sit in cwd and cwd/src.
 */
async function looseSourceLanguages(cwd: string): Promise<string[]> {
  const counts = new Map<string, number>();
  for (const dir of [cwd, path.join(cwd, "src")]) {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const language = entry.isFile() ? languageOf(entry.name) : undefined;
      if (language) counts.set(language, (counts.get(language) ?? 0) + 1);
    }
  }
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([language]) => language);
}

export async function detectProjectSignals(
  cwd: string,
  sourceFile?: string
): Promise<ProjectSignals> {
  const languages = new Set<string>();
  const testFrameworks = new Set<string>();

  const sourceLanguage = sourceFile ? languageOf(sourceFile) : undefined;
  if (sourceLanguage) languages.add(sourceLanguage);

  for (const [manifest, language] of MANIFEST_LANGUAGES) {
    if (await exists(path.join(cwd, manifest))) languages.add(language);
  }

  const pkg = await readPackageJson(cwd);
  const deps = packageNames(pkg);
  if (pkg) languages.add("node");
  if (languages.size === 0) {
    for (const language of await looseSourceLanguages(cwd)) languages.add(language);
  }
  if (deps.has("vitest")) testFrameworks.add("vitest");
  if (deps.has("jest") || deps.has("@jest/core")) testFrameworks.add("jest");
  if (deps.has("mocha")) testFrameworks.add("mocha");
  if (languages.has("python")) testFrameworks.add("pytest-compatible");
  if (languages.has("go")) testFrameworks.add("go-test");

  let packageManager: string | undefined;
  if (await exists(path.join(cwd, "pnpm-lock.yaml"))) packageManager = "pnpm";
  else if (await exists(path.join(cwd, "yarn.lock"))) packageManager = "yarn";
  else if (await exists(path.join(cwd, "bun.lockb"))) packageManager = "bun";
  else if (await exists(path.join(cwd, "package-lock.json"))) packageManager = "npm";

  const pythonPath = await firstExisting(
    process.platform === "win32"
      ? [path.join(cwd, ".venv", "Scripts", "python.exe"), path.join(cwd, "venv", "Scripts", "python.exe")]
      : [path.join(cwd, ".venv", "bin", "python"), path.join(cwd, "venv", "bin", "python")]
  );
  const launchJsonPath = path.join(cwd, ".vscode", "launch.json");
  const launchJson = (await exists(launchJsonPath)) ? launchJsonPath : undefined;

  return {
    languages: Array.from(languages),
    testFrameworks: Array.from(testFrameworks),
    packageManager,
    pythonPath,
    launchJson,
  };
}

async function resolveNodeProgram(cwd: string): Promise<string | undefined> {
  return firstExisting([
    path.join(cwd, "node_modules", "@vscode", "js-debug", "src", "dapDebugServer.js"),
    path.join(cwd, "node_modules", "@vscode", "js-debug", "dist", "src", "dapDebugServer.js"),
    path.join(cwd, "node_modules", "vscode-js-debug", "src", "dapDebugServer.js"),
  ]);
}

function preferredAdapter(signals: ProjectSignals, sourceFile?: string): string | undefined {
  const language = (sourceFile ? languageOf(sourceFile) : undefined) ?? signals.languages[0];
  return language ? LANGUAGE_ADAPTERS[language] ?? language : undefined;
}

export async function resolveProjectAdapter(
  registry: AdapterRegistry,
  options: { cwd?: string; adapter?: string; sourceFile?: string } = {},
  platform: NodeJS.Platform = process.platform,
): Promise<ResolvedProjectAdapter> {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const stat = await fs.stat(cwd).catch(() => undefined);
  if (!stat?.isDirectory()) throw new Error(`Working directory '${cwd}' does not exist.`);

  const detected = await detectProjectSignals(cwd, options.sourceFile);
  const sourceLanguage = (options.sourceFile ? languageOf(options.sourceFile) : undefined) ?? detected.languages[0];
  let recommendedAdapter = options.adapter ?? preferredAdapter(detected, options.sourceFile);
  const adapters: DoctorAdapter[] = [];
  const configs = new Map<string, AdapterConfig>();

  for (const adapter of registry.listAll()) {
    const { source: _source, ...baseConfig } = adapter;
    let config: AdapterConfig = baseConfig;
    if (adapter.type === "gdb" && sourceLanguage === "rust") {
      config = await prepareNativeAdapterConfig(config, { cwd, sourceFiles: options.sourceFile ? [options.sourceFile] : undefined });
    }
    if (adapter.type === "python" && detected.pythonPath) {
      config = { ...config, runtime: detected.pythonPath };
    }
    if (adapter.type === "node") {
      const configured = await inspectAdapterAvailability(config);
      if (!configured.available) {
        const nodeProgram = await resolveNodeProgram(cwd);
        if (nodeProgram) config = { ...config, program: nodeProgram };
      }
    }
    configs.set(adapter.type, config);
    const availability = await inspectAdapterAvailability(config);
    adapters.push({
      type: adapter.type,
      source: adapter.source,
      selected: adapter.type === recommendedAdapter,
      available: availability.available,
      command: availability.command,
      reason: availability.reason,
      installHint: adapter.installHint,
      runtime: config.runtime,
      program: config.program,
      transport: config.transport ?? "stdio",
    });
  }

  const preferGdb = options.adapter === undefined && sourceLanguage === "rust" && platform === "linux";
  const gdb = adapters.find((adapter) => adapter.type === "gdb");
  if (preferGdb) recommendedAdapter = gdb?.available ? "gdb" : "cppdbg";
  for (const adapter of adapters) adapter.selected = adapter.type === recommendedAdapter;
  const selected = adapters.find((adapter) => adapter.selected);
  const nextSteps: string[] = [];
  if (preferGdb && !gdb?.available) {
    nextSteps.push(`GDB/DAP is unavailable (${gdb?.reason ?? "adapter not configured"}); selecting LLDB before launch. Install a DAP-capable GDB or select cppdbg explicitly.`);
  }
  if (!recommendedAdapter) {
    nextSteps.push("Specify an adapter explicitly; no supported project language was detected.");
  } else if (!selected) {
    nextSteps.push(`Configure adapter '${recommendedAdapter}' with configure_adapter.`);
  } else if (!selected.available) {
    if (selected.reason) nextSteps.push(selected.reason);
    if (selected.installHint) nextSteps.push(selected.installHint);
    if (recommendedAdapter === "python" && detected.pythonPath) {
      nextSteps.push(`Install debugpy in the project environment: ${detected.pythonPath} -m pip install debugpy`);
    }
  }
  if (selected?.available) {
    if (sourceLanguage === "rust" && selected.type === "gdb") {
      nextSteps.push("Rust uses GDB/DAP. Build with debug information and supply the compiled executable for Cargo workspaces. Rust GDB pretty-printers are optional for standard-library containers.");
      if (!configs.get("gdb")?.args?.some((arg) => arg.includes("gdb_load_rust_pretty_printers.py"))) {
        nextSteps.push("Automatic Rust GDB formatters are unavailable. Install the matching toolchain's rust-gdb integration or configure your own trusted formatter setup; scalar debugging remains available.");
      }
    }
    // Rust rides on cppdbg, so look the note up by language before adapter.
    const language = detected.languages.find(
      (name) => (LANGUAGE_ADAPTERS[name] ?? name) === selected.type && adapterUsageNote(name)
    );
    const note = adapterUsageNote(language ?? selected.type);
    if (note) nextSteps.push(note);
  }
  if (detected.launchJson) {
    nextSteps.push(`A launch configuration is available at ${detected.launchJson}; pass its adapter-specific fields through launchConfig when needed.`);
  }

  return {
    result: {
      cwd,
      ready: selected?.available ?? false,
      recommendedAdapter,
      detected,
      adapters,
      nextSteps,
    },
    config: recommendedAdapter ? configs.get(recommendedAdapter) : undefined,
  };
}

/** Drop the per-adapter detail an agent rarely needs, keeping a one-line roster. */
export function conciseDoctorResult(result: DoctorResult): DoctorResult {
  const others = result.adapters.filter((adapter) => !adapter.selected);
  return {
    ...result,
    adapters: result.adapters.filter((adapter) => adapter.selected),
    otherAdapters: others.map((adapter) =>
      adapter.available ? adapter.type : `${adapter.type} (missing)`
    ),
  };
}

export async function runDebugDoctor(
  registry: AdapterRegistry,
  options: { cwd?: string; adapter?: string; verbose?: boolean } = {}
): Promise<DoctorResult> {
  const { result } = await resolveProjectAdapter(registry, options);
  return options.verbose ? result : conciseDoctorResult(result);
}
