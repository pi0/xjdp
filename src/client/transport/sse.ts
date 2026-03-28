// SSE client transport — uses EventSource when available, falls back to fetch() streaming

import type { Frame } from "../../types.ts";
import type { ClientTransport, DisconnectHandler, FrameHandler } from "./_base.ts";

const FRAME_TYPES = [
  "eval.res",
  "exec.stdout",
  "exec.stderr",
  "exec.exit",
  "fs.res",
  "cwd.res",
  "pong",
  "error",
  "connected",
];

export class SSETransport implements ClientTransport {
  private baseUrl: string;
  private sessionId: string;
  private handlers: FrameHandler[] = [];
  private disconnectHandlers: DisconnectHandler[] = [];
  private abortController = new AbortController();
  private eventSource: EventSource | null = null;
  private closed = false;

  constructor(baseUrl: string, sessionId: string) {
    this.baseUrl = baseUrl;
    this.sessionId = sessionId;
  }

  async connect(): Promise<void> {
    if (typeof globalThis.EventSource !== "undefined") {
      return this._connectEventSource();
    }
    return this._connectFetch();
  }

  async send(frame: Frame): Promise<void> {
    const response = await fetch(`${this.baseUrl}/.jdp/send`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `RJDP-SESSION ${this.sessionId}`,
      },
      body: JSON.stringify(frame),
      signal: this.abortController.signal,
    });

    if (!response.ok) {
      const body = await response.json().catch(() => null);
      throw new Error(body?.message ?? `Send failed: ${response.status}`);
    }
  }

  onFrame(handler: FrameHandler): void {
    this.handlers.push(handler);
  }

  onDisconnect(handler: DisconnectHandler): void {
    this.disconnectHandlers.push(handler);
  }

  close(): void {
    this.closed = true;
    this.eventSource?.close();
    this.eventSource = null;
    this.abortController.abort();
  }

  // --- EventSource (browser / polyfilled environments) ---

  private _connectEventSource(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const url = `${this.baseUrl}/.jdp/stream?session=${encodeURIComponent(this.sessionId)}`;
      this.eventSource = new EventSource(url);

      const onConnected = () => {
        this.eventSource!.removeEventListener("connected", onConnected);
        resolve();
      };

      this.eventSource.addEventListener("connected", onConnected);

      this.eventSource.onerror = () => {
        if (!this.eventSource || this.eventSource.readyState === EventSource.CLOSED) {
          reject(new Error("SSE connection failed"));
          if (!this.closed) this._emitDisconnect();
        }
      };

      for (const type of FRAME_TYPES) {
        this.eventSource.addEventListener(type, (event: MessageEvent) => {
          if (!event.data) return;
          const frame: Frame = JSON.parse(event.data);
          this._emit(frame);
        });
      }
    });
  }

  // --- fetch() streaming fallback (Node.js) ---

  private async _connectFetch(): Promise<void> {
    const url = `${this.baseUrl}/.jdp/stream`;
    const response = await fetch(url, {
      headers: {
        accept: "text/event-stream",
        authorization: `RJDP-SESSION ${this.sessionId}`,
      },
      signal: this.abortController.signal,
    });

    if (!response.ok || !response.body) {
      throw new Error(`SSE connection failed: ${response.status}`);
    }

    // Read stream in background
    void this._readStream(response.body);

    // Wait for "connected" event
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("SSE connect timeout")), 10_000);
      const handler = (frame: Frame) => {
        if ((frame as unknown as { sessionId?: string }).sessionId) {
          clearTimeout(timeout);
          this.handlers = this.handlers.filter((h) => h !== handler);
          resolve();
        }
      };
      this.handlers.push(handler);
    });
  }

  private async _readStream(body: ReadableStream<Uint8Array>): Promise<void> {
    const decoder = new TextDecoder();
    const reader = body.getReader();
    let buffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // Parse complete SSE events (double newline delimited)
        const parts = buffer.split("\n\n");
        buffer = parts.pop()!;

        for (const part of parts) {
          const frame = parseSSE(part);
          if (frame) this._emit(frame);
        }
      }
      // Stream ended — if not intentionally closed, it's a disconnect
      if (!this.closed) this._emitDisconnect();
    } catch {
      // Stream error — if not intentionally closed, it's a disconnect
      if (!this.closed) this._emitDisconnect();
    }
  }

  private _emit(frame: Frame): void {
    for (const handler of this.handlers) handler(frame);
  }

  private _emitDisconnect(): void {
    for (const handler of this.disconnectHandlers) handler();
  }
}

function parseSSE(block: string): Frame | null {
  let data = "";
  for (const line of block.split("\n")) {
    if (line.startsWith("data: ")) {
      data += line.slice(6);
    }
  }
  if (!data) return null;
  try {
    return JSON.parse(data);
  } catch {
    return null;
  }
}
