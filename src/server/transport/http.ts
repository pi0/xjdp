// HTTP request/response transport — fallback with buffered exec and polling

import type { Frame, ExecStdout, ExecStderr, ExecExit } from "../../types.ts";
import type { Session } from "../auth/_session.ts";
import { routeFrame, type RouterContext } from "../router.ts";

interface BufferedExec {
  chunks: Array<{ type: "stdout" | "stderr"; data: string }>;
  exit?: Frame<ExecExit>;
  done: boolean;
}

/** Buffered exec output keyed by frame id */
const execBuffers = new Map<string, BufferedExec>();

/** POST /.jdp/invoke — single round-trip request/response */
export async function handleInvoke(
  session: Session,
  request: Request,
  ctx: RouterContext,
): Promise<Response> {
  let frame: Frame;
  try {
    frame = await request.json();
  } catch {
    return Response.json({ code: "INVALID_BODY", message: "Invalid JSON" }, { status: 400 });
  }

  // For exec, buffer the output and return exit frame
  if (frame.type === "exec.req") {
    return await handleBufferedExec(frame, session, ctx);
  }

  const result = await routeFrame(frame, session, ctx);
  if (result.response) {
    return Response.json(result.response);
  }
  return Response.json({ ok: true });
}

async function handleBufferedExec(
  frame: Frame,
  session: Session,
  ctx: RouterContext,
): Promise<Response> {
  const buffer: BufferedExec = { chunks: [], done: false };
  execBuffers.set(frame.id, buffer);

  return new Promise<Response>((resolve) => {
    const timeout = setTimeout(() => {
      if (!buffer.done) {
        buffer.done = true;
        resolve(
          Response.json({
            id: frame.id,
            type: "error",
            ts: Date.now(),
            payload: { code: "TIMEOUT", message: "Exec timeout on HTTP transport" },
          }),
        );
      }
    }, 10_000);

    routeFrame(frame, session, ctx, {
      onStdout: (f: Frame<ExecStdout>) => {
        buffer.chunks.push({ type: "stdout", data: f.payload.chunk });
      },
      onStderr: (f: Frame<ExecStderr>) => {
        buffer.chunks.push({ type: "stderr", data: f.payload.chunk });
      },
      onExit: (f: Frame<ExecExit>) => {
        clearTimeout(timeout);
        buffer.done = true;
        buffer.exit = f;

        // Include buffered stdout/stderr in exit frame
        const stdout = buffer.chunks
          .filter((c) => c.type === "stdout")
          .map((c) => c.data)
          .join("");
        const stderr = buffer.chunks
          .filter((c) => c.type === "stderr")
          .map((c) => c.data)
          .join("");

        const exitFrame: Frame<ExecExit> = {
          ...f,
          payload: { ...f.payload, stdout, stderr },
        };
        resolve(Response.json(exitFrame));
      },
    }).then((result) => {
      // routeFrame may return an error (e.g. FORBIDDEN) without calling onExit
      if (result.response) {
        clearTimeout(timeout);
        buffer.done = true;
        resolve(Response.json(result.response));
      }
    });
  });
}

/** GET /.jdp/poll?id=<execId>&cursor=<n> — poll for exec chunks */
export function handlePoll(request: Request): Response {
  const url = new URL(request.url);
  const id = url.searchParams.get("id");
  const cursor = Number.parseInt(url.searchParams.get("cursor") ?? "0", 10);

  if (!id) {
    return Response.json({ code: "MISSING_ID", message: "Missing id parameter" }, { status: 400 });
  }

  const buffer = execBuffers.get(id);
  if (!buffer) {
    return Response.json({ code: "NOT_FOUND", message: "No exec with this id" }, { status: 404 });
  }

  const chunks = buffer.chunks.slice(cursor);
  const next = buffer.chunks.length;
  const done = buffer.done;

  // Clean up completed buffers after polling
  if (done && next === cursor) {
    execBuffers.delete(id);
  }

  return Response.json({ chunks, next, done });
}
