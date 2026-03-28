// Mobile virtual keyboard for xterm.js — powered by simple-keyboard
// https://virtual-keyboard.js.org

const CDN_CSS = "https://cdn.jsdelivr.net/npm/simple-keyboard@latest/build/css/index.css";
const CDN_JS = "https://cdn.jsdelivr.net/npm/simple-keyboard@latest/build/index.js";

const STYLE = `
.vkb { display:none; position:fixed; bottom:0; left:0; right:0; z-index:9999;
  background:#111; border-top:1px solid #333; padding:4px 2px;
  user-select:none; -webkit-user-select:none; touch-action:manipulation; }
.vkb-dismiss { position:absolute; top:-28px; right:4px; z-index:1;
  background:#111; border:1px solid #333; border-radius:4px;
  color:#444; font-size:12px; opacity:0.6;
  cursor:pointer; padding:2px 8px; -webkit-tap-highlight-color:transparent; }
.vkb-dismiss:active { opacity:1; color:#ededed; }

/* dark overrides — .hg-theme-dark stacked on .hg-theme-default wins specificity */
.vkb .hg-theme-default.hg-theme-dark { background:transparent; padding:0; font-family:"Geist Pixel Square",monospace; }
.vkb .hg-theme-default.hg-theme-dark .hg-button { background:#1a1a1a; border:1px solid #333; border-radius:5px;
  color:#ccc; font-family:"Geist Pixel Square",monospace; font-size:12px;
  height:38px; min-height:38px; box-shadow:none;
  transition:background .08s,color .08s; -webkit-tap-highlight-color:transparent; }
.vkb .hg-theme-default.hg-theme-dark .hg-button:active,
.vkb .hg-theme-default.hg-theme-dark .hg-button.hg-activeButton { background:#333; color:#fff; }
.vkb .hg-theme-default.hg-theme-dark .hg-button.held { background:#444; color:#fff; border-color:#888; }
.vkb .hg-theme-default.hg-theme-dark .hg-button[data-skbtn="{space}"] { min-width:40%; }
.vkb .hg-theme-default.hg-theme-dark .hg-button[data-skbtn="{enter}"] { background:#252525; }
.vkb .hg-theme-default.hg-theme-dark .hg-button[data-skbtn="{enter}"]:active { background:#444; }
.vkb .hg-theme-default.hg-theme-dark .hg-row { gap:3px; margin-bottom:3px; }
`;

const LAYOUT = {
  default: [
    "q w e r t y u i o p {bksp}",
    "a s d f g h j k l {enter}",
    "{shift} z x c v b n m {shift}",
    "{num} {ctrl} {esc} {space} {tab}",
  ],
  shift: [
    "Q W E R T Y U I O P {bksp}",
    "A S D F G H J K L {enter}",
    "{shift} Z X C V B N M {shift}",
    "{num} {ctrl} {esc} {space} {tab}",
  ],
  num: [
    "1 2 3 4 5 6 7 8 9 0 {bksp}",
    "- / : ; ( ) $ & @ {enter}",
    "{sym} \" . , ? ! ' \\ | ~",
    "{abc} {ctrl} {esc} {space} {tab}",
  ],
  sym: [
    "[ ] { } # % ^ * + = {bksp}",
    "_ \\ | ~ < > € £ ¥ {enter}",
    "{num} · . , ? ! ' ` & @",
    "{abc} {ctrl} {esc} {space} {tab}",
  ],
};

const DISPLAY = {
  "{bksp}": "⌫",
  "{enter}": "⏎",
  "{shift}": "⇧",
  "{lock}": "⇪",
  "{tab}": "Tab",
  "{space}": " ",
  "{ctrl}": "Ctrl",
  "{esc}": "Esc",
  "{abc}": "ABC",
  "{num}": "123",
  "{sym}": "#+=",
};

/** Load simple-keyboard from CDN (once) */
async function loadSimpleKeyboard() {
  if (window.SimpleKeyboard) return window.SimpleKeyboard.default;

  // CSS
  if (!document.querySelector(`link[href="${CDN_CSS}"]`)) {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = CDN_CSS;
    document.head.appendChild(link);
  }

  // JS
  await new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = CDN_JS;
    s.onload = resolve;
    s.onerror = reject;
    document.head.appendChild(s);
  });

  return window.SimpleKeyboard.default;
}

/**
 * Creates a virtual keyboard for xterm using simple-keyboard.
 * @param {import("@xterm/xterm").Terminal} term
 * @returns {Promise<{ el: HTMLElement, show(): void, hide(): void, visible: boolean }>}
 */
export async function createKeyboard(term) {
  const Keyboard = await loadSimpleKeyboard();

  // Inject custom styles
  if (!document.querySelector("style[data-vkb]")) {
    const s = document.createElement("style");
    s.setAttribute("data-vkb", "");
    s.textContent = STYLE;
    document.head.appendChild(s);
  }

  const root = document.createElement("div");
  root.className = "vkb";

  // Prevent touch/click from stealing focus from xterm
  root.addEventListener("pointerdown", (e) => e.preventDefault());
  root.addEventListener("mousedown", (e) => e.preventDefault());

  // Dismiss button
  let onHide = () => {};
  const hideBtn = document.createElement("button");
  hideBtn.className = "vkb-dismiss";
  hideBtn.textContent = "⌨ ▾";
  hideBtn.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    onHide();
  });
  root.appendChild(hideBtn);

  // Keyboard container
  const kbContainer = document.createElement("div");
  kbContainer.className = "vkb-kb";
  root.appendChild(kbContainer);

  let ctrl = false;
  let shiftToggle = false;

  const kb = new Keyboard(kbContainer, {
    theme: "hg-theme-default hg-theme-dark simple-keyboard",
    layout: LAYOUT,
    layoutName: "default",
    display: DISPLAY,
    mergeDisplay: true,
    preventMouseDownDefault: true,
    disableCaretPositioning: true,
    useButtonTag: true,
    physicalKeyboardHighlight: false,
    onKeyPress: (button) => handleKey(button),
    onKeyReleased: () => {},
  });

  function haptic() {
    navigator.vibrate?.(8);
  }

  function updateHeldState() {
    // Ctrl
    const ctrlBtn = root.querySelector('[data-skbtn="{ctrl}"]');
    ctrlBtn?.classList.toggle("held", ctrl);
    // Shift (only in default/shift layouts)
    const shiftBtns = root.querySelectorAll('[data-skbtn="{shift}"]');
    for (const btn of shiftBtns) btn.classList.toggle("held", shiftToggle);
  }

  function send(ch) {
    let input = ch;
    if (ctrl && ch.length === 1 && /[a-z]/i.test(ch)) {
      input = String.fromCharCode(ch.toUpperCase().charCodeAt(0) - 64);
      ctrl = false;
      updateHeldState();
    } else if (shiftToggle && ch.length === 1 && /[a-z]/.test(ch)) {
      input = ch.toUpperCase();
      shiftToggle = false;
      kb.setOptions({ layoutName: "default" });
      updateHeldState();
    }
    term.input(input, true);
  }

  function handleKey(button) {
    haptic();
    switch (button) {
      case "{shift}":
        shiftToggle = !shiftToggle;
        kb.setOptions({ layoutName: shiftToggle ? "shift" : "default" });
        updateHeldState();
        return;
      case "{lock}": {
        const current = kb.options.layoutName;
        kb.setOptions({ layoutName: current === "shift" ? "default" : "shift" });
        shiftToggle = false;
        updateHeldState();
        return;
      }
      case "{bksp}":
        term.input("\x7F", true);
        return;
      case "{enter}":
        term.input("\r", true);
        return;
      case "{ctrl}":
        ctrl = !ctrl;
        updateHeldState();
        return;
      case "{tab}":
        term.input("\t", true);
        return;
      case "{esc}":
        term.input("\x1B", true);
        return;
      case "{space}":
        send(" ");
        return;
      case "{num}":
        kb.setOptions({ layoutName: "num" });
        shiftToggle = false;
        updateHeldState();
        return;
      case "{sym}":
        kb.setOptions({ layoutName: "sym" });
        shiftToggle = false;
        updateHeldState();
        return;
      case "{abc}":
        kb.setOptions({ layoutName: "default" });
        shiftToggle = false;
        updateHeldState();
        return;
      default:
        send(button);
    }
  }

  let visible = false;
  const api = {
    el: root,
    get visible() {
      return visible;
    },
    show() {
      visible = true;
      root.style.display = "block";
      requestAnimationFrame(() => {
        document.documentElement.style.setProperty("--vkb-h", root.offsetHeight + "px");
      });
    },
    hide() {
      visible = false;
      root.style.display = "none";
      document.documentElement.style.setProperty("--vkb-h", "0px");
      ctrl = false;
      shiftToggle = false;
      kb.setOptions({ layoutName: "default" });
      updateHeldState();
    },
  };

  onHide = () => api.hide();

  return api;
}
