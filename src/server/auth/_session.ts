// Session store — maps session IDs to authenticated session metadata

import type { Scope } from "../../types.ts";

export interface Session {
  id: string;
  fingerprint: string;
  ip: string;
  scopes: Scope[];
  expiresAt: number;
  /** Number of currently running exec processes */
  activeExecCount: number;
  /** Per-session working directory */
  cwd: string;
}

const DEFAULT_TTL = 60 * 60 * 1000; // 1 hour

export class SessionStore {
  private sessions = new Map<string, Session>();
  private ttl: number;

  constructor(opts?: { ttl?: number }) {
    this.ttl = opts?.ttl ?? DEFAULT_TTL;
  }

  create(fingerprint: string, scopes: Scope[], ip: string): Session {
    const id = crypto.randomUUID();
    const session: Session = {
      id,
      fingerprint,
      ip,
      scopes,
      expiresAt: Date.now() + this.ttl,
      activeExecCount: 0,
      cwd: process.cwd(),
    };
    this.sessions.set(id, session);
    return session;
  }

  get(id: string): Session | undefined {
    const session = this.sessions.get(id);
    if (!session) return undefined;
    if (Date.now() > session.expiresAt) {
      this.sessions.delete(id);
      return undefined;
    }
    return session;
  }

  delete(id: string): void {
    this.sessions.delete(id);
  }

  /** Check if a session has a required scope */
  hasScope(session: Session, scope: Scope): boolean {
    return session.scopes.includes(scope);
  }
}
