import { describe, it, expect } from "vitest";
import { checkAdapterAvailable } from "./detect.js";

describe("checkAdapterAvailable", () => {
  it("detects 'node' as available", async () => {
    const result = await checkAdapterAvailable("node");
    expect(result).toBe(true);
  });

  it("detects non-existent binary as unavailable", async () => {
    const result = await checkAdapterAvailable("definitely-not-a-real-binary-xyz");
    expect(result).toBe(false);
  });
});
