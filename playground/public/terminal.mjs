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

  const isMobile = "ontouchstart" in window;

  const term = new Terminal({
    cursorBlink: true,
    fontSize: isMobile ? 11 : 13,
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

  // On mobile: don't auto-focus (prevents keyboard popping up on every tap)
  if (!isMobile) {
    term.focus();
  }

  const ro = new ResizeObserver(() => fitAddon.fit());
  ro.observe(el);

  // Mobile: custom virtual keyboard (no OS keyboard)
  if (isMobile) {
    const textarea = el.querySelector("textarea.xterm-helper-textarea");
    // Prevent xterm from ever opening the OS keyboard
    if (textarea) textarea.setAttribute("readonly", "");

    const { createKeyboard } = await import("./_keyboard.mjs");
    const card = el.closest(".card");
    const kb = await createKeyboard(term);

    const _show = kb.show.bind(kb);
    const _hide = kb.hide.bind(kb);
    kb.show = () => {
      _show();
      card?.classList.add("vkb-open");
      fitAddon.fit();
    };
    kb.hide = () => {
      _hide();
      card?.classList.remove("vkb-open");
      fitAddon.fit();
    };

    document.body.appendChild(kb.el);

    // Tap terminal to show keyboard
    el.addEventListener("pointerdown", () => {
      if (!kb.visible) kb.show();
    });
  }

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

  // Restore cached session from localStorage
  const STORAGE_KEY = "xjdp_session";
  let cachedSession;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed.expiresAt > Date.now()) {
        cachedSession = parsed;
      } else {
        localStorage.removeItem(STORAGE_KEY);
      }
    }
  } catch {}

  const t0 = performance.now();
  const client = await RJDPClient.connect(url, {
    privateKey,
    publicKey,
    serverFingerprint: fp4,
    session: cachedSession,
  });
  const latency = Math.round(performance.now() - t0);

  // Persist session for next reload
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        sessionId: client.sessionId,
        ip: client.ip,
        scopes: client.scopes,
        expiresAt: client.expiresAt,
      }),
    );
  } catch {}

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
