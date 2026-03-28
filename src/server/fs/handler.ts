// FS capability — path-jailed file operations

const fs = globalThis.process?.getBuiltinModule?.(
  "node:fs/promises",
) as typeof import("node:fs/promises");
const path = globalThis.process?.getBuiltinModule?.("node:path") as typeof import("node:path");
import type { Frame, FsOp, FsResponse } from "../../types.ts";
import { PathJail, SecurityError } from "./_jail.ts";

const DEFAULT_MAX_READ_SIZE = 10 * 1024 * 1024; // 10 MB

export interface FsContext {
  jail: PathJail;
  maxReadSize: number;
}

export function createFsContext(opts?: { fsRoot?: string; maxReadSize?: number }): FsContext {
  return {
    jail: new PathJail(opts?.fsRoot ?? process.env.XRJDP_FS_ROOT ?? "/"),
    maxReadSize: opts?.maxReadSize ?? DEFAULT_MAX_READ_SIZE,
  };
}

export async function handleFs(frame: Frame<FsOp>, ctx: FsContext): Promise<Frame<FsResponse>> {
  const op = frame.payload;

  try {
    const result = await dispatch(op, ctx);
    return { id: frame.id, type: "fs.res", ts: Date.now(), payload: result };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    const code = err instanceof SecurityError ? "SECURITY_ERROR" : "FS_ERROR";
    return {
      id: frame.id,
      type: "error" as const,
      ts: Date.now(),
      payload: { code, message } as never,
    };
  }
}

async function dispatch(op: FsOp, ctx: FsContext): Promise<FsResponse> {
  switch (op.op) {
    case "read":
      return await opRead(ctx, op.path);
    case "write":
      return await opWrite(ctx, op.path, op.content, op.encoding);
    case "list":
      return await opList(ctx, op.path);
    case "delete":
      return await opDelete(ctx, op.path);
    case "stat":
      return await opStat(ctx, op.path);
    case "mkdir":
      return await opMkdir(ctx, op.path);
    case "rename":
      return await opRename(ctx, op.from, op.to);
  }
}

async function opRead(ctx: FsContext, filePath: string): Promise<FsResponse> {
  const resolved = ctx.jail.resolve(filePath);
  const stat = await fs.stat(resolved);

  if (stat.size > ctx.maxReadSize) {
    throw new Error(`File too large (${stat.size} bytes). Max: ${ctx.maxReadSize} bytes.`);
  }

  // Detect binary by reading first 8KB and checking for null bytes
  const fd = await fs.open(resolved, "r");
  const sample = Buffer.alloc(Math.min(8192, stat.size));
  await fd.read(sample, 0, sample.length, 0);
  await fd.close();

  const isBinary = sample.includes(0);
  if (isBinary) {
    const content = await fs.readFile(resolved);
    return { op: "read", content: content.toString("base64"), encoding: "base64", size: stat.size };
  }

  const content = await fs.readFile(resolved, "utf8");
  return { op: "read", content, encoding: "utf8", size: stat.size };
}

async function opWrite(
  ctx: FsContext,
  filePath: string,
  content: string,
  encoding?: "utf8" | "base64",
): Promise<FsResponse> {
  const resolved = ctx.jail.resolve(filePath);
  const dir = path.dirname(resolved);
  await fs.mkdir(dir, { recursive: true });

  if (encoding === "base64") {
    await fs.writeFile(resolved, Buffer.from(content, "base64"));
  } else {
    await fs.writeFile(resolved, content, "utf8");
  }

  return { op: "write", ok: true };
}

async function opList(ctx: FsContext, dirPath: string): Promise<FsResponse> {
  const resolved = ctx.jail.resolve(dirPath);
  const dirents = await fs.readdir(resolved, { withFileTypes: true });
  const entries = dirents.map((d: import("node:fs").Dirent) => ({
    name: d.name,
    isFile: d.isFile(),
    isDirectory: d.isDirectory(),
  }));
  return { op: "list", entries };
}

async function opDelete(ctx: FsContext, filePath: string): Promise<FsResponse> {
  const resolved = ctx.jail.resolve(filePath);
  await fs.rm(resolved, { recursive: true });
  return { op: "delete", ok: true };
}

async function opStat(ctx: FsContext, filePath: string): Promise<FsResponse> {
  const resolved = ctx.jail.resolve(filePath);
  const stat = await fs.stat(resolved);
  return {
    op: "stat",
    stat: {
      size: stat.size,
      isFile: stat.isFile(),
      isDirectory: stat.isDirectory(),
      mtime: stat.mtimeMs,
    },
  };
}

async function opMkdir(ctx: FsContext, dirPath: string): Promise<FsResponse> {
  const resolved = ctx.jail.resolve(dirPath);
  await fs.mkdir(resolved, { recursive: true });
  return { op: "mkdir", ok: true };
}

async function opRename(ctx: FsContext, from: string, to: string): Promise<FsResponse> {
  const resolvedFrom = ctx.jail.resolve(from);
  const resolvedTo = ctx.jail.resolve(to);
  await fs.rename(resolvedFrom, resolvedTo);
  return { op: "rename", ok: true };
}
