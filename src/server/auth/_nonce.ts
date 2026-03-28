// LRU nonce cache for replay prevention

interface NonceEntry {
  expiresAt: number;
  prev: string | null;
  next: string | null;
}

const DEFAULT_TTL = 30_000;
const DEFAULT_MAX_SIZE = 10_000;

export class NonceCache {
  private entries = new Map<string, NonceEntry>();
  private head: string | null = null; // most recent
  private tail: string | null = null; // least recent
  private ttl: number;
  private maxSize: number;

  constructor(opts?: { ttl?: number; maxSize?: number }) {
    this.ttl = opts?.ttl ?? DEFAULT_TTL;
    this.maxSize = opts?.maxSize ?? DEFAULT_MAX_SIZE;
  }

  /** Issue a new nonce, returns the nonce string (already stored) */
  issue(nonce: string): void {
    const entry: NonceEntry = {
      expiresAt: Date.now() + this.ttl,
      prev: null,
      next: this.head,
    };
    if (this.head) {
      this.entries.get(this.head)!.prev = nonce;
    }
    this.head = nonce;
    if (!this.tail) this.tail = nonce;
    this.entries.set(nonce, entry);
    this._evict();
  }

  /** Consume a nonce — returns true if valid, false if invalid/expired/reused */
  consume(nonce: string): boolean {
    const entry = this.entries.get(nonce);
    if (!entry) return false;
    if (Date.now() > entry.expiresAt) {
      this._remove(nonce);
      return false;
    }
    this._remove(nonce);
    return true;
  }

  private _remove(nonce: string): void {
    const entry = this.entries.get(nonce);
    if (!entry) return;
    if (entry.prev) this.entries.get(entry.prev)!.next = entry.next;
    else this.head = entry.next;
    if (entry.next) this.entries.get(entry.next)!.prev = entry.prev;
    else this.tail = entry.prev;
    this.entries.delete(nonce);
  }

  private _evict(): void {
    while (this.entries.size > this.maxSize && this.tail) {
      this._remove(this.tail);
    }
  }
}
