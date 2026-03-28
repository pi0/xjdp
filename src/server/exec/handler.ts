// Exec capability — streaming process execution

const { spawn } = (globalThis.process?.getBuiltinModule?.("node:child_process") ||
  {}) as typeof import("node:child_process");
import type { ChildProcess } from "node:child_process";
import type {
  Frame,
  ExecRequest,
  ExecStdout,
  ExecStderr,
  ExecExit,
  ExecKill,
} from "../../types.ts";

/**
 * Read-only commands allowed without the `exec` scope.
 * Every command here must satisfy ALL of:
 *  1. No flag/arg combo can write files, send network traffic, or execute sub-commands
 *  2. Cannot hang indefinitely (no interval modes, no interactive TUI)
 *  3. Output is bounded and deterministic
 *  4. No sensitive info beyond what `sysinfo` already exposes
 */
// prettier-ignore
export const READONLY_COMMANDS = /^(uname|uptime|whoami|id|arch|nproc|ls|cat|head|tail|wc|file|stat|df|tree|realpath|basename|dirname|grep|uniq|cut|tr|diff|comm|fold|fmt|column|paste|rev|expand|unexpand|cal|ps|free|which|whereis|echo|printf|test|true|false|pwd|md5sum|sha256sum|sha1sum|base64)$/;

/** Check if a command is in the readonly allowlist */
export function isReadonlyCommand(file: string, args?: string[]): boolean {
  const base = file.split("/").pop() ?? file;
  if (!READONLY_COMMANDS.test(base)) return false;
  // Reject if any arg contains shell metacharacters (prevents sh -c re-wrapping bypass)
  if (args?.some((a) => /[|&;<>`$(){}]/.test(a))) return false;
  return true;
}

const DEFAULT_ENV_DENYLIST = [
  /^AWS_/,
  /TOKEN/i,
  /KEY/i,
  /SECRET/i,
  /PASSWORD/i,
  /PRIVATE/i,
  /^XRJDP_/,
];

export interface ExecContext {
  maxConcurrent: number;
  envDenylist: RegExp[];
  baseEnv: Record<string, string>;
}

export function createExecContext(opts?: {
  maxConcurrent?: number;
  envDenylist?: RegExp[];
}): ExecContext {
  // Build safe base env by filtering current env
  const denylist = opts?.envDenylist ?? DEFAULT_ENV_DENYLIST;
  const baseEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !denylist.some((p) => p.test(key))) {
      baseEnv[key] = value;
    }
  }

  return {
    maxConcurrent: opts?.maxConcurrent ?? 3,
    envDenylist: denylist,
    baseEnv,
  };
}

/** Track active processes by frame id */
const activeProcesses = new Map<string, ChildProcess>();

export interface ExecCallbacks {
  onStdout: (frame: Frame<ExecStdout>) => void;
  onStderr: (frame: Frame<ExecStderr>) => void;
  onExit: (frame: Frame<ExecExit>) => void;
}

export function handleExec(
  frame: Frame<ExecRequest>,
  ctx: ExecContext,
  callbacks: ExecCallbacks,
): void {
  const { file, args, env, cwd } = frame.payload;

  // Merge env (applying denylist to user-provided env)
  const mergedEnv = { ...ctx.baseEnv };
  if (env) {
    for (const [key, value] of Object.entries(env)) {
      if (!ctx.envDenylist.some((p) => p.test(key))) {
        mergedEnv[key] = value;
      }
    }
  }

  // Signal non-interactive context so TTY-aware commands degrade gracefully
  mergedEnv.TERM = mergedEnv.TERM || "dumb";

  // Detect shell metacharacters and wrap in sh -c
  let spawnFile = file;
  let spawnArgs = args ?? [];
  const fullCmd = [file, ...spawnArgs].join(" ");
  if (/[|&;<>`$(){}]/.test(fullCmd)) {
    spawnFile = "sh";
    spawnArgs = ["-c", fullCmd];
  }

  const start = performance.now();
  const proc = spawn(spawnFile, spawnArgs, {
    env: mergedEnv,
    cwd: cwd ?? process.cwd(),
    stdio: ["ignore", "pipe", "pipe"],
  });

  activeProcesses.set(frame.id, proc);

  proc.stdout?.on("data", (data: Buffer) => {
    callbacks.onStdout({
      id: frame.id,
      type: "exec.stdout",
      ts: Date.now(),
      payload: { chunk: data.toString() },
    });
  });

  proc.stderr?.on("data", (data: Buffer) => {
    callbacks.onStderr({
      id: frame.id,
      type: "exec.stderr",
      ts: Date.now(),
      payload: { chunk: data.toString() },
    });
  });

  proc.on("close", (code: number | null, signal: string | null) => {
    activeProcesses.delete(frame.id);
    callbacks.onExit({
      id: frame.id,
      type: "exec.exit",
      ts: Date.now(),
      payload: {
        code,
        signal,
        duration_ms: Math.round(performance.now() - start),
      },
    });
  });

  proc.on("error", (_err: Error) => {
    activeProcesses.delete(frame.id);
    callbacks.onExit({
      id: frame.id,
      type: "exec.exit",
      ts: Date.now(),
      payload: {
        code: 1,
        signal: null,
        duration_ms: Math.round(performance.now() - start),
      },
    });
  });
}

/** Handle exec.kill — SIGTERM first, SIGKILL after 5s */
export function handleExecKill(frame: Frame<ExecKill>): boolean {
  const proc = activeProcesses.get(frame.id);
  if (!proc) return false;

  const signal = frame.payload.signal ?? "SIGTERM";
  proc.kill(signal as NodeJS.Signals);

  // If SIGTERM, schedule SIGKILL as fallback
  if (signal === "SIGTERM") {
    setTimeout(() => {
      if (activeProcesses.has(frame.id)) {
        proc.kill("SIGKILL");
      }
    }, 5000);
  }

  return true;
}
