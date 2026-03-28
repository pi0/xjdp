# XJDP — Remote JS Debugging Protocol

Lightweight protocol for remotely debugging Node.js server deployments over HTTP.

## Architecture

```
src/
├── types.ts                    # Shared Frame, payload, and config types
├── index.ts                    # Public exports (createServer, RJDPClient, types)
├── client/
│   ├── client.ts               # RJDPClient — main API (eval, exec, fs), ExecHandle
│   ├── _crypto.ts              # Client Web Crypto helpers (keygen, sign, fingerprint)
│   ├── _negotiate.ts           # Transport negotiation + auth handshake
│   └── transport/
│       ├── _base.ts            # ClientTransport interface
│       ├── sse.ts              # SSE client (EventSource + POST)
│       └── http.ts             # HTTP fallback (invoke + polling)
├── cli/
│   └── index.ts                # Interactive REPL (eval, exec, fs commands)
└── server/
    ├── handler.ts              # Main fetch() handler — routes /.jdp/* endpoints
    ├── router.ts               # Frame router + scope enforcement
    ├── _storage.ts             # MemoryStorage default impl of Storage interface
    ├── auth/
    │   ├── _crypto.ts          # ECDSA P-384 Web Crypto helpers (sign, verify, fingerprint)
    │   ├── _nonce.ts           # Nonce cache (replay prevention, 30s TTL) — backed by Storage
    │   ├── _session.ts         # Session store (configurable TTL) — backed by Storage
    │   └── handler.ts          # Auth endpoints: challenge, auth, getSession
    ├── sysinfo/
    │   └── handler.ts          # Server-side system info (no eval permission needed)
    ├── eval/
    │   └── handler.ts          # Single-shot JS eval via AsyncFunction
    ├── exec/
    │   └── handler.ts          # Streaming child_process.spawn with env denylist
    ├── fs/
    │   ├── _jail.ts            # PathJail — path traversal + symlink escape prevention
    │   └── handler.ts          # File ops: read, write, list, delete, stat, mkdir, rename
    └── transport/
        ├── sse.ts              # SSE transport (GET /.jdp/stream + POST /.jdp/send)
        └── http.ts             # HTTP fallback (POST /.jdp/invoke + GET /.jdp/poll)
```

## Key Concepts

- **Four capabilities**: `eval` (JS execution), `exec` (process spawn), `fs` (file ops), `sysinfo` (server-gathered system info, no scope required)
- **Two transports**: SSE (streaming) and HTTP (request/response fallback with polling)
- **Auth**: ECDSA P-384 challenge-response with public key ACL and scoped sessions. Keys are optional — `RJDPClient.connect()` auto-generates an ephemeral key pair when none provided (for wildcard ACL / readonly access)
- **Security**: path jail with symlink check, env denylist, nonce replay prevention, per-session rate limits
- **Pluggable storage**: `SessionStore` and `NonceCache` are backed by a `Storage` interface (default: in-memory). For serverless/multi-instance deployments, pass a custom `Storage` via `ServerConfig.storage` (e.g., Redis, Deno KV, Netlify Blobs). The interface is `get`/`set`/`delete` with optional TTL, supporting both sync and async returns.

## Dev Commands

- `pnpm dev` — watch mode
- `pnpm test` — lint + typecheck
- `pnpm fmt` — auto-fix lint + format
- `pnpm typecheck` — tsgo type checking

## SSE Frame Types

The `FRAME_TYPES` list in `src/client/transport/sse.ts` must include **every** event type the server can send. The `EventSource` API only dispatches events with registered listeners — unlisted types are silently dropped, causing `sendAndWait` to hang forever. The `_connectFetch` (Node.js) path parses all events from the raw stream, so missing types only break the browser `EventSource` path.

Current server-sent types: `eval.res`, `exec.stdout`, `exec.stderr`, `exec.exit`, `fs.res`, `cwd.res`, `sysinfo.res`, `pong`, `error`, `connected`.

## Web Terminal (`src/cli/web.ts`)

- The web readline polyfill reimplements Node's `readline/promises` for xterm.js
- `promptVisible` gates input: set `false` on Enter (blocks input during command execution), set `true` by `showPrompt()`
- Lines submitted while `lineResolve` is null are queued in `pendingLines` and drained by the async iterator's `next()`
- SIGINT (`\x03`) delegates to registered listeners (matching Node readline behavior), falls back to inline `showPrompt()`

## Conventions

- ESM only, `.ts` extensions in imports
- Internal files prefixed with `_`
- Web Crypto API only (no OpenSSL/third-party crypto)
- Server exports `{ fetch(request: Request): Promise<Response> }` pattern
