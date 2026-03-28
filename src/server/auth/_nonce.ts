// Nonce cache for replay prevention — backed by pluggable Storage

import type { Storage } from "../../types.ts";
import { MemoryStorage } from "../_storage.ts";

const DEFAULT_TTL = 30_000;

export class NonceCache {
  private storage: Storage;
  private ttl: number;

  constructor(opts?: { ttl?: number; storage?: Storage }) {
    this.storage = opts?.storage ?? new MemoryStorage();
    this.ttl = opts?.ttl ?? DEFAULT_TTL;
  }

  /** Store a nonce (marks it as issued) */
  async issue(nonce: string): Promise<void> {
    await this.storage.set(`nonce:${nonce}`, "1", this.ttl);
  }

  /** Consume a nonce — returns true if valid, false if invalid/expired/reused */
  async consume(nonce: string): Promise<boolean> {
    const val = await this.storage.get(`nonce:${nonce}`);
    if (!val) return false;
    await this.storage.delete(`nonce:${nonce}`);
    return true;
  }
}
