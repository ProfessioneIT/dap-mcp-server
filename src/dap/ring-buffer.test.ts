import { describe, it, expect } from "vitest";
import { RingBuffer } from "./ring-buffer.js";

describe("RingBuffer", () => {
  it("stores and retrieves entries", () => {
    const buf = new RingBuffer<string>(100);
    buf.push("a");
    buf.push("b");
    expect(buf.getAll()).toEqual(["a", "b"]);
    expect(buf.truncated).toBe(false);
  });

  it("drops oldest entries when full", () => {
    const buf = new RingBuffer<string>(3);
    buf.push("a");
    buf.push("b");
    buf.push("c");
    buf.push("d");
    expect(buf.getAll()).toEqual(["b", "c", "d"]);
    expect(buf.truncated).toBe(true);
  });

  it("clears entries", () => {
    const buf = new RingBuffer<string>(10);
    buf.push("a");
    buf.push("b");
    buf.clear();
    expect(buf.getAll()).toEqual([]);
    expect(buf.truncated).toBe(false);
  });

  it("filters entries", () => {
    const buf = new RingBuffer<{ cat: string; text: string }>(10);
    buf.push({ cat: "stdout", text: "hello" });
    buf.push({ cat: "stderr", text: "error" });
    buf.push({ cat: "stdout", text: "world" });
    const filtered = buf.getFiltered((e) => e.cat === "stdout");
    expect(filtered).toEqual([
      { cat: "stdout", text: "hello" },
      { cat: "stdout", text: "world" },
    ]);
  });

  it("reports size correctly", () => {
    const buf = new RingBuffer<string>(5);
    expect(buf.size).toBe(0);
    buf.push("a");
    buf.push("b");
    expect(buf.size).toBe(2);
  });

  it("removes only matching entries", () => {
    const buf = new RingBuffer<{ cat: string; text: string }>(10);
    buf.push({ cat: "stdout", text: "hello" });
    buf.push({ cat: "stderr", text: "error" });
    buf.push({ cat: "stdout", text: "world" });
    buf.removeMatching((e) => e.cat === "stdout");
    expect(buf.getAll()).toEqual([{ cat: "stderr", text: "error" }]);
  });
});
