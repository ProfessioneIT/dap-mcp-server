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
