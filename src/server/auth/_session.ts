// Session store — maps session IDs to authenticated session metadata

import type { Scope } from "../../types.ts";
import type { Storage } from "../../types.ts";
import { MemoryStorage } from "../_storage.ts";

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
  private storage: Storage;
  private ttl: number;

  constructor(opts?: { ttl?: number; storage?: Storage }) {
    this.storage = opts?.storage ?? new MemoryStorage();
    this.ttl = opts?.ttl ?? DEFAULT_TTL;
  }

  async create(fingerprint: string, scopes: Scope[], ip: string): Promise<Session> {
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
    await this.storage.set(`session:${id}`, JSON.stringify(session), this.ttl);
    return session;
  }

  async get(id: string): Promise<Session | undefined> {
    const raw = await this.storage.get(`session:${id}`);
    if (!raw) return undefined;
    const session: Session = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (Date.now() > session.expiresAt) {
      await this.storage.delete(`session:${id}`);
      return undefined;
    }
    return session;
  }

  async delete(id: string): Promise<void> {
    await this.storage.delete(`session:${id}`);
  }

  /** Persist session mutations (cwd, activeExecCount) back to storage */
  async save(session: Session): Promise<void> {
    const remaining = session.expiresAt - Date.now();
    if (remaining <= 0) return;
    await this.storage.set(`session:${session.id}`, JSON.stringify(session), remaining);
  }

  /** Check if a session has a required scope */
  hasScope(session: Session, scope: Scope): boolean {
    return session.scopes.includes(scope);
  }
}
