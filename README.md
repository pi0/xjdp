# 🐚 xjdp

Remote shell for JavaScript servers.

Eval, exec, and filesystem access to any running JavaScript server over HTTP — with ECDSA public-key auth, scoped permissions, and path-jailed filesystem.

**Built for AI agents and curious humans!** Connect an agent to a remote server and let it inspect state, run commands, read logs, and edit files. Turning any deployment into an interactive sandbox.

- Zero dependencies.
- Isomorphic client (browser, Node.js, AI agents)
- SSE streaming with HTTP polling fallback
- Path-jailed filesystem, env-filtered exec, scoped permissions

## Demos

- **Vercel:** https://xjdp.vercel.app/
- **Netlify:** https://xjdp.netlify.app/
- **Deno:** https://xjdp.pi0.deno.net/

## Quick Start

### 1. Set up a server

The server exports a standard `{ fetch }` handler that works with any runtime (Node.js via [srvx](https://srvx.h3.dev), Bun, Deno, etc).

```ts
import { serve } from "srvx";
import { createServer, generateKeyPair, fingerprint } from "xjdp";

const serverKeyPair = await generateKeyPair();

// Clients use this to verify the server identity
console.log("fingerprint:", await fingerprint(serverKeyPair.publicKey));

const server = createServer({
  serverKeyPair,
  acl: {
    // Grant any client read-only access
    "*": ["fs:read"],
  },
});

serve({ fetch: server.fetch, port: 3000 });
```

### 2. Generate a client key

```bash
npx xjdp keygen
```

This outputs everything you need:

```
Generated ECDSA P-384 key pair

Fingerprint:
9b4270452ef7f75efc0...

Private key (pass via -k flag):
eyJrdHkiOiJFQyIs...

ACL entry (paste into server config):
"9b4270452ef7...": ["eval","exec","fs:read","fs:write"]

Connect:
npx xjdp -u http://localhost:3000 -k eyJrdHkiOiJFQyIs...
```

Copy the ACL entry into your server's `acl` config:

```ts
acl: {
  "*": ["fs:read"],
  "9b4270452ef7...": ["eval", "exec", "fs:read", "fs:write"],
},
```

### 3. Connect

```bash
npx xjdp -u http://localhost:3000 -k eyJrdHkiOiJFQyIs...
```

### Programmatic API

```ts
import { RJDPClient, generateKeyPair, parseKey } from "xjdp";

// Fresh key pair (ephemeral — works with "*" wildcard ACL)
const { privateKey, publicKey } = await generateKeyPair();

// Or import a pre-shared key
// const { privateKey, publicKey } = await parseKey("eyJrdHkiOiJFQyIs...");

const client = await RJDPClient.connect("http://localhost:3000", {
  privateKey,
  publicKey,
  serverFingerprint: "a3f9", // optional — prefix match
});

// Eval
const { result } = await client.eval("process.version");

// Eval with context
const { result: sum } = await client.eval("a + b", { context: { a: 1, b: 2 } });

// Exec with streaming output
const proc = client.exec("ls", ["-la"]);
for await (const chunk of proc.stdout) {
  process.stdout.write(chunk);
}
const exit = await proc.wait();

// Filesystem
const content = await client.fs.read("/src/index.ts");
await client.fs.write("/tmp/out.txt", "hello");
const entries = await client.fs.list("/src");
await client.fs.mkdir("/src/new-dir");
await client.fs.rename("/old.txt", "/new.txt");
await client.fs.delete("/tmp/out.txt");

client.close();
```

## CLI

```bash
npx xjdp [flags]
```

| Flag                | Env Var            | Description                                   |
| ------------------- | ------------------ | --------------------------------------------- |
| `-u, --url`         | `XJDP_URL`         | Server URL (default: `http://localhost:3000`) |
| `-f, --fingerprint` | `XJDP_FINGERPRINT` | Expected server fingerprint (prefix match)    |
| `-k, --key`         | `XJDP_KEY`         | Pre-shared private key (base64 JWK)           |

### Subcommands

| Command  | Description                                                   |
| -------- | ------------------------------------------------------------- |
| `keygen` | Generate a key pair and print fingerprint, key, and ACL entry |

### REPL Commands

| Command               | Description                                   |
| --------------------- | --------------------------------------------- |
| `<js code>`           | Evaluate JavaScript (or fall through to exec) |
| `eval <code>`         | Explicitly evaluate JavaScript                |
| `repl`                | Enter JS REPL mode (all input is eval'd)      |
| `exec <file> [args]`  | Execute a file with streaming output          |
| `cd [path]`           | Change remote working directory               |
| `ls [path]`           | List directory contents                       |
| `cat <path>`          | Read file contents                            |
| `write <path> <text>` | Write text to a file                          |
| `stat <path>`         | File/directory info                           |
| `mkdir <path>`        | Create directory                              |
| `rm <path>`           | Delete file or directory                      |
| `mv <from> <to>`      | Rename/move                                   |
| `help`                | Show all commands                             |
| `exit`                | Quit                                          |

Unrecognized commands are passed to `exec` automatically, so you can type `node -v` or `git status` directly.

### Examples

```bash
# Pin server fingerprint (prefix match — even 4 chars works)
npx xjdp -u http://localhost:3000 -f a3f9

# Combine fingerprint pinning + pre-shared key
npx xjdp -u http://localhost:3000 -f a3f9 -k eyJrdHkiOiJFQyIs...

# Via environment variables
XJDP_URL=http://localhost:3000 XJDP_FINGERPRINT=a3f9 XJDP_KEY=eyJrdHkiOiJFQyIs... npx xjdp
```

## Server Configuration

```ts
createServer({
  serverKeyPair: CryptoKeyPair, // Required — server ECDSA P-384 key pair
  acl: Record<string, Scope[]>, // Required — fingerprint → scopes mapping
  fsRoot: "/workspace", // Path jail root (default: /workspace)
  transports: ["sse", "http"], // Enabled transports (default: both)
  capabilities: ["eval", "exec", "fs"], // Enabled capabilities (default: all)
  maxConcurrentExec: 3, // Per-session exec limit
  sessionTtl: 3600000, // Session TTL in ms (default: 1h)
  evalTimeout: 5000, // Eval timeout in ms (default: 5s)
  maxReadSize: 10485760, // Max file read size (default: 10MB)
  envDenylist: [/AWS_.*/, /.*TOKEN.*/], // Exec env filter patterns
});
```

### Scopes

| Scope      | Description                            |
| ---------- | -------------------------------------- |
| `eval`     | Execute JavaScript via `AsyncFunction` |
| `exec`     | Spawn child processes                  |
| `fs:read`  | Read files, list directories, stat     |
| `fs:write` | Write files, mkdir, rename, delete     |

## Key Utilities

| Function                                 | Description                                                     |
| ---------------------------------------- | --------------------------------------------------------------- |
| `generateKeyPair()`                      | Generate ECDSA P-384 key pair (non-extractable by default)      |
| `generateKeyPair({ extractable: true })` | Generate extractable key pair (for serialization)               |
| `serializeKey(key)`                      | Serialize a CryptoKey to a compact base64 string                |
| `parseKey(str)`                          | Parse back to `CryptoKeyPair` (private) or `CryptoKey` (public) |
| `fingerprint(publicKey)`                 | SHA-256 hex fingerprint of a public key                         |

## Protocol

```
Client                                          Server
  │                                                │
  │─── GET /.jdp/info ──────────────────────────►  │
  │◄── { transports, capabilities, fingerprint }   │
  │                                                │
  │  ┌─────────────────────────────┐               │
  │  │ verify server fingerprint   │  (optional)   │
  │  └─────────────────────────────┘               │
  │                                                │
  │─── GET /.jdp/challenge ─────────────────────►  │
  │◄── { nonce, serverPubKey, ttl } ─────────────  │
  │                                                │
  │  ┌─────────────────────────────┐               │
  │  │ sign(nonce, clientPrivKey)  │               │
  │  └─────────────────────────────┘               │
  │                                                │
  │─── POST /.jdp/auth { sig, pubKey, nonce } ──►  │
  │◄── { sessionId, scopes, expiresAt } ─────────  │
  │                                                │
  │  ┌─────────────────────────────┐               │
  │  │ pick best transport         │               │
  │  └─────────────────────────────┘               │
  │                                                │
  ╔════════════════════════════════════════════════╗
  ║  SSE Transport                                 ║
  ║                                                ║
  ║  │─── GET /.jdp/stream ──────────────────►  │  ║
  ║  │◄── text/event-stream ─────────────────   │  ║
  ║  │                                          │  ║
  ║  │─── POST /.jdp/send { frame } ────────►  │  ║
  ║  │◄── SSE: event: eval.res ──────────────   │  ║
  ║  │◄── SSE: event: exec.stdout ───────────   │  ║
  ║  │◄── SSE: event: exec.exit ─────────────   │  ║
  ╚════════════════════════════════════════════════╝
  ╔════════════════════════════════════════════════╗
  ║  HTTP Fallback Transport                       ║
  ║                                                ║
  ║  │─── POST /.jdp/invoke { frame } ──────►  │  ║
  ║  │◄── { response frame } ────────────────   │  ║
  ║  │                                          │  ║
  ║  │─── GET /.jdp/poll?id=…&cursor=… ─────►  │  ║
  ║  │◄── { chunks, next, done } ────────────   │  ║
  ╚════════════════════════════════════════════════╝

Frames: { id, type, ts, payload }

  eval.req ──► eval.res
  exec.req ──► exec.stdout* ──► exec.stderr* ──► exec.exit
  exec.kill
  fs.req   ──► fs.res
  ping     ──► pong
```

## Endpoints

| Endpoint          | Method | Auth | Description                                   |
| ----------------- | ------ | ---- | --------------------------------------------- |
| `/.jdp/info`      | GET    | No   | Capabilities, transports & server fingerprint |
| `/.jdp/challenge` | GET    | No   | Request auth nonce                            |
| `/.jdp/auth`      | POST   | No   | Authenticate with signed nonce                |
| `/.jdp/stream`    | GET    | Yes  | Open SSE stream                               |
| `/.jdp/send`      | POST   | Yes  | Send frame via SSE transport                  |
| `/.jdp/invoke`    | POST   | Yes  | Send frame via HTTP transport                 |
| `/.jdp/poll`      | GET    | Yes  | Poll exec output (HTTP fallback)              |

## Authentication

All auth uses **ECDSA P-384** via the Web Crypto API. No OpenSSL or third-party crypto.

1. Client fetches `/.jdp/info` — optionally verifies server fingerprint (prefix match)
2. Client requests a challenge nonce from the server
3. Client signs the nonce with its private key
4. Server verifies the signature against its ACL (keyed by public key fingerprint)
5. Server issues a session token with scoped permissions

Nonces are single-use with a 30-second TTL, stored in an LRU cache for replay prevention.

## Security

- **Path jail** — All filesystem operations are confined to a root directory. Symlink escapes are caught via `realpathSync` re-check.
- **Env denylist** — Exec filters out environment variables matching `AWS_*`, `*TOKEN*`, `*SECRET*`, `*PASSWORD*`, `*PRIVATE*`.
- **Scoped permissions** — Each client key is mapped to specific capabilities (`eval`, `exec`, `fs:read`, `fs:write`).
- **Nonce replay prevention** — LRU cache of used nonces with TTL expiry.
- **Session expiry** — Configurable TTL (default 1 hour).
- **Frame size limits** — Configurable max frame and file read sizes.
- **Server fingerprint pinning** — Clients can verify the server's identity via fingerprint prefix matching.

## Development

```bash
pnpm dev           # playground server + REPL
pnpm test          # lint + typecheck
pnpm fmt           # auto-fix lint + format
```

## Sponsors

<p align="center">
  <a href="https://sponsors.pi0.io/">
    <img src="https://sponsors.pi0.io/sponsors.svg?xyz">
  </a>
</p>

## License

MIT
