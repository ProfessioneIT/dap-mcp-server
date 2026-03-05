import { describe, it, expect, afterEach } from "vitest";
import { DebugSession } from "./session.js";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MOCK_ADAPTER = path.join(__dirname, "../test-fixtures/mock-adapter.js");

describe("DebugSession", () => {
  let session: DebugSession | undefined;

  afterEach(async () => {
    if (session) {
      try { await session.disconnect(); } catch { /* ignore */ }
      session = undefined;
    }
  });

  it("initializes and tracks state", async () => {
    session = new DebugSession("test-1", {
      type: "mock",
      runtime: "node",
      program: MOCK_ADAPTER,
    });
    expect(session.state).toBe("idle");
    await session.initialize();
    expect(session.state).toBe("configuring");
  });

  it("has a unique session ID", () => {
    session = new DebugSession("my-session", {
      type: "mock",
      runtime: "node",
      program: MOCK_ADAPTER,
    });
    expect(session.id).toBe("my-session");
  });

  it("buffers output events", async () => {
    session = new DebugSession("test-2", {
      type: "mock",
      runtime: "node",
      program: MOCK_ADAPTER,
    });
    session.addOutput("stdout", "hello world");
    const output = session.getOutput();
    expect(output.output).toHaveLength(1);
    expect(output.output[0].text).toBe("hello world");
    expect(output.output[0].category).toBe("stdout");
  });

  it("detects adapter crash", async () => {
    const crashAdapter = path.join(__dirname, "../test-fixtures/crash-adapter.js");
    session = new DebugSession("test-crash", {
      type: "mock",
      runtime: "node",
      program: crashAdapter,
    });
    await expect(session.initialize()).rejects.toThrow();
    expect(session.state).toBe("terminated");
  });
});
