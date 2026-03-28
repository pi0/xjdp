// SSE transport — server-to-client streaming via text/event-stream

import type { Frame } from "../../types.ts";
import type { Session } from "../auth/_session.ts";
import { routeFrame, type RouterContext } from "../router.ts";

/** Active SSE connections keyed by sessionId */
const sseConnections = new Map<string, ReadableStreamDefaultController<Uint8Array>>();

const encoder = new TextEncoder();

/** GET /.jdp/stream — opens an SSE connection */
export function handleStream(session: Session): Response {
  // Close existing connection for this session
  const existing = sseConnections.get(session.id);
  if (existing) {
    try {
      existing.close();
    } catch {}
    sseConnections.delete(session.id);
  }

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      sseConnections.set(session.id, controller);
      // Send initial connected event
      sendEvent(controller, "connected", { sessionId: session.id });
    },
    cancel() {
      sseConnections.delete(session.id);
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    },
  });
}

/** POST /.jdp/send — client sends a frame, response frames are pushed via SSE */
export async function handleSend(
  session: Session,
  request: Request,
  ctx: RouterContext,
): Promise<Response> {
  const controller = sseConnections.get(session.id);
  if (!controller) {
    return Response.json(
      { code: "NO_STREAM", message: "No active SSE stream for this session" },
      { status: 400 },
    );
  }

  let frame: Frame;
  try {
    frame = await request.json();
  } catch {
    return Response.json({ code: "INVALID_BODY", message: "Invalid JSON" }, { status: 400 });
  }

  const sendFrame = (f: Frame) => sendEvent(controller, f.type, f);

  const result = await routeFrame(frame, session, ctx, {
    onStdout: sendFrame,
    onStderr: sendFrame,
    onExit: sendFrame,
  });

  if (result.response) {
    sendEvent(controller, result.response.type, result.response);
  }

  return Response.json({ ok: true });
}

function sendEvent(
  controller: ReadableStreamDefaultController<Uint8Array>,
  event: string,
  data: unknown,
): void {
  let json: string;
  try {
    json = JSON.stringify(data);
  } catch {
    json = JSON.stringify({ error: "Failed to serialize response" });
  }
  const payload = `event: ${event}\ndata: ${json}\n\n`;
  try {
    controller.enqueue(encoder.encode(payload));
  } catch {
    // Stream closed
  }
}

/** Check if a session has an active SSE connection */
export function hasSSEConnection(sessionId: string): boolean {
  return sseConnections.has(sessionId);
}
