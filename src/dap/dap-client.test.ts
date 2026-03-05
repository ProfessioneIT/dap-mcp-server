import { describe, it, expect, afterEach } from "vitest";
import { DAPClient, DAPClientError } from "./dap-client.js";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe("DAPClient", () => {
  let client: DAPClient | undefined;

  afterEach(async () => {
    if (client) {
      try { await client.dispose(); } catch { /* ignore */ }
      client = undefined;
    }
  });

  it("spawns adapter and sends initialize request", async () => {
    client = new DAPClient("node", path.join(__dirname, "../test-fixtures/mock-adapter.js"));
    await client.spawn();
    const response = await client.sendRequest("initialize", {
      adapterID: "test",
      linesStartAt1: true,
      columnsStartAt1: true,
      pathFormat: "path",
    });
    expect(response.success).toBe(true);
    expect(response.command).toBe("initialize");
  });

  it("receives events from adapter", async () => {
    client = new DAPClient("node", path.join(__dirname, "../test-fixtures/mock-adapter.js"));
    await client.spawn();

    const eventPromise = new Promise<any>((resolve) => {
      client!.on("initialized", resolve);
    });

    await client.sendRequest("initialize", {
      adapterID: "test",
      linesStartAt1: true,
      columnsStartAt1: true,
      pathFormat: "path",
    });

    const event = await eventPromise;
    expect(event.event).toBe("initialized");
  });

  it("rejects on adapter exit during request", async () => {
    client = new DAPClient("node", path.join(__dirname, "../test-fixtures/crash-adapter.js"));
    await client.spawn();
    await expect(
      client.sendRequest("initialize", { adapterID: "test" })
    ).rejects.toThrow();
  });

  it("times out if adapter does not respond", async () => {
    client = new DAPClient("node", path.join(__dirname, "../test-fixtures/silent-adapter.js"));
    await client.spawn();
    await expect(
      client.sendRequest("initialize", { adapterID: "test" }, 500)
    ).rejects.toThrow(/timeout/i);
  });
});
