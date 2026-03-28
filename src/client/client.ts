// RJDP Client — isomorphic (browser + Node.js)

import type {
  Frame,
  Transport,
  Capability,
  Scope,
  AuthResponse,
  EvalRequest,
  EvalResponse,
  ExecRequest,
  ExecExit,
  FsOp,
  FsResponse,
  FsListEntry,
  FsStat,
} from "../types.ts";
import { generateKeyPair, fingerprint, exportPublicKey } from "./_crypto.ts";
import { negotiate, type NegotiateResult } from "./_negotiate.ts";
import type { ClientTransport, FrameHandler } from "./transport/_base.ts";
import { HTTPTransport } from "./transport/http.ts";

export interface ClientOptions {
  privateKey: CryptoKey;
  publicKey: CryptoKey;
  /** Transport preference order (default: ["sse", "http"]) */
  transports?: Transport[];
  /** Expected server fingerprint (hex) — if set, connection fails on mismatch */
  serverFingerprint?: string;
  /** Cached session to reuse (skips auth if still valid, falls back to fresh auth) */
  session?: AuthResponse;
}

export class RJDPClient {
  private transport: ClientTransport;
  readonly transportType: Transport;
  readonly sessionId: string;
  readonly ip: string;
  readonly scopes: Scope[];
  readonly capabilities: Capability[];
  readonly expiresAt: number;
  private pendingFrames = new Map<string, (frame: Frame) => void>();
  private streamHandlers = new Map<string, FrameHandler>();

  private constructor(result: NegotiateResult) {
    this.transport = result.transport;
    this.transportType = result.transportType;
    this.sessionId = result.sessionId;
    this.ip = result.ip;
    this.scopes = result.scopes;
    this.capabilities = result.capabilities;
    this.expiresAt = result.expiresAt;

    // Route incoming frames to pending resolvers or stream handlers
    this.transport.onFrame((frame) => {
      // Check stream handlers first (exec stdout/stderr/exit)
      const streamHandler = this.streamHandlers.get(frame.id);
      if (streamHandler) {
        streamHandler(frame);
        if (frame.type === "exec.exit" || frame.type === "error") {
          this.streamHandlers.delete(frame.id);
        }
        return;
      }

      // Check pending one-shot resolvers
      const resolver = this.pendingFrames.get(frame.id);
      if (resolver) {
        this.pendingFrames.delete(frame.id);
        resolver(frame);
      }
    });
  }

  /** Connect to an RJDP server */
  static async connect(url: string, opts: ClientOptions): Promise<RJDPClient> {
    const result = await negotiate(url, opts);
    return new RJDPClient(result);
  }

  /** Generate a new ECDSA P-384 key pair */
  static generateKeyPair = generateKeyPair;

  /** Get the fingerprint of a public key (for ACL registration) */
  static fingerprint = fingerprint;

  /** Export a public key as JWK */
  static exportPublicKey = exportPublicKey;

  // --- Eval ---

  async eval(
    code: string,
    opts?: { timeout?: number; context?: Record<string, unknown> },
  ): Promise<EvalResponse> {
    const frame = this.makeFrame<EvalRequest>("eval.req", {
      code,
      timeout: opts?.timeout,
      context: opts?.context,
    });

    const response = await this.sendAndWait(frame);
    if (response.type === "error") {
      throw new RJDPError(response.payload as { code: string; message: string });
    }
    return response.payload as EvalResponse;
  }

  // --- Exec ---

  exec(
    file: string,
    args?: string[],
    opts?: { env?: Record<string, string>; cwd?: string },
  ): ExecHandle {
    const frame = this.makeFrame<ExecRequest>("exec.req", {
      file,
      args,
      env: opts?.env,
      cwd: opts?.cwd,
    });

    const handle = new ExecHandle(frame.id, this);
    this.streamHandlers.set(frame.id, (f) => handle._onFrame(f));

    // On HTTP transport, use invoke (returns buffered exit) instead of streaming
    if (this.transport instanceof HTTPTransport) {
      this.transport.send(frame).catch((err) => handle._onError(err));
    } else {
      this.transport.send(frame).catch((err) => handle._onError(err));
    }

    return handle;
  }

  // --- FS ---

  readonly fs = {
    read: async (path: string): Promise<string> => {
      const res = await this.fsOp({ op: "read", path });
      if (res.op !== "read") throw new Error("Unexpected response");
      return res.content;
    },

    write: async (
      path: string,
      content: string,
      opts?: { encoding?: "utf8" | "base64" },
    ): Promise<void> => {
      await this.fsOp({ op: "write", path, content, encoding: opts?.encoding });
    },

    list: async (path: string): Promise<FsListEntry[]> => {
      const res = await this.fsOp({ op: "list", path });
      if (res.op !== "list") throw new Error("Unexpected response");
      return res.entries;
    },

    delete: async (path: string): Promise<void> => {
      await this.fsOp({ op: "delete", path });
    },

    stat: async (path: string): Promise<FsStat> => {
      const res = await this.fsOp({ op: "stat", path });
      if (res.op !== "stat") throw new Error("Unexpected response");
      return res.stat;
    },

    mkdir: async (path: string): Promise<void> => {
      await this.fsOp({ op: "mkdir", path });
    },

    rename: async (from: string, to: string): Promise<void> => {
      await this.fsOp({ op: "rename", from, to });
    },
  };

  // --- Cwd ---

  async setCwd(path: string): Promise<string> {
    const frame = this.makeFrame("cwd.set", { path });
    const response = await this.sendAndWait(frame);
    if (response.type === "error") {
      throw new RJDPError(response.payload as { code: string; message: string });
    }
    return (response.payload as { cwd: string }).cwd;
  }

  /** Register a handler for unexpected disconnects */
  onDisconnect(handler: () => void): void {
    this.transport.onDisconnect(handler);
  }

  /** Close the client and transport */
  close(): void {
    this.transport.close();
  }

  // --- Internal ---

  /** @internal */
  _sendKill(id: string): void {
    const frame = this.makeFrame("exec.kill", { signal: "SIGTERM" });
    // Reuse the same id so the server can find the process
    frame.id = id;
    this.transport.send(frame).catch(() => {});
  }

  private async fsOp(op: FsOp): Promise<FsResponse> {
    const frame = this.makeFrame<FsOp>("fs.req", op);
    const response = await this.sendAndWait(frame);
    if (response.type === "error") {
      throw new RJDPError(response.payload as { code: string; message: string });
    }
    return response.payload as FsResponse;
  }

  private sendAndWait(frame: Frame): Promise<Frame> {
    return new Promise((resolve, reject) => {
      this.pendingFrames.set(frame.id, resolve);
      this.transport.send(frame).catch((err) => {
        this.pendingFrames.delete(frame.id);
        reject(err);
      });
    });
  }

  private makeFrame<T>(type: string, payload: T): Frame<T> {
    return {
      id: crypto.randomUUID(),
      type: type as Frame["type"],
      ts: Date.now(),
      payload,
    };
  }
}

// --- Exec Handle ---

interface ExecChunk {
  type: "stdout" | "stderr";
  data: string;
}

export class ExecHandle {
  readonly id: string;
  private client: RJDPClient;
  private chunks: ExecChunk[] = [];
  private exitResult: ExecExit | null = null;
  private error: Error | null = null;
  private waiters: Array<() => void> = [];
  private done = false;

  constructor(id: string, client: RJDPClient) {
    this.id = id;
    this.client = client;
  }

  /** Async iterable over stdout chunks */
  get stdout(): AsyncIterable<string> {
    return this._iterChunks("stdout");
  }

  /** Async iterable over stderr chunks */
  get stderr(): AsyncIterable<string> {
    return this._iterChunks("stderr");
  }

  /** Async iterable over all output (stdout + stderr interleaved) */
  get output(): AsyncIterable<ExecChunk> {
    return this._iterAll();
  }

  /** Wait for the process to exit */
  async wait(): Promise<ExecExit> {
    while (!this.done) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    if (this.error) throw this.error;
    return this.exitResult!;
  }

  /** Send SIGTERM to the process */
  kill(): void {
    this.client._sendKill(this.id);
  }

  /** @internal */
  _onFrame(frame: Frame): void {
    switch (frame.type) {
      case "exec.stdout":
        this.chunks.push({ type: "stdout", data: (frame.payload as { chunk: string }).chunk });
        this._notify();
        break;
      case "exec.stderr":
        this.chunks.push({ type: "stderr", data: (frame.payload as { chunk: string }).chunk });
        this._notify();
        break;
      case "exec.exit":
        this.exitResult = frame.payload as ExecExit;
        // If buffered (HTTP transport), extract stdout/stderr chunks
        if (this.exitResult.stdout !== undefined) {
          this.chunks.push({ type: "stdout", data: this.exitResult.stdout });
        }
        if (this.exitResult.stderr !== undefined) {
          this.chunks.push({ type: "stderr", data: this.exitResult.stderr });
        }
        this.done = true;
        this._notify();
        break;
      case "error":
        this.error = new RJDPError(frame.payload as { code: string; message: string });
        this.done = true;
        this._notify();
        break;
    }
  }

  /** @internal */
  _onError(err: Error): void {
    this.error = err;
    this.done = true;
    this._notify();
  }

  private _notify(): void {
    const waiters = this.waiters.splice(0);
    for (const w of waiters) w();
  }

  // eslint-disable-next-line no-this-alias -- needed for async iterator protocol
  private _iterChunks(filter: "stdout" | "stderr"): AsyncIterable<string> {
    const { chunks, waiters } = this;
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const handle = this;
    return {
      [Symbol.asyncIterator]() {
        let cursor = 0;
        return {
          async next(): Promise<IteratorResult<string>> {
            while (true) {
              while (cursor < chunks.length) {
                const chunk = chunks[cursor]!;
                cursor++;
                if (chunk.type === filter) {
                  return { value: chunk.data, done: false };
                }
              }
              if (handle.done) return { value: undefined, done: true };
              await new Promise<void>((resolve) => waiters.push(resolve));
            }
          },
        };
      },
    };
  }

  // eslint-disable-next-line no-this-alias -- needed for async iterator protocol
  private _iterAll(): AsyncIterable<ExecChunk> {
    const { chunks, waiters } = this;
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const handle = this;
    return {
      [Symbol.asyncIterator]() {
        let cursor = 0;
        return {
          async next(): Promise<IteratorResult<ExecChunk>> {
            while (true) {
              if (cursor < chunks.length) {
                const chunk = chunks[cursor]!;
                cursor++;
                return { value: chunk, done: false };
              }
              if (handle.done) return { value: undefined, done: true };
              await new Promise<void>((resolve) => waiters.push(resolve));
            }
          },
        };
      },
    };
  }
}

// --- Error ---

export class RJDPError extends Error {
  readonly code: string;

  constructor(payload: { code: string; message: string }) {
    super(payload.message);
    this.name = "RJDPError";
    this.code = payload.code;
  }
}
