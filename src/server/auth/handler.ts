// Auth endpoint handlers: challenge + auth

import type { Scope, ChallengeResponse, AuthResponse } from "../../types.ts";
import type { Storage } from "../../types.ts";
import {
  generateNonce,
  exportPublicKey,
  importPublicKey,
  verify,
  fingerprint,
  b64ToBuffer,
} from "./_crypto.ts";
import { NonceCache } from "./_nonce.ts";
import { SessionStore } from "./_session.ts";

export interface AuthContext {
  nonceCache: NonceCache;
  sessionStore: SessionStore;
  serverKeyPair: CryptoKeyPair;
  acl: Record<string, Scope[]>;
}

export function createAuthContext(opts: {
  serverKeyPair: CryptoKeyPair;
  acl: Record<string, Scope[]>;
  sessionTtl?: number;
  storage?: Storage;
}): AuthContext {
  return {
    nonceCache: new NonceCache({ storage: opts.storage }),
    sessionStore: new SessionStore({ ttl: opts.sessionTtl, storage: opts.storage }),
    serverKeyPair: opts.serverKeyPair,
    acl: opts.acl,
  };
}

/** GET /.jdp/challenge */
export async function handleChallenge(ctx: AuthContext): Promise<Response> {
  const nonce = generateNonce();
  await ctx.nonceCache.issue(nonce);

  const serverPubJwk = await exportPublicKey(ctx.serverKeyPair.publicKey);
  const body: ChallengeResponse = {
    nonce,
    serverPubKey: btoa(JSON.stringify(serverPubJwk)),
    ttl: 30_000,
  };

  return Response.json(body);
}

/** POST /.jdp/auth */
export async function handleAuth(ctx: AuthContext, request: Request): Promise<Response> {
  let body: { sig: string; pubKey: string; nonce: string };
  try {
    body = await request.json();
  } catch {
    return Response.json({ code: "INVALID_BODY", message: "Invalid JSON body" }, { status: 400 });
  }

  if (!body.sig || !body.pubKey || !body.nonce) {
    return Response.json(
      { code: "MISSING_FIELDS", message: "Missing sig, pubKey, or nonce" },
      { status: 400 },
    );
  }

  // Validate nonce
  if (!(await ctx.nonceCache.consume(body.nonce))) {
    return Response.json(
      { code: "INVALID_NONCE", message: "Nonce is invalid, expired, or already used" },
      { status: 401 },
    );
  }

  // Import client public key and compute fingerprint
  let clientPubKey: CryptoKey;
  let fp: string;
  try {
    const jwk = JSON.parse(atob(body.pubKey));
    clientPubKey = await importPublicKey(jwk);
    fp = await fingerprint(clientPubKey);
  } catch {
    return Response.json({ code: "INVALID_KEY", message: "Invalid public key" }, { status: 400 });
  }

  // Check ACL (wildcard "*" grants scopes to any client)
  const scopes = ctx.acl[fp] ?? ctx.acl["*"];
  if (!scopes) {
    return Response.json(
      { code: "UNAUTHORIZED", message: "Public key not in ACL" },
      { status: 403 },
    );
  }

  // Verify signature
  const nonceBytes = b64ToBuffer(body.nonce);
  const sigBytes = b64ToBuffer(body.sig);
  const valid = await verify(
    clientPubKey,
    sigBytes.buffer.slice(
      sigBytes.byteOffset,
      sigBytes.byteOffset + sigBytes.byteLength,
    ) as ArrayBuffer,
    nonceBytes.buffer.slice(
      nonceBytes.byteOffset,
      nonceBytes.byteOffset + nonceBytes.byteLength,
    ) as ArrayBuffer,
  );
  if (!valid) {
    return Response.json(
      { code: "INVALID_SIGNATURE", message: "Signature verification failed" },
      { status: 401 },
    );
  }

  // Create session
  const ip = (request as unknown as { ip?: string }).ip ?? "";
  const session = await ctx.sessionStore.create(fp, scopes, ip);
  const result: AuthResponse = {
    sessionId: session.id,
    ip: session.ip,
    scopes: session.scopes,
    expiresAt: session.expiresAt,
  };

  return Response.json(result);
}

/** Extract and validate session from request headers or query param */
export async function getSession(ctx: AuthContext, request: Request) {
  const authHeader = request.headers.get("authorization");
  let sessionId: string | undefined;
  if (authHeader?.startsWith("RJDP-SESSION ")) {
    sessionId = authHeader.slice("RJDP-SESSION ".length);
  } else {
    sessionId = new URL(request.url).searchParams.get("session") ?? undefined;
  }
  return sessionId ? await ctx.sessionStore.get(sessionId) : undefined;
}
