// Banner and connection info display

const { stdout } = (globalThis.process?.getBuiltinModule?.("node:process") ||
  {}) as typeof import("node:process");
import type { SysinfoResponse } from "../types.ts";
import type { RJDPClient } from "../client/client.ts";
import { dim, bold, green, cyan, magenta } from "./_format.ts";

export const BANNER = `
 ██╗  ██╗     ██╗██████╗ ██████╗
 ╚██╗██╔╝     ██║██╔══██╗██╔══██╗
  ╚███╔╝      ██║██║  ██║██████╔╝
  ██╔██╗ ██   ██║██║  ██║██╔═══╝
 ██╔╝╚██╗╚█████╔╝██████╔╝██║
 ╚═╝  ╚═╝ ╚════╝ ╚═════╝ ╚═╝
`;

export type SystemInfo = SysinfoResponse;

/** JS code to eval on the remote server to gather system info */
export const SYSTEM_INFO_EVAL = `
  const os = await import("node:os");
  const fs = await import("node:fs");
  const fmt = (bytes) => {
    if (bytes < 1024 ** 3) return (bytes / 1024 ** 2).toFixed(0) + " MB";
    return (bytes / 1024 ** 3).toFixed(1) + " GB";
  };
  const upSec = os.uptime();
  const days = Math.floor(upSec / 86400);
  const hours = Math.floor((upSec % 86400) / 3600);
  const mins = Math.floor((upSec % 3600) / 60);
  const upParts = [];
  if (days) upParts.push(days + "d");
  if (hours) upParts.push(hours + "h");
  upParts.push(mins + "m");
  let diskFree = "?", diskTotal = "?";
  try {
    const stat = fs.statfsSync("/");
    diskFree = fmt(stat.bfree * stat.bsize);
    diskTotal = fmt(stat.blocks * stat.bsize);
  } catch {}
  const isBun = typeof Bun !== "undefined";
  const isDeno = typeof Deno !== "undefined";
  return {
    runtime: isBun ? "Bun" : isDeno ? "Deno" : "Node.js",
    version: isBun ? Bun.version : isDeno ? Deno.version.deno : process.version,
    os: os.platform(),
    arch: os.arch(),
    hostname: os.hostname(),
    uptime: upParts.join(" "),
    cpus: os.cpus().length,
    memFree: fmt(os.freemem()),
    memTotal: fmt(os.totalmem()),
    diskFree,
    diskTotal,
    cwd: process.cwd(),
    home: os.homedir(),
  };
`;

export interface ConnectionInfoOptions {
  fp?: string;
  latency?: number;
  sys?: SystemInfo;
}

/** Print the ASCII banner and connection info to stdout */
export function printConnectionInfo(
  client: RJDPClient,
  serverUrl: string,
  opts?: ConnectionInfoOptions,
): void {
  const termWidth = stdout.columns ?? 80;
  stdout.write(bold(green(BANNER)));

  const host = new URL(serverUrl).host;
  const capIcons: Record<string, string> = {
    eval: "eval",
    exec: "exec",
    fs: "fs",
    "fs:read": "fs:r",
    "fs:write": "fs:w",
  };
  const caps = client.capabilities.map((c) => green(capIcons[c] ?? c)).join(dim(", "));
  const scopes = client.scopes.map((s) => cyan(s)).join(dim(", "));
  const transport = magenta(client.transportType.toUpperCase());
  const sessionShort = client.sessionId.slice(0, 8);
  const expiresIn = Math.round((client.expiresAt - Date.now()) / 60_000);

  // Build left column (system info) and right column (connection info)
  const left: [string, string][] = [];
  const right: [string, string][] = [];

  if (opts?.sys) {
    const s = opts.sys;
    left.push(
      ["runtime", bold(cyan(s.runtime)) + dim(` ${s.version}`)],
      ["os", cyan(`${s.os}/${s.arch}`) + dim(` (${s.hostname})`)],
      ["uptime", dim(s.uptime)],
      ["cpu", dim(`${s.cpus} cores`)],
      ["memory", dim(`${s.memFree} free`) + dim(" / ") + dim(s.memTotal)],
      ["disk", dim(`${s.diskFree} free`) + dim(" / ") + dim(s.diskTotal)],
    );
  }

  const sessionVal =
    dim(sessionShort) +
    dim(` (${expiresIn}m)`) +
    (opts?.latency !== undefined ? dim(" · latency ") + dim(`${opts.latency}ms`) : "");

  right.push(
    ["capabilities", caps],
    ["scopes", scopes],
    ["transport", transport],
    ["session", sessionVal],
  );
  if (client.ip) {
    right.push(["ip", dim(client.ip)]);
  }
  if (opts?.fp) {
    right.push(["fingerprint", dim(opts.fp.slice(0, 4) + "..." + opts.fp.slice(-4))]);
  }

  const row = (label: string, value: string) => dim(`  ${label.padEnd(14)}`) + value;

  // Strip ANSI escape codes to measure visible width
  const ansiRe = new RegExp(String.raw`\x1B\[\d*(;\d+)*m`, "g");
  const stripAnsi = (s: string) => s.replace(ansiRe, "");
  let out = bold(green("  Connected")) + dim(" to ") + bold(cyan(host)) + "\n\n";

  if (left.length) {
    const leftStrs = left.map(([l, v]) => row(l, v));
    const colWidth = Math.max(...leftStrs.map((s) => stripAnsi(s).length)) + 4;
    const rightStrs = right.map(([l, v]) => row(l, v));
    const twoColWidth = colWidth + Math.max(...rightStrs.map((s) => stripAnsi(s).length));

    if (termWidth >= twoColWidth) {
      // Two-column layout
      const rows = Math.max(left.length, right.length);
      for (let i = 0; i < rows; i++) {
        const lStr = leftStrs[i] ?? "";
        const pad = colWidth - stripAnsi(lStr).length;
        const rEntry = right[i];
        const r = rEntry ? row(rEntry[0], rEntry[1]) : "";
        out += lStr + " ".repeat(Math.max(pad, 2)) + r + "\n";
      }
    } else {
      // Single-column fallback for narrow terminals
      for (const s of leftStrs) out += s + "\n";
      out += "\n";
      for (const s of rightStrs) out += s + "\n";
    }
  } else {
    for (const [label, value] of right) {
      out += row(label, value) + "\n";
    }
  }

  const helpLine = dim("  Type ") + bold("help") + dim(" for commands.");
  out += "\n" + helpLine + "\n\n";
  stdout.write(out);
}
