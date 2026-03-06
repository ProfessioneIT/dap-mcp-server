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
