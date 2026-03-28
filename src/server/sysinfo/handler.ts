// Server-side system info gathering — no eval permission required

import type { Frame, SysinfoResponse } from "../../types.ts";

const os = globalThis.process?.getBuiltinModule?.("node:os") as typeof import("node:os");
const fs = globalThis.process?.getBuiltinModule?.("node:fs") as typeof import("node:fs");

function fmt(bytes: number): string {
  if (bytes < 1024 ** 3) return (bytes / 1024 ** 2).toFixed(0) + " MB";
  return (bytes / 1024 ** 3).toFixed(1) + " GB";
}

function formatUptime(sec: number): string {
  const days = Math.floor(sec / 86400);
  const hours = Math.floor((sec % 86400) / 3600);
  const mins = Math.floor((sec % 3600) / 60);
  const parts: string[] = [];
  if (days) parts.push(days + "d");
  if (hours) parts.push(hours + "h");
  parts.push(mins + "m");
  return parts.join(" ");
}

export function handleSysinfo(frame: Frame): Frame<SysinfoResponse> {
  const isBun = typeof (globalThis as any).Bun !== "undefined";
  const isDeno = typeof (globalThis as any).Deno !== "undefined";

  let diskFree = "?";
  let diskTotal = "?";
  try {
    const stat = fs.statfsSync("/");
    diskFree = fmt(stat.bfree * stat.bsize);
    diskTotal = fmt(stat.blocks * stat.bsize);
  } catch {}

  return {
    id: frame.id,
    type: "sysinfo.res",
    ts: Date.now(),
    payload: {
      runtime: isBun ? "Bun" : isDeno ? "Deno" : "Node.js",
      version: isBun
        ? (globalThis as any).Bun.version
        : isDeno
          ? (globalThis as any).Deno.version.deno
          : process.version,
      os: os.platform(),
      arch: os.arch(),
      hostname: os.hostname(),
      uptime: formatUptime(os.uptime()),
      cpus: os.cpus().length,
      memFree: fmt(os.freemem()),
      memTotal: fmt(os.totalmem()),
      diskFree,
      diskTotal,
      cwd: process.cwd(),
      home: os.homedir(),
    },
  };
}
