// Shared protocol types for RJDP (Remote JS Debugging Protocol)

export type FrameType =
  | "eval.req"
  | "eval.res"
  | "exec.req"
  | "exec.stdout"
  | "exec.stderr"
  | "exec.exit"
  | "exec.kill"
  | "fs.req"
  | "fs.res"
  | "cwd.set"
  | "cwd.res"
  | "ping"
  | "pong"
  | "error";

export interface Frame<T = unknown> {
  id: string;
  type: FrameType;
  ts: number;
  payload: T;
}

// --- Eval ---

export interface EvalRequest {
  code: string;
  timeout?: number;
  context?: Record<string, unknown>;
}

export interface EvalResponse {
  result: unknown;
  logs: Array<{ level: string; args: unknown[] }>;
  duration_ms: number;
}

// --- Exec ---

export interface ExecRequest {
  file: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}

export interface ExecStdout {
  chunk: string;
}

export interface ExecStderr {
  chunk: string;
}

export interface ExecExit {
  code: number | null;
  signal: string | null;
  duration_ms: number;
  // Buffered output for HTTP fallback
  stdout?: string;
  stderr?: string;
}

export interface ExecKill {
  signal?: string;
}

// --- FS ---

export type FsOp =
  | { op: "read"; path: string }
  | { op: "write"; path: string; content: string; encoding?: "utf8" | "base64" }
  | { op: "list"; path: string }
  | { op: "delete"; path: string }
  | { op: "stat"; path: string }
  | { op: "mkdir"; path: string }
  | { op: "rename"; from: string; to: string };

export interface FsStat {
  size: number;
  isFile: boolean;
  isDirectory: boolean;
  mtime: number;
}

export interface FsListEntry {
  name: string;
  isFile: boolean;
  isDirectory: boolean;
}

export type FsResponse =
  | { op: "read"; content: string; encoding: "utf8" | "base64"; size: number }
  | { op: "write"; ok: true }
  | { op: "list"; entries: FsListEntry[] }
  | { op: "delete"; ok: true }
  | { op: "stat"; stat: FsStat }
  | { op: "mkdir"; ok: true }
  | { op: "rename"; ok: true };

// --- Cwd ---

export interface CwdSetRequest {
  path: string;
}

export interface CwdResponse {
  cwd: string;
}

// --- Error ---

export interface ErrorPayload {
  code: string;
  message: string;
}

// --- Info / Discovery ---

export type Transport = "sse" | "http";
export type Capability = "eval" | "exec" | "fs" | "fs:read" | "fs:write";
export type Scope = "eval" | "exec" | "fs:read" | "fs:write";

export interface InfoResponse {
  transports: Transport[];
  capabilities: Capability[];
  fingerprint: string;
}

export interface ChallengeResponse {
  nonce: string; // base64
  serverPubKey: string; // JWK base64
  ttl: number;
}

export interface AuthRequest {
  sig: string; // base64
  pubKey: string; // JWK base64
}

export interface AuthResponse {
  sessionId: string;
  ip: string;
  scopes: Scope[];
  expiresAt: number;
}

// --- Server Config ---

export interface ServerConfig {
  /** Allowed transports (default: all) */
  transports?: Transport[];
  /** Allowed capabilities (default: all) */
  capabilities?: Capability[];
  /** ACL: maps key fingerprints to scopes */
  acl: Record<string, Scope[]>;
  /** Server ECDSA P-384 key pair */
  serverKeyPair: CryptoKeyPair;
  /** FS jail root (default: /workspace) */
  fsRoot?: string;
  /** Max read file size in bytes (default: 10MB) */
  maxReadSize?: number;
  /** Max frame size in bytes (default: 5MB) */
  maxFrameSize?: number;
  /** Session TTL in ms (default: 1h) */
  sessionTtl?: number;
  /** Max concurrent exec processes per session (default: 3) */
  maxConcurrentExec?: number;
  /** Eval timeout in ms (default: 5000) */
  evalTimeout?: number;
  /** Env denylist patterns for exec */
  envDenylist?: RegExp[];
}
