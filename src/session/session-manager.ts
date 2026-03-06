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

import { DebugSession } from "./session.js";
import { randomUUID } from "node:crypto";

export class SessionManager {
  private sessions = new Map<string, DebugSession>();

  generateId(): string {
    return randomUUID().slice(0, 8);
  }

  add(session: DebugSession): void {
    this.sessions.set(session.id, session);
  }

  get(id: string): DebugSession | undefined {
    return this.sessions.get(id);
  }

  remove(id: string): void {
    this.sessions.delete(id);
  }

  resolve(sessionId: string | undefined): DebugSession {
    if (sessionId) {
      const session = this.sessions.get(sessionId);
      if (!session) {
        const available = Array.from(this.sessions.keys()).join(", ");
        throw new Error(`Session '${sessionId}' not found. Available sessions: ${available || "none"}`);
      }
      return session;
    }
    if (this.sessions.size === 0) {
      throw new Error("No active debug sessions. Use debug_launch or debug_attach first.");
    }
    if (this.sessions.size === 1) {
      return this.sessions.values().next().value!;
    }
    const available = Array.from(this.sessions.keys()).join(", ");
    throw new Error(`Multiple active sessions: ${available}. Specify sessionId.`);
  }

  listAll(): DebugSession[] {
    return Array.from(this.sessions.values());
  }
}
