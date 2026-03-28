// HTTP fallback transport — request/response + polling for exec

import type { Frame } from "../../types.ts";
import type { ClientTransport, FrameHandler } from "./_base.ts";

export class HTTPTransport implements ClientTransport {
  private baseUrl: string;
  private sessionId: string;
  private handlers: FrameHandler[] = [];
  private abortController = new AbortController();
  private pollingIntervals = new Map<string, ReturnType<typeof setInterval>>();

  constructor(baseUrl: string, sessionId: string) {
    this.baseUrl = baseUrl;
    this.sessionId = sessionId;
  }

  async send(frame: Frame): Promise<void> {
    const response = await fetch(`${this.baseUrl}/.jdp/invoke`, {
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
      throw new Error(body?.message ?? `Invoke failed: ${response.status}`);
    }

    const result: Frame = await response.json();
    for (const handler of this.handlers) handler(result);
  }

  /** Start polling for exec output chunks */
  startPolling(execId: string, opts?: { interval?: number }): void {
    const interval = opts?.interval ?? 500;
    let cursor = 0;

    const poll = async () => {
      try {
        const url = `${this.baseUrl}/.jdp/poll?id=${encodeURIComponent(execId)}&cursor=${cursor}`;
        const response = await fetch(url, {
          headers: { authorization: `RJDP-SESSION ${this.sessionId}` },
          signal: this.abortController.signal,
        });

        if (!response.ok) return;
        const data: { chunks: Array<{ type: string; data: string }>; next: number; done: boolean } =
          await response.json();

        // Emit chunks as frames
        for (const chunk of data.chunks) {
          const frame: Frame = {
            id: execId,
            type: chunk.type === "stdout" ? "exec.stdout" : "exec.stderr",
            ts: Date.now(),
            payload: { chunk: chunk.data },
          };
          for (const handler of this.handlers) handler(frame);
        }

        cursor = data.next;
        if (data.done) {
          this.stopPolling(execId);
        }
      } catch {
        // Silently ignore polling errors (connection closed, etc.)
      }
    };

    const id = setInterval(poll, interval);
    this.pollingIntervals.set(execId, id);
    // Immediate first poll
    void poll();
  }

  stopPolling(execId: string): void {
    const id = this.pollingIntervals.get(execId);
    if (id) {
      clearInterval(id);
      this.pollingIntervals.delete(execId);
    }
  }

  onFrame(handler: FrameHandler): void {
    this.handlers.push(handler);
  }

  onDisconnect(_handler: () => void): void {
    // HTTP transport is stateless — no persistent connection to lose
  }

  close(): void {
    this.abortController.abort();
    for (const id of this.pollingIntervals.values()) clearInterval(id);
    this.pollingIntervals.clear();
  }
}
