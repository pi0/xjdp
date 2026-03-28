// Default in-memory storage implementation.
// For multi-instance deployments, provide a custom Storage
// (Redis, KV, etc.) via ServerConfig.storage.

import type { Storage } from "../types.ts";

export type { Storage };

export class MemoryStorage implements Storage {
  private data = new Map<string, { value: string; expiresAt: number }>();

  get(key: string): string | undefined {
    const entry = this.data.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.data.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: string, ttl?: number): void {
    this.data.set(key, {
      value,
      expiresAt: ttl ? Date.now() + ttl : Number.MAX_SAFE_INTEGER,
    });
  }

  delete(key: string): void {
    this.data.delete(key);
  }
}
