// Frame router — dispatches frames to capability handlers with scope enforcement

import type {
  Frame,
  FrameType,
  Scope,
  EvalRequest,
  ExecRequest,
  ExecKill,
  FsOp,
  CwdSetRequest,
  CwdResponse,
} from "../types.ts";
import type { Session } from "./auth/_session.ts";
import { handleEval } from "./eval/handler.ts";
import {
  handleExec,
  handleExecKill,
  type ExecCallbacks,
  type ExecContext,
} from "./exec/handler.ts";
import { handleFs, type FsContext } from "./fs/handler.ts";

/** Maps frame types to required scopes */
const SCOPE_MAP: Partial<Record<FrameType, Scope>> = {
  "eval.req": "eval",
  "exec.req": "exec",
  "exec.kill": "exec",
  "fs.req": undefined, // checked per-op in routeFs
};

/** Determines the required scope for an fs operation */
function fsScope(op: FsOp): Scope {
  switch (op.op) {
    case "read":
    case "list":
    case "stat":
      return "fs:read";
    case "write":
    case "delete":
    case "mkdir":
    case "rename":
      return "fs:write";
  }
}

export interface RouterContext {
  execCtx: ExecContext;
  fsCtx: FsContext;
  evalTimeout?: number;
  maxConcurrentExec?: number;
}

export interface RouteResult {
  /** Immediate response frame (for eval, fs, errors) */
  response?: Frame;
  /** Whether the frame initiated a stream (exec) */
  streaming?: boolean;
}

/**
 * Route a single frame. Returns an immediate response for eval/fs/errors,
 * or starts a streaming exec process.
 */
export async function routeFrame(
  frame: Frame,
  session: Session,
  ctx: RouterContext,
  execCallbacks?: ExecCallbacks,
): Promise<RouteResult> {
  // Scope check
  if (frame.type === "fs.req") {
    const scope = fsScope(frame.payload as FsOp);
    if (!session.scopes.includes(scope)) {
      return { response: errorFrame(frame.id, "FORBIDDEN", `Missing scope: ${scope}`) };
    }
  } else {
    const requiredScope = SCOPE_MAP[frame.type];
    if (requiredScope && !session.scopes.includes(requiredScope)) {
      return { response: errorFrame(frame.id, "FORBIDDEN", `Missing scope: ${requiredScope}`) };
    }
  }

  switch (frame.type) {
    case "eval.req": {
      const result = await handleEval(frame as Frame<EvalRequest>, { timeout: ctx.evalTimeout });
      return { response: result };
    }

    case "exec.req": {
      const maxConcurrent = ctx.maxConcurrentExec ?? 3;
      if (session.activeExecCount >= maxConcurrent) {
        return {
          response: errorFrame(frame.id, "LIMIT_EXCEEDED", "Max concurrent exec processes reached"),
        };
      }
      if (!execCallbacks) {
        return {
          response: errorFrame(
            frame.id,
            "NO_STREAM",
            "Exec requires a streaming transport or buffered handler",
          ),
        };
      }
      session.activeExecCount++;
      // Inject session cwd as default if not specified in request
      const execFrame = frame as Frame<ExecRequest>;
      if (!execFrame.payload.cwd) {
        execFrame.payload.cwd = session.cwd;
      }
      const originalOnExit = execCallbacks.onExit;
      handleExec(execFrame, ctx.execCtx, {
        ...execCallbacks,
        onExit: (exitFrame) => {
          session.activeExecCount--;
          originalOnExit(exitFrame);
        },
      });
      return { streaming: true };
    }

    case "exec.kill": {
      const killed = handleExecKill(frame as Frame<ExecKill>);
      if (!killed) {
        return { response: errorFrame(frame.id, "NOT_FOUND", "No active process with this id") };
      }
      return {};
    }

    case "fs.req": {
      const result = await handleFs(frame as Frame<FsOp>, ctx.fsCtx);
      return { response: result };
    }

    case "cwd.set": {
      const { path } = (frame as Frame<CwdSetRequest>).payload;
      session.cwd = path;
      const res: Frame<CwdResponse> = {
        id: frame.id,
        type: "cwd.res",
        ts: Date.now(),
        payload: { cwd: session.cwd },
      };
      return { response: res };
    }

    case "ping": {
      return { response: { id: frame.id, type: "pong", ts: Date.now(), payload: {} } };
    }

    default:
      return {
        response: errorFrame(frame.id, "UNKNOWN_TYPE", `Unknown frame type: ${frame.type}`),
      };
  }
}

function errorFrame(id: string, code: string, message: string): Frame {
  return { id, type: "error", ts: Date.now(), payload: { code, message } };
}
