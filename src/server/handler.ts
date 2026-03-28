// Main server fetch handler — routes /.jdp/* endpoints

import type { ServerConfig, InfoResponse, Transport, Capability } from "../types.ts";
import { fingerprint } from "./auth/_crypto.ts";
import {
  createAuthContext,
  handleChallenge,
  handleAuth,
  getSession,
  type AuthContext,
} from "./auth/handler.ts";
import { createExecContext } from "./exec/handler.ts";
import { createFsContext } from "./fs/handler.ts";
import { handleStream, handleSend } from "./transport/sse.ts";
import { handleInvoke, handlePoll } from "./transport/http.ts";
import type { RouterContext } from "./router.ts";

export interface ServerInstance {
  fetch: (request: Request) => Promise<Response>;
}

export function createServer(config: ServerConfig): ServerInstance {
  const serverFp = fingerprint(config.serverKeyPair.publicKey);

  const authCtx = createAuthContext({
    serverKeyPair: config.serverKeyPair,
    acl: config.acl,
    sessionTtl: config.sessionTtl,
  });

  const execCtx = createExecContext({
    maxConcurrent: config.maxConcurrentExec,
    envDenylist: config.envDenylist,
  });

  const fsCtx = createFsContext({
    fsRoot: config.fsRoot,
    maxReadSize: config.maxReadSize,
  });

  const routerCtx: RouterContext = {
    execCtx,
    fsCtx,
    evalTimeout: config.evalTimeout,
    maxConcurrentExec: config.maxConcurrentExec,
  };

  const transports: Transport[] = config.transports ?? ["sse", "http"];
  const capabilities: Capability[] = config.capabilities ?? ["eval", "exec", "fs"];

  return {
    fetch: (request: Request) =>
      handleRequest(request, { authCtx, routerCtx, transports, capabilities, serverFp }),
  };
}

interface HandlerContext {
  authCtx: AuthContext;
  routerCtx: RouterContext;
  transports: Transport[];
  capabilities: Capability[];
  serverFp: Promise<string>;
}

async function handleRequest(request: Request, ctx: HandlerContext): Promise<Response> {
  const url = new URL(request.url);
  const pathname = url.pathname;

  // Only handle /.jdp/* routes
  if (!pathname.startsWith("/.jdp/")) {
    return new Response("Not Found", { status: 404 });
  }

  const route = pathname.slice("/.jdp/".length);

  // Public endpoints (no auth required)
  switch (route) {
    case "info":
      return handleInfo(ctx);
    case "challenge":
      return handleChallenge(ctx.authCtx);
    case "auth":
      return handleAuth(ctx.authCtx, request);
  }

  // All other routes require a valid session
  const session = getSession(ctx.authCtx, request);
  if (!session) {
    return Response.json(
      { code: "UNAUTHORIZED", message: "Valid session required" },
      { status: 401 },
    );
  }

  // Authenticated endpoints
  switch (route) {
    // SSE transport
    case "stream":
      return handleStream(session);
    case "send":
      return handleSend(session, request, ctx.routerCtx);

    // HTTP fallback transport
    case "invoke":
      return handleInvoke(session, request, ctx.routerCtx);
    case "poll":
      return handlePoll(request);

    default:
      return Response.json(
        { code: "NOT_FOUND", message: `Unknown route: /.jdp/${route}` },
        { status: 404 },
      );
  }
}

async function handleInfo(ctx: HandlerContext): Promise<Response> {
  const body: InfoResponse = {
    transports: ctx.transports,
    capabilities: ctx.capabilities,
    fingerprint: await ctx.serverFp,
  };
  return Response.json(body);
}
