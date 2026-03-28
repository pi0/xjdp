// Web terminal — xterm.js + XJDP CLI polyfill

import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";

const XTERM_CSS = "https://esm.sh/@xterm/xterm@5/css/xterm.css";

/** @param {{ el: HTMLElement, url: string, key: string, fingerprint: string }} opts */
export async function createTerminal({ el, url, key, fingerprint }) {
  // Inject xterm.js CSS
  if (!document.querySelector(`link[href="${XTERM_CSS}"]`)) {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = XTERM_CSS;
    document.head.appendChild(link);
  }

  const term = new Terminal({
    cursorBlink: true,
    fontSize: 13,
    theme: {
      background: "#0a0a0a",
      foreground: "#ededed",
      cursor: "#ededed",
      selectionBackground: "#333",
    },
  });

  const fitAddon = new FitAddon();
  term.loadAddon(fitAddon);
  term.loadAddon(new WebLinksAddon());
  term.open(el);
  fitAddon.fit();
  term.focus();

  const ro = new ResizeObserver(() => fitAddon.fit());
  ro.observe(el);

  // Install polyfill before importing CLI modules
  const { installWebPolyfill } = await import("xjdp/cli/web");
  const cleanup = installWebPolyfill({
    xterm: term,
    env: { XJDP_URL: url, XJDP_KEY: key, XJDP_FINGERPRINT: fingerprint },
    onExit: () => term.write("\r\n\x1B[2m[session ended]\x1B[0m\r\n"),
  });

  // Now safe to import CLI (reads process.getBuiltinModule at module scope)
  const { startRepl, SYSTEM_INFO_EVAL, setCwd, setHome } = await import("xjdp/cli");
  const { RJDPClient, parseKey, fingerprint: getFingerprint } = await import("xjdp");

  // Connect and start REPL
  const { privateKey, publicKey } = await parseKey(key);
  const fp4 = fingerprint.slice(0, 4);

  const t0 = performance.now();
  const client = await RJDPClient.connect(url, {
    privateKey,
    publicKey,
    serverFingerprint: fp4,
  });
  const latency = Math.round(performance.now() - t0);

  // Gather remote system info
  const fp = await getFingerprint(publicKey);
  let sys;
  try {
    const { result } = await client.eval(SYSTEM_INFO_EVAL);
    sys = result;
    if (sys?.cwd) setCwd(sys.cwd);
    if (sys?.home) setHome(sys.home);
  } catch {}

  await startRepl(client, {
    serverUrl: url,
    connectOpts: { privateKey, publicKey, serverFingerprint: fp4 },
    connectionInfo: { fp, latency, sys },
  });

  cleanup();
  client.close();

  return { term, cleanup };
}
