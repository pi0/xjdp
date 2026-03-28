// XJDP interactive REPL — connects to an RJDP server and provides eval/exec/fs commands

const readline = globalThis.process?.getBuiltinModule?.(
  "node:readline/promises",
) as typeof import("node:readline/promises");
const { cursorTo, clearLine } = (globalThis.process?.getBuiltinModule?.("node:readline") ||
  {}) as typeof import("node:readline");
const { stdin, stdout, stderr } = (globalThis.process?.getBuiltinModule?.("node:process") ||
  {}) as typeof import("node:process");
const { parseArgs } = (globalThis.process?.getBuiltinModule?.("node:util") ||
  {}) as typeof import("node:util");
import { RJDPClient, type ClientOptions } from "../client/client.ts";
import { generateKeyPair, serializeKey, fingerprint, parseKey } from "../client/_crypto.ts";
import { dim, bold, green, yellow, cyan, red, formatJS } from "./_format.ts";
import {
  printConnectionInfo,
  SYSTEM_INFO_EVAL,
  type SystemInfo,
  type ConnectionInfoOptions,
} from "./_banner.ts";
import {
  handleCommand,
  handleEval,
  printUsage,
  getCwd,
  setCwd,
  setHome,
  getDisplayCwd,
  resolvePath,
} from "./_commands.ts";

const COMMANDS = [
  "help",
  "eval",
  "repl",
  "exec",
  "cd",
  "ls",
  "cat",
  "write",
  "stat",
  "mkdir",
  "rm",
  "mv",
  "clear",
  "exit",
  "quit",
];

export interface ReplOptions {
  serverUrl: string;
  connectOpts: ClientOptions;
  connectionInfo?: ConnectionInfoOptions;
}

/** Start the REPL loop with an already-connected client */
export async function startRepl(client: RJDPClient, opts: ReplOptions): Promise<void> {
  let activeClient = client;
  let jsMode = false;
  let closing = false;
  const host = new URL(opts.serverUrl).host;
  const getPrompt = () => {
    const cwdLabel = getCwd() === "/" ? "" : dim(":") + yellow(getDisplayCwd());
    return `${green("xjdp")}${dim("@")}${cyan(host)}${cwdLabel}${dim("|")}${bold("⇒")} `;
  };
  const jsPrompt = `${yellow("js")}${dim("@")}${cyan(host)}${dim("|")}${bold("⇒")} `;
  // Visual length: "js@<host>|⇒ "
  const jsPromptLen = 2 + 1 + host.length + 1 + 1 + 1;

  async function reconnect(): Promise<boolean> {
    stderr.write(yellow("Connection lost. ") + dim("Reconnecting...\n"));
    for (let attempt = 1; attempt <= 5; attempt++) {
      try {
        activeClient = await RJDPClient.connect(opts.serverUrl, opts.connectOpts);
        stderr.write(green("Reconnected.\n"));
        return true;
      } catch {
        const delay = Math.min(1000 * 2 ** (attempt - 1), 8000);
        stderr.write(dim(`  retry ${attempt}/5 in ${delay / 1000}s...\n`));
        const aborted = await new Promise<boolean>((resolve) => {
          const timer = setTimeout(() => resolve(false), delay);
          const onInt = () => {
            clearTimeout(timer);
            resolve(true);
          };
          process.once("SIGINT", onInt);
        });
        if (aborted) {
          stderr.write(dim("\nReconnect aborted.\n"));
          return false;
        }
      }
    }
    stderr.write(red("Failed to reconnect after 5 attempts.\n"));
    return false;
  }

  let remoteExecs: string[] | undefined;

  async function getRemoteExecs(): Promise<string[]> {
    if (remoteExecs) return remoteExecs;
    try {
      const { result } = await activeClient.eval(`
        const { readdirSync } = await import("node:fs");
        const dirs = (process.env.PATH || "").split(":");
        const seen = new Set();
        for (const dir of dirs) {
          try { for (const name of readdirSync(dir)) seen.add(name); } catch {}
        }
        return [...seen].sort();
      `);
      remoteExecs = (result as string[]) || [];
    } catch {
      remoteExecs = [];
    }
    return remoteExecs;
  }

  const rl = readline.createInterface({
    input: stdin,
    output: stdout,
    prompt: getPrompt(),
    completer: async (line: string): Promise<[string[], string]> => {
      if (jsMode) return [[], line];

      const spaceIdx = line.indexOf(" ");
      if (spaceIdx === -1) {
        const hits = COMMANDS.filter((c) => c.startsWith(line)).map((c) => c + " ");
        if (hits.length) return [hits, line];
        // Fall back to cached remote executable completion
        const execs = await getRemoteExecs();
        const remoteHits = execs.filter((c) => c.startsWith(line)).map((c) => c + " ");
        return [remoteHits, line];
      }

      // Complete file paths via remote ls
      const partial = line.slice(spaceIdx + 1);
      const lastSlash = partial.lastIndexOf("/");
      const dir = resolvePath(lastSlash === -1 ? "." : partial.slice(0, lastSlash) || "/");
      const prefix = lastSlash === -1 ? "" : partial.slice(0, lastSlash + 1);
      const fragment = lastSlash === -1 ? partial : partial.slice(lastSlash + 1);

      try {
        const entries = await activeClient.fs.list(dir);
        const matches = entries
          .filter((e) => e.name.startsWith(fragment))
          .map((e) => `${prefix}${e.name}${e.isDirectory ? "/" : ""}`);
        return [matches, partial];
      } catch {
        return [[], partial];
      }
    },
  });
  // Ctrl+C clears the current line instead of closing the REPL
  rl.on("SIGINT", () => {
    // Clear partial input and re-prompt
    (rl as any).line = "";
    (rl as any).cursor = 0;
    stdout.write("\n");
    rl.setPrompt(jsMode ? jsPrompt : getPrompt());
    rl.prompt();
  });
  rl.on("close", () => {
    closing = true;
  });

  // Detect SSE disconnect and trigger reconnect proactively
  const registerDisconnectHandler = (c: RJDPClient) => {
    c.onDisconnect(async () => {
      if (closing) return;
      if (await reconnect()) {
        registerDisconnectHandler(activeClient);
      } else {
        closing = true;
        rl.close();
      }
    });
  };
  registerDisconnectHandler(activeClient);

  // Live JS syntax highlighting while typing
  stdin.on("keypress", () => {
    if (!jsMode) return;
    process.nextTick(() => {
      const line = rl.line;
      const cursor = rl.cursor;
      cursorTo(stdout, jsPromptLen);
      clearLine(stdout, 1);
      stdout.write(formatJS(line));
      cursorTo(stdout, jsPromptLen + cursor);
    });
  });

  if (opts.connectionInfo) {
    printConnectionInfo(activeClient, opts.serverUrl, opts.connectionInfo);
  }
  rl.prompt();

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) {
      rl.prompt();
      continue;
    }

    try {
      if (jsMode) {
        if (trimmed === "exit" || trimmed === "quit") {
          jsMode = false;
          rl.setPrompt(getPrompt());
          stdout.write(dim("Back to command mode.\n"));
        } else {
          await handleEval(trimmed, activeClient);
        }
      } else if (trimmed === "clear") {
        stdout.write("\x1Bc");
        printConnectionInfo(activeClient, opts.serverUrl, opts.connectionInfo);
      } else if (trimmed === "repl") {
        if (!activeClient.scopes.includes("eval")) {
          stderr.write(red("Cannot enter REPL: missing eval scope.\n"));
        } else {
          jsMode = true;
          rl.setPrompt(jsPrompt);
          stdout.write(dim("Entering JS REPL mode. Type exit or Ctrl+D to return.\n"));
        }
      } else {
        await handleCommand(trimmed, activeClient, rl);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (isConnectionError(msg)) {
        if (await reconnect()) {
          stderr.write(dim("Retrying command...\n"));
          try {
            if (jsMode) {
              await handleEval(trimmed, activeClient);
            } else {
              await handleCommand(trimmed, activeClient, rl);
            }
          } catch (retryErr) {
            stderr.write(
              red(`Error: ${retryErr instanceof Error ? retryErr.message : retryErr}\n`),
            );
          }
        }
      } else {
        stderr.write(red(`Error: ${msg}\n`));
      }
    }

    if (!closing) {
      rl.setPrompt(jsMode ? jsPrompt : getPrompt());
      rl.prompt();
    }
  }

  stdout.write(dim("\nBye.\n"));
}

// --- Standalone CLI entrypoint ---

export interface MainOptions {
  url?: string;
  fingerprint?: string;
  key?: string;
}

export async function main(opts?: MainOptions) {
  const { values: args, positionals } = parseArgs({
    options: {
      url: { type: "string", short: "u" },
      fingerprint: { type: "string", short: "f" },
      key: { type: "string", short: "k" },
      help: { type: "boolean", short: "h" },
    },
    strict: false,
    allowPositionals: true,
  });

  if (args.help) {
    printUsage();
    process.exit(0);
  }

  // Subcommand: keygen
  if (positionals[0] === "keygen") {
    await handleKeygen();
    return;
  }

  const serverUrl =
    opts?.url ??
    (typeof args.url === "string" ? args.url : undefined) ??
    process.env.XJDP_URL ??
    "http://localhost:3000";

  const serverFingerprint =
    opts?.fingerprint ??
    (typeof args.fingerprint === "string" ? args.fingerprint : undefined) ??
    process.env.XJDP_FINGERPRINT;

  const keyJwk =
    opts?.key ?? (typeof args.key === "string" ? args.key : undefined) ?? process.env.XJDP_KEY;

  stdout.write(dim(`Connecting to ${serverUrl}...\n\n`));

  let privateKey: CryptoKey;
  let publicKey: CryptoKey;
  if (keyJwk) {
    try {
      const result = await parseKey(keyJwk);
      if (!("privateKey" in result)) throw new Error("Expected a private key");
      ({ privateKey, publicKey } = result);
    } catch {
      stderr.write(red("Invalid key: expected base64-encoded private key JWK\n"));
      process.exit(1);
    }
  } else {
    ({ privateKey, publicKey } = await generateKeyPair());
  }
  const fp = await RJDPClient.fingerprint(publicKey);

  let client: RJDPClient;
  const t0 = performance.now();
  try {
    client = await RJDPClient.connect(serverUrl, { privateKey, publicKey, serverFingerprint });
  } catch (err) {
    stderr.write(red(`Connection failed: ${err instanceof Error ? err.message : err}\n`));
    process.exit(1);
  }
  const latency = Math.round(performance.now() - t0);

  // Gather remote system info + cwd/home in a single eval
  let sys: SystemInfo | undefined;
  try {
    const { result } = await client.eval(SYSTEM_INFO_EVAL);
    sys = result as SystemInfo;
    if (sys?.cwd) setCwd(sys.cwd);
    if (sys?.home) setHome(sys.home);
  } catch {}

  const connectOpts = { privateKey, publicKey, serverFingerprint };
  const connectionInfo = { fp, latency, sys };

  // Non-interactive: run the command from args and exit
  if (positionals.length > 0) {
    try {
      await handleCommand(positionals.join(" "), client, undefined!);
    } catch (err) {
      stderr.write(red(`Error: ${err instanceof Error ? err.message : err}\n`));
      client.close();
      process.exit(1);
    }
    client.close();
    return;
  }

  await startRepl(client, { serverUrl, connectOpts, connectionInfo });
  client.close();
}

// --- Keygen ---

async function handleKeygen(): Promise<void> {
  const scopes = ["eval", "exec", "fs:read", "fs:write"];
  const keyPair = await generateKeyPair({ extractable: true });
  const fp = await fingerprint(keyPair.publicKey);
  const key = await serializeKey(keyPair.privateKey);

  stdout.write(bold("Generated ECDSA P-384 key pair\n\n"));
  stdout.write(dim("Fingerprint:\n"));
  stdout.write(`${fp}\n\n`);
  stdout.write(dim("Private key (pass via -k flag):\n"));
  stdout.write(`${key}\n\n`);
  stdout.write(dim("ACL entry (paste into server config):\n"));
  stdout.write(`"${fp}": ${JSON.stringify(scopes)}\n\n`);
  stdout.write(dim("Connect:\n"));
  stdout.write(`npx xjdp -u http://localhost:3000 -k ${key}\n`);
}

// --- Connection ---

function isConnectionError(msg: string): boolean {
  return /fetch failed|ECONNREFUSED|ECONNRESET|ETIMEDOUT|socket hang up|network/i.test(msg);
}

// Re-export for web terminal
export { SYSTEM_INFO_EVAL } from "./_banner.ts";
export { setCwd, setHome } from "./_commands.ts";
