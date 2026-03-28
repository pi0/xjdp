// Web polyfill for Node.js built-in modules used by CLI
// Designed for xterm.js — import before any CLI modules.

// @ts-ignore -- peer dependency, installed by consumer
import type { Terminal as XTerm } from "@xterm/xterm";

export interface WebTerminalOptions {
  /** xterm.js Terminal instance */
  xterm: XTerm;
  /** Called when the CLI calls process.exit() */
  onExit?(code: number): void;
  /** Environment variables to expose via process.env */
  env?: Record<string, string>;
}

/**
 * Install web polyfills for `globalThis.process.getBuiltinModule`.
 * Must be called before importing any CLI modules.
 */
export function installWebPolyfill(opts: WebTerminalOptions): () => void {
  const { xterm, onExit, env: userEnv } = opts;

  const keypressListeners = new Set<() => void>();

  const stdoutStream = createWriteStream(xterm);
  const stderrStream = createWriteStream(xterm);
  const stdinStream = {
    on(event: string, fn: () => void) {
      if (event === "keypress") keypressListeners.add(fn);
    },
  };

  const modules: Record<string, unknown> = {
    "node:process": {
      stdin: stdinStream,
      stdout: stdoutStream,
      stderr: stderrStream,
    },

    "node:readline/promises": {
      createInterface: (rlOpts: {
        input?: unknown;
        output?: unknown;
        prompt?: string;
        completer?: CompleterFn;
      }) => createReadlineInterface(xterm, keypressListeners, rlOpts.prompt, rlOpts.completer),
    },

    "node:readline": {
      cursorTo(stream: { write(s: string): void } | undefined, x: number) {
        (stream ?? stdoutStream).write(`\x1B[${x + 1}G`);
      },
      clearLine(stream: { write(s: string): void } | undefined, dir: number) {
        // dir: -1 = left, 0 = entire, 1 = right
        const code = dir === -1 ? "1" : dir === 0 ? "2" : "0";
        (stream ?? stdoutStream).write(`\x1B[${code}K`);
      },
    },

    "node:util": {
      parseArgs: webParseArgs,
    },

    "node:path": {
      posix: createPosixPath(),
      ...createPosixPath(),
    },
  };

  const processShim = {
    env: { ...userEnv } as Record<string, string | undefined>,
    cwd: () => "/",
    exit: (code: number) => onExit?.(code),
    version: "web",
    nextTick: (fn: () => void) => queueMicrotask(fn),
    once: () => {},
    getBuiltinModule: (id: string) => modules[id] ?? null,
  };

  const prev = (globalThis as Record<string, unknown>).process;
  (globalThis as Record<string, unknown>).process = processShim;

  // Return cleanup function
  return () => {
    (globalThis as Record<string, unknown>).process = prev;
    keypressListeners.clear();
  };
}

// --- WriteStream ---

function createWriteStream(xterm: XTerm) {
  return {
    get columns() {
      return xterm.cols;
    },
    write(data: string) {
      // xterm.js expects \r\n for newlines
      xterm.write(data.replaceAll("\n", "\r\n"));
      return true;
    },
    on() {},
  };
}

// --- Readline ---

type CompleterFn = (line: string) => Promise<[string[], string]>;

interface ReadlineInterface {
  prompt(): void;
  setPrompt(p: string): void;
  close(): void;
  on(event: string, fn: (...args: unknown[]) => void): void;
  line: string;
  cursor: number;
  [Symbol.asyncIterator](): AsyncIterator<string>;
}

function createReadlineInterface(
  xterm: XTerm,
  keypressListeners: Set<() => void>,
  initialPrompt?: string,
  completer?: CompleterFn,
): ReadlineInterface {
  let prompt = initialPrompt ?? "> ";
  let closed = false;
  let line = "";
  let cursor = 0;
  const closeListeners: (() => void)[] = [];
  const sigintListeners: (() => void)[] = [];

  let lineResolve: ((result: IteratorResult<string>) => void) | null = null;
  let promptVisible = false;
  const pendingLines: string[] = [];

  const dispose = xterm.onData((data: string) => {
    if (closed || !promptVisible) return;

    let i = 0;
    while (i < data.length) {
      // Escape sequences (arrow keys, etc.)
      if (data[i] === "\x1B" && data[i + 1] === "[") {
        const seq = data[i + 2];
        if (seq === "D") {
          // Left arrow
          if (cursor > 0) {
            cursor--;
            xterm.write("\x1B[D");
          }
          i += 3;
          continue;
        }
        if (seq === "C") {
          // Right arrow
          if (cursor < line.length) {
            cursor++;
            xterm.write("\x1B[C");
          }
          i += 3;
          continue;
        }
        if (seq === "H") {
          // Home
          if (cursor > 0) {
            xterm.write(`\x1B[${cursor}D`);
            cursor = 0;
          }
          i += 3;
          continue;
        }
        if (seq === "F") {
          // End
          if (cursor < line.length) {
            xterm.write(`\x1B[${line.length - cursor}C`);
            cursor = line.length;
          }
          i += 3;
          continue;
        }
        // Skip unknown escape sequences
        i += 3;
        continue;
      }

      const ch = data[i]!;
      i++;

      if (ch === "\r" || ch === "\n") {
        xterm.write("\r\n");
        const submitted = line;
        line = "";
        cursor = 0;
        promptVisible = false;
        rl.line = "";
        rl.cursor = 0;
        if (lineResolve) {
          const resolve = lineResolve;
          lineResolve = null;
          resolve({ value: submitted, done: false });
        } else {
          pendingLines.push(submitted);
        }
        return;
      }

      if (ch === "\x7F" || ch === "\b") {
        if (cursor > 0) {
          line = line.slice(0, cursor - 1) + line.slice(cursor);
          cursor--;
          xterm.write("\b" + line.slice(cursor) + " " + "\b".repeat(line.length - cursor + 1));
        }
      } else if (ch === "\x03") {
        xterm.write("^C\r\n");
        line = "";
        cursor = 0;
        rl.line = "";
        rl.cursor = 0;
        if (sigintListeners.length > 0) {
          for (const fn of sigintListeners) fn();
        } else {
          showPrompt();
        }
      } else if (ch === "\x04") {
        rl.close();
        return;
      } else if (ch === "\t" && completer) {
        // Tab completion
        const currentLine = line;
        completer(currentLine).then(([completions, partial]) => {
          if (closed || !promptVisible) return;
          if (completions.length === 1) {
            // Single match — replace partial with completion
            const suffix = completions[0]!.slice(partial.length);
            if (suffix) {
              line = line.slice(0, cursor) + suffix + line.slice(cursor);
              cursor += suffix.length;
              // Redraw from prompt
              xterm.write(`\r${prompt}${line}`);
              if (cursor < line.length) xterm.write(`\x1B[${line.length - cursor}D`);
              rl.line = line;
              rl.cursor = cursor;
              for (const fn of keypressListeners) fn();
            }
          } else if (completions.length > 1) {
            // Multiple matches — find common prefix and show options
            let common = completions[0]!;
            for (const c of completions) {
              while (common && !c.startsWith(common)) common = common.slice(0, -1);
            }
            const suffix = common.slice(partial.length);
            if (suffix) {
              line = line.slice(0, cursor) + suffix + line.slice(cursor);
              cursor += suffix.length;
            }
            xterm.write("\r\n" + completions.join("  ") + "\r\n");
            xterm.write(prompt + line);
            if (cursor < line.length) xterm.write(`\x1B[${line.length - cursor}D`);
            rl.line = line;
            rl.cursor = cursor;
            for (const fn of keypressListeners) fn();
          }
        });
        return;
      } else if (ch === "\x01") {
        if (cursor > 0) {
          xterm.write(`\x1B[${cursor}D`);
          cursor = 0;
        }
      } else if (ch === "\x05") {
        if (cursor < line.length) {
          xterm.write(`\x1B[${line.length - cursor}C`);
          cursor = line.length;
        }
      } else if (ch === "\x15") {
        if (cursor > 0) {
          xterm.write("\b".repeat(cursor) + " ".repeat(line.length) + "\b".repeat(line.length));
          line = line.slice(cursor);
          cursor = 0;
          xterm.write(line);
          if (line.length) xterm.write(`\x1B[${line.length}D`);
        }
      } else if (ch >= " ") {
        line = line.slice(0, cursor) + ch + line.slice(cursor);
        cursor++;
        const tail = line.slice(cursor);
        xterm.write(ch + tail);
        if (tail.length) xterm.write(`\x1B[${tail.length}D`);
      }
    }

    rl.line = line;
    rl.cursor = cursor;
    for (const fn of keypressListeners) fn();
  });

  function showPrompt() {
    promptVisible = true;
    xterm.write(prompt);
  }

  const rl: ReadlineInterface = {
    line: "",
    cursor: 0,

    prompt() {
      if (closed) return;
      showPrompt();
    },

    setPrompt(p: string) {
      prompt = p;
    },

    close() {
      if (closed) return;
      closed = true;
      dispose.dispose();
      for (const fn of closeListeners) fn();
      if (lineResolve) {
        lineResolve({ value: undefined as unknown as string, done: true });
        lineResolve = null;
      }
    },

    on(event: string, fn: (...args: unknown[]) => void) {
      if (event === "close") closeListeners.push(fn as () => void);
      else if (event === "SIGINT") sigintListeners.push(fn as () => void);
    },

    [Symbol.asyncIterator]() {
      return {
        next(): Promise<IteratorResult<string>> {
          if (closed) return Promise.resolve({ value: undefined as unknown as string, done: true });
          if (pendingLines.length > 0) {
            return Promise.resolve({ value: pendingLines.shift()!, done: false });
          }
          return new Promise((resolve) => {
            lineResolve = resolve;
          });
        },
      };
    },
  };

  return rl;
}

// --- parseArgs (minimal) ---

interface ParseArgsConfig {
  options?: Record<string, { type: string; short?: string }>;
  strict?: boolean;
  allowPositionals?: boolean;
  args?: string[];
}

function webParseArgs(config: ParseArgsConfig) {
  const args = config.args ?? [];
  const values: Record<string, string | boolean | undefined> = {};
  const positionals: string[] = [];
  const optDefs = config.options ?? {};

  const shortMap: Record<string, string> = {};
  for (const [name, def] of Object.entries(optDefs)) {
    if (def.short) shortMap[def.short] = name;
  }

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--") {
      positionals.push(...args.slice(i + 1));
      break;
    }

    let name: string | undefined;
    if (arg.startsWith("--")) {
      name = arg.slice(2);
    } else if (arg.startsWith("-") && arg.length === 2) {
      name = shortMap[arg[1]!];
    }

    const def = name ? optDefs[name] : undefined;
    if (def) {
      if (def.type === "boolean") {
        values[name!] = true;
      } else {
        values[name!] = args[++i];
      }
    } else if (!arg.startsWith("-") || !config.strict) {
      positionals.push(arg);
    }
  }

  return { values, positionals };
}

// --- posix path (minimal) ---

function createPosixPath() {
  const sep = "/";

  function normalize(p: string): string {
    if (!p) return ".";
    const isAbs = p.charCodeAt(0) === 47;
    const parts = p.split("/").filter(Boolean);
    const resolved: string[] = [];
    for (const part of parts) {
      if (part === "..") resolved.pop();
      else if (part !== ".") resolved.push(part);
    }
    let out = resolved.join("/");
    if (isAbs) out = "/" + out;
    return out || (isAbs ? "/" : ".");
  }

  function resolve(...segments: string[]): string {
    let resolved = "";
    for (let i = segments.length - 1; i >= 0; i--) {
      const seg = segments[i]!;
      if (!seg) continue;
      resolved = resolved ? seg + "/" + resolved : seg;
      if (seg.charCodeAt(0) === 47) break;
    }
    return normalize(resolved);
  }

  function join(...parts: string[]): string {
    return normalize(parts.filter(Boolean).join("/"));
  }

  function dirname(p: string): string {
    if (!p) return ".";
    const last = p.lastIndexOf("/");
    if (last === -1) return ".";
    if (last === 0) return "/";
    return p.slice(0, last);
  }

  function basename(p: string, ext?: string): string {
    let base = p.slice(p.lastIndexOf("/") + 1);
    if (ext && base.endsWith(ext)) base = base.slice(0, -ext.length);
    return base;
  }

  function isAbsolute(p: string): boolean {
    return p.charCodeAt(0) === 47;
  }

  return { sep, normalize, resolve, join, dirname, basename, isAbsolute };
}
