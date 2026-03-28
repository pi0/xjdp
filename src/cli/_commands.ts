// CLI command handlers

const { posix } = (globalThis.process?.getBuiltinModule?.("node:path") ||
  {}) as typeof import("node:path");
const { stdout, stderr } = (globalThis.process?.getBuiltinModule?.("node:process") ||
  {}) as typeof import("node:process");
import type { Interface as ReadlineInterface } from "node:readline/promises";
import type { RJDPClient } from "../client/client.ts";
import type { FsListEntry, Scope } from "../types.ts";
import { dim, bold, cyan, red, yellow, formatValue, formatBytes } from "./_format.ts";

/** Remote working directory state */
let cwd = "/";
let home = "";

export function getCwd(): string {
  return cwd;
}

export function setCwd(path: string): void {
  cwd = path;
}

export function setHome(path: string): void {
  home = path;
}

/** Display cwd with ~ for homedir */
export function getDisplayCwd(): string {
  if (home && cwd.startsWith(home)) {
    return "~" + cwd.slice(home.length);
  }
  return cwd;
}

/** Resolve an arg: paths are resolved, flags are passed through */
export function resolveArg(arg: string): string {
  return arg.startsWith("-") ? arg : resolvePath(arg);
}

/** Resolve a path relative to the current remote cwd */
export function resolvePath(path: string): string;
export function resolvePath(path: string | undefined): string | undefined;
export function resolvePath(path: string | undefined): string | undefined {
  if (path === undefined) return undefined;
  if (home && (path === "~" || path.startsWith("~/"))) {
    return posix.normalize(home + path.slice(1));
  }
  if (path.startsWith("/")) return posix.normalize(path);
  return posix.resolve(cwd, path);
}

export async function handleCommand(input: string, client: RJDPClient, rl: ReadlineInterface) {
  const parts = input.split(/\s+/);
  const cmd = parts[0];
  const rest = parts.slice(1);

  switch (cmd) {
    case "help":
      printHelp(client.scopes);
      break;

    case "eval":
      await handleEval(rest.join(" "), client);
      break;

    case "exec":
      await handleExec(rest, client);
      break;

    case "cd":
      await handleCd(rest[0], client);
      break;

    case "cat":
      if (rest.some((a) => a.startsWith("-")) || rest.length > 1) {
        await handleExec(["cat", ...rest.map(resolveArg)], client);
      } else {
        await handleFsRead(resolvePath(rest[0]), client);
      }
      break;

    case "write":
      await handleFsWrite(resolvePath(rest[0])!, rest.slice(1).join(" "), client);
      break;

    case "ls":
      if (rest.some((a) => a.startsWith("-"))) {
        await handleExec(["ls", ...rest.map(resolveArg)], client);
      } else {
        await handleFsList(resolvePath(rest[0]) ?? cwd, client);
      }
      break;

    case "stat":
      if (rest.some((a) => a.startsWith("-")) || rest.length > 1) {
        await handleExec(["stat", ...rest.map(resolveArg)], client);
      } else {
        await handleFsStat(resolvePath(rest[0]), client);
      }
      break;

    case "mkdir":
      if (rest.some((a) => a.startsWith("-")) || rest.length > 1) {
        await handleExec(["mkdir", ...rest.map(resolveArg)], client);
      } else {
        await handleFsMkdir(resolvePath(rest[0]), client);
      }
      break;

    case "rm":
      if (rest.some((a) => a.startsWith("-")) || rest.length > 1) {
        await handleExec(["rm", ...rest.map(resolveArg)], client);
      } else {
        await handleFsDelete(resolvePath(rest[0]), client);
      }
      break;

    case "mv":
      if (rest.some((a) => a.startsWith("-")) || rest.length > 2) {
        await handleExec(["mv", ...rest.map(resolveArg)], client);
      } else {
        await handleFsRename(resolvePath(rest[0]), resolvePath(rest[1]), client);
      }
      break;

    case "exit":
    case "quit":
      rl?.close();
      break;

    default:
      // Not a known command — try exec, e.g. `ls -la`
      await handleExec(parts, client);
  }
}

// --- Cd ---

async function handleCd(target: string | undefined, client: RJDPClient) {
  const dest = resolvePath(target ?? (home || "/"))!;
  const stat = await client.fs.stat(dest);
  if (!stat.isDirectory) {
    stderr.write(`cd: not a directory: ${dest}\n`);
    return;
  }
  cwd = dest;
  await client.setCwd(dest);
  stdout.write(dim(getDisplayCwd()) + "\n");
}

// --- Eval ---

export async function handleEval(code: string, client: RJDPClient) {
  if (!code) {
    stderr.write("Usage: eval <code> or just type JS directly\n");
    return;
  }

  const result = await client.eval(code);

  for (const log of result.logs) {
    const prefix = log.level === "log" ? "" : `[${log.level}] `;
    stdout.write(`${prefix}${log.args.map(formatValue).join(" ")}\n`);
  }

  stdout.write(`${formatValue(result.result)}\n`);
}

// --- Exec ---

async function handleExec(args: string[], client: RJDPClient) {
  if (args.length === 0) {
    stderr.write("Usage: exec <file> [args...]\n");
    return;
  }

  const [file, ...execArgs] = args;
  const proc = client.exec(file!, execArgs);

  const outputDone = (async () => {
    for await (const chunk of proc.output) {
      const stream = chunk.type === "stderr" ? stderr : stdout;
      stream.write(chunk.data);
    }
  })();

  const exit = await proc.wait();
  await outputDone;

  if (exit.code !== 0) {
    stdout.write(red(`\nexit ${exit.code ?? exit.signal}\n`));
  }
}

// --- FS commands ---

async function handleFsRead(path: string | undefined, client: RJDPClient) {
  if (!path) {
    stderr.write("Usage: cat <path>\n");
    return;
  }
  const content = await client.fs.read(path);
  stdout.write(content);
  if (!content.endsWith("\n")) stdout.write("\n");
}

async function handleFsWrite(path: string, content: string, client: RJDPClient) {
  if (!path || !content) {
    stderr.write("Usage: write <path> <content>\n");
    return;
  }
  await client.fs.write(path, content);
  stdout.write("Written.\n");
}

async function handleFsList(path: string, client: RJDPClient) {
  const entries = await client.fs.list(path);
  if (entries.length === 0) return;

  const names = entries.map((e: FsListEntry) =>
    e.isDirectory ? bold(cyan(e.name + "/")) : e.name,
  );

  // Fit into columns like `ls`
  const termWidth = stdout.columns || 80;
  const maxLen = Math.max(...entries.map((e) => e.name.length + (e.isDirectory ? 1 : 0)));
  const colWidth = maxLen + 2;
  const cols = Math.max(1, Math.floor(termWidth / colWidth));

  for (let i = 0; i < names.length; i += cols) {
    const row = names.slice(i, i + cols);
    stdout.write(
      row
        .map((name, j) => {
          const entry = entries[i + j]!;
          const rawLen = entry.name.length + (entry.isDirectory ? 1 : 0);
          return name + " ".repeat(Math.max(0, colWidth - rawLen));
        })
        .join("") + "\n",
    );
  }
}

async function handleFsStat(path: string | undefined, client: RJDPClient) {
  if (!path) {
    stderr.write("Usage: stat <path>\n");
    return;
  }
  const stat = await client.fs.stat(path);
  const type = stat.isDirectory ? "directory" : stat.isFile ? "file" : "other";
  stdout.write(`type:  ${type}\n`);
  stdout.write(`size:  ${formatBytes(stat.size)}\n`);
  stdout.write(`mtime: ${new Date(stat.mtime).toISOString()}\n`);
}

async function handleFsMkdir(path: string | undefined, client: RJDPClient) {
  if (!path) {
    stderr.write("Usage: mkdir <path>\n");
    return;
  }
  await client.fs.mkdir(path);
  stdout.write("Created.\n");
}

async function handleFsDelete(path: string | undefined, client: RJDPClient) {
  if (!path) {
    stderr.write("Usage: rm <path>\n");
    return;
  }
  await client.fs.delete(path);
  stdout.write("Deleted.\n");
}

async function handleFsRename(
  from: string | undefined,
  to: string | undefined,
  client: RJDPClient,
) {
  if (!from || !to) {
    stderr.write("Usage: mv <from> <to>\n");
    return;
  }
  await client.fs.rename(from, to);
  stdout.write("Renamed.\n");
}

// --- Help ---

export function printUsage() {
  stdout.write(`Usage: xjdp [options] [command] [args...]

  xjdp                          Start interactive REPL
  xjdp eval "1 + 1"             Evaluate JS and exit
  xjdp exec ls -la              Execute a command and exit
  xjdp cat /etc/hostname         Read a file and exit

Options:
  -u, --url <url>   Server URL (default: $XJDP_URL or http://localhost:3000)
  -h, --help        Show this help

Environment:
  XJDP_URL          Server URL (overridden by --url)
`);
}

type HelpEntry = [cmd: string, desc: string, scope?: Scope];

const HELP_ENTRIES: (HelpEntry | "")[] = [
  ["<js code>", "Evaluate JavaScript on the server", "eval"],
  ["eval <code>", "Same as above (explicit)", "eval"],
  ["repl", "Enter JS REPL mode (all input is eval'd)", "eval"],
  ["exec <file> [args]", "Execute a file on the server (streamed output)", "exec"],
  "",
  ["cd [path]", "Change remote working directory", "fs:read"],
  ["ls [path]", "List directory contents", "fs:read"],
  ["cat <path>", "Read a file", "fs:read"],
  ["stat <path>", "Show file/directory info", "fs:read"],
  ["write <path> <txt>", "Write text to a file", "fs:write"],
  ["mkdir <path>", "Create a directory", "fs:write"],
  ["rm <path>", "Delete a file or directory", "fs:write"],
  ["mv <from> <to>", "Rename/move a file", "fs:write"],
  "",
  ["clear", "Clear screen and show banner"],
  ["help", "Show this help"],
  ["exit", "Quit the REPL"],
];

function printHelp(scopes: Scope[]) {
  const colWidth = 21;
  stdout.write(bold("Commands:") + "\n");
  let hadAvailable = false;
  let pendingGap = false;
  for (const entry of HELP_ENTRIES) {
    if (entry === "") {
      if (hadAvailable) pendingGap = true;
      hadAvailable = false;
      continue;
    }
    const [cmd, desc, scope] = entry;
    const available = !scope || scopes.includes(scope);
    if (available && pendingGap) stdout.write("\n");
    pendingGap = false;
    const padded = cmd + " ".repeat(Math.max(1, colWidth - cmd.length));
    if (available) {
      stdout.write(`  ${yellow(padded)}${dim(desc)}\n`);
      hadAvailable = true;
    } else {
      stdout.write(`  ${dim(padded + desc)}\n`);
    }
  }
}
