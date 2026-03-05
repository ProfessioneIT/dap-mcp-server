import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { AdapterRegistry } from "./registry.js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

describe("AdapterRegistry", () => {
  let tmpDir: string;
  let registry: AdapterRegistry;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "dap-mcp-test-"));
    registry = new AdapterRegistry(tmpDir, tmpDir);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("returns built-in adapters", () => {
    const adapters = registry.listAll();
    expect(adapters.some((a) => a.type === "python")).toBe(true);
    expect(adapters.some((a) => a.type === "go")).toBe(true);
    // node adapter removed — no reliable universal path; configure via configure_adapter
    expect(adapters.some((a) => a.type === "node")).toBe(false);
  });

  it("registers a custom adapter", () => {
    registry.register({ type: "ruby", program: "/usr/bin/rdbg", args: ["--open", "--dap"] });
    const ruby = registry.get("ruby");
    expect(ruby).toBeDefined();
    expect(ruby!.program).toBe("/usr/bin/rdbg");
  });

  it("project-local overrides built-in", () => {
    registry.register({ type: "python", program: "/custom/debugpy" });
    const python = registry.get("python");
    expect(python!.program).toBe("/custom/debugpy");
  });

  it("saves and loads config from disk", async () => {
    registry.register({ type: "ruby", program: "/usr/bin/rdbg" });
    await registry.save("project");

    const registry2 = new AdapterRegistry(tmpDir, tmpDir);
    await registry2.load();
    const ruby = registry2.get("ruby");
    expect(ruby).toBeDefined();
    expect(ruby!.program).toBe("/usr/bin/rdbg");
  });
});
