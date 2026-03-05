import { describe, it, expect } from "vitest";
import { SessionManager } from "./session-manager.js";

describe("SessionManager", () => {
  it("generates unique session IDs", () => {
    const manager = new SessionManager();
    const id1 = manager.generateId();
    const id2 = manager.generateId();
    expect(id1).not.toBe(id2);
  });

  it("stores and retrieves sessions by ID", () => {
    const manager = new SessionManager();
    const mockSession = { id: "test-1" } as any;
    manager.add(mockSession);
    expect(manager.get("test-1")).toBe(mockSession);
  });

  it("removes sessions", () => {
    const manager = new SessionManager();
    const mockSession = { id: "test-1" } as any;
    manager.add(mockSession);
    manager.remove("test-1");
    expect(manager.get("test-1")).toBeUndefined();
  });

  it("resolves single session when no ID provided", () => {
    const manager = new SessionManager();
    const mockSession = { id: "test-1" } as any;
    manager.add(mockSession);
    expect(manager.resolve(undefined)).toBe(mockSession);
  });

  it("throws when resolving without ID and multiple sessions exist", () => {
    const manager = new SessionManager();
    manager.add({ id: "s1" } as any);
    manager.add({ id: "s2" } as any);
    expect(() => manager.resolve(undefined)).toThrow(/multiple/i);
  });

  it("throws when resolving non-existent session", () => {
    const manager = new SessionManager();
    expect(() => manager.resolve("nope")).toThrow(/not found/i);
  });

  it("lists all sessions", () => {
    const manager = new SessionManager();
    manager.add({ id: "s1" } as any);
    manager.add({ id: "s2" } as any);
    expect(manager.listAll()).toHaveLength(2);
  });
});
