// Transport negotiation — discover server capabilities and pick best transport

import type {
  InfoResponse,
  Transport,
  Capability,
  ChallengeResponse,
  AuthResponse,
  Scope,
} from "../types.ts";
import { sign, exportPublicKey, bufferToB64, b64ToBuffer } from "./_crypto.ts";
import { SSETransport } from "./transport/sse.ts";
import { HTTPTransport } from "./transport/http.ts";
import type { ClientTransport } from "./transport/_base.ts";

export interface NegotiateResult {
  transport: ClientTransport;
  transportType: Transport;
  sessionId: string;
  ip: string;
  scopes: Scope[];
  capabilities: Capability[];
  expiresAt: number;
}

export async function negotiate(
  baseUrl: string,
  opts: {
    privateKey: CryptoKey;
    publicKey: CryptoKey;
    transports?: Transport[];
    serverFingerprint?: string;
  },
): Promise<NegotiateResult> {
  baseUrl = baseUrl.replace(/\/+$/, "");

  // 1. Discover server capabilities
  const infoRes = await fetch(`${baseUrl}/.jdp/info`);
  if (!infoRes.ok) throw new Error(`Info request failed: ${infoRes.status}`);
  const info: InfoResponse = await parseJSON(infoRes, "info");

  // 2. Verify server fingerprint prefix (if provided)
  if (opts.serverFingerprint && !info.fingerprint.startsWith(opts.serverFingerprint)) {
    throw new Error(
      `Server fingerprint mismatch.\n  Expected: ${opts.serverFingerprint}…\n  Got:      ${info.fingerprint}`,
    );
  }

  // 2. Authenticate
  const auth = await authenticate(baseUrl, opts.privateKey, opts.publicKey);

  // 3. Pick best transport
  const preferred = opts.transports ?? ["sse", "http"];
  const available = info.transports;
  const pick = preferred.find((t) => available.includes(t));
  if (!pick) {
    throw new Error(`No compatible transport. Server: [${available}], Client: [${preferred}]`);
  }

  // 4. Create transport
  const transport = createTransport(pick, baseUrl, auth.sessionId);

  // 5. Connect (SSE needs to establish the stream)
  if (transport instanceof SSETransport) {
    await transport.connect();
  }

  return {
    transport,
    transportType: pick,
    sessionId: auth.sessionId,
    ip: auth.ip,
    scopes: auth.scopes,
    capabilities: info.capabilities,
    expiresAt: auth.expiresAt,
  };
}

async function authenticate(
  baseUrl: string,
  privateKey: CryptoKey,
  publicKey: CryptoKey,
): Promise<AuthResponse> {
  // Get challenge
  const challengeRes = await fetch(`${baseUrl}/.jdp/challenge`);
  if (!challengeRes.ok) throw new Error(`Challenge request failed: ${challengeRes.status}`);
  const challenge: ChallengeResponse = await parseJSON(challengeRes, "challenge");

  // Sign the nonce
  const nonceBuffer = b64ToBuffer(challenge.nonce);
  const signature = await sign(privateKey, nonceBuffer);

  // Send auth
  const pubJwk = await exportPublicKey(publicKey);
  const authRes = await fetch(`${baseUrl}/.jdp/auth`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      sig: bufferToB64(signature),
      pubKey: btoa(JSON.stringify(pubJwk)),
      nonce: challenge.nonce,
    }),
  });

  if (!authRes.ok) {
    const body = await parseJSON<{ message?: string }>(authRes, "auth").catch(() => null);
    throw new Error(body?.message ?? `Auth failed: ${authRes.status}`);
  }

  return parseJSON(authRes, "auth");
}

async function parseJSON<T>(res: Response, endpoint: string): Promise<T> {
  const ct = res.headers.get("content-type") ?? "";
  if (!ct.includes("application/json")) {
    const preview = (await res.text()).slice(0, 80);
    throw new Error(
      `Expected JSON from /.jdp/${endpoint} but got ${ct || "unknown content-type"}: ${preview}`,
    );
  }
  return res.json();
}

function createTransport(type: Transport, baseUrl: string, sessionId: string): ClientTransport {
  switch (type) {
    case "sse":
      return new SSETransport(baseUrl, sessionId);
    case "http":
      return new HTTPTransport(baseUrl, sessionId);
    default:
      throw new Error(`Transport "${type}" not yet implemented`);
  }
}
