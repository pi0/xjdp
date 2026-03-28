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
