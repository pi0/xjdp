// Eval capability — single-shot JS execution in the same thread

import type { Frame, EvalRequest, EvalResponse } from "../../types.ts";

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

/** If code is an expression, wrap it with `return` so AsyncFunction returns the value */
function toFunctionBody(code: string): string {
  try {
    // If `return (code)` parses, it's an expression — use that
    new Function(`return (${code})`);
    return `return (${code})`;
  } catch {
    return code;
  }
}

export async function handleEval(
  frame: Frame<EvalRequest>,
  opts?: { timeout?: number },
): Promise<Frame<EvalResponse>> {
  const { code, timeout, context } = frame.payload;
  const effectiveTimeout = timeout ?? opts?.timeout ?? 5000;
  const logs: Array<{ level: string; args: unknown[] }> = [];

  // Capture console
  const fakeConsole: Record<string, (...args: unknown[]) => void> = {};
  for (const level of ["log", "warn", "error", "info", "debug"] as const) {
    fakeConsole[level] = (...args: unknown[]) => logs.push({ level, args });
  }

  const contextKeys = Object.keys(context ?? {});
  const contextValues = Object.values(context ?? {});

  const start = performance.now();
  let result: unknown;

  try {
    const fn = new AsyncFunction("console", ...contextKeys, toFunctionBody(code));
    result = await Promise.race([
      fn(fakeConsole, ...contextValues),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("Eval timeout")), effectiveTimeout),
      ),
    ]);
  } catch {
    return {
      id: frame.id,
      type: "error",
      ts: Date.now(),
      payload: { result: undefined, logs, duration_ms: performance.now() - start } as never,
    };
  }

  return {
    id: frame.id,
    type: "eval.res",
    ts: Date.now(),
    payload: {
      result,
      logs,
      duration_ms: Math.round(performance.now() - start),
    },
  };
}
