import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import type { VoiceMasterApi } from "../preload/index";
import { startVoiceCapture, stopVoiceCapture } from "./voice-capture";

declare global {
  interface Window {
    vm: VoiceMasterApi;
  }
}

interface Pane {
  id: string;
  term: Terminal;
  fit: FitAddon;
  tab: HTMLElement;
  host: HTMLElement;
  master: boolean;
  title: string;
}

const THEME = {
  background: "#12131a",
  foreground: "#d6d9e4",
  cursor: "#7aa2f7",
  selectionBackground: "#2f3444",
};

// Violet (#bb9af7) is reserved for the master session and not offered here: if
// another tab could take it, the colour would stop identifying it.
const PALETTE: Array<{ name: string; value: string }> = [
  { name: "red", value: "#f7768e" },
  { name: "orange", value: "#ff9e64" },
  { name: "yellow", value: "#e0af68" },
  { name: "green", value: "#9ece6a" },
  { name: "cyan", value: "#7dcfff" },
  { name: "blue", value: "#7aa2f7" },
  { name: "grey", value: "#565f89" },
  { name: "pink", value: "#ff75a0" },
];

const panes = new Map<string, Pane>();
let active: string | null = null;
let colorMenu: HTMLElement | null = null;

// Split view: with the master pinned, moving to another tab shows it alongside
// rather than replacing it.
let pinned = true;
let orientation: "columns" | "rows" = "columns";
let masterRatio = 0.5;

const MIN_RATIO = 0.15;
const MAX_RATIO = 0.85;

// The colour identifies the tab; the status dot keeps its own colour so the
// signal of what the terminal is doing is not lost.
function applyLabel(pane: Pane, title: string, color: string | null): void {
  pane.title = title;
  const label = pane.tab.querySelector(".label") as HTMLElement;
  label.textContent = pane.master ? `◆ ${title}` : title;

  if (color) {
    pane.tab.style.setProperty("--tab-color", color);
    pane.tab.classList.add("tinted");
  } else {
    pane.tab.style.removeProperty("--tab-color");
    pane.tab.classList.remove("tinted");
  }
}

function closeColorMenu(): void {
  colorMenu?.remove();
  colorMenu = null;
}

function showTabMenu(pane: Pane, x: number, y: number): void {
  const id = pane.id;
  closeColorMenu();

  const menu = document.createElement("div");
  menu.className = "tab-menu";
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;
  menu.addEventListener("click", (event) => event.stopPropagation());

  const input = document.createElement("input");
  input.className = "rename";
  input.value = pane.title;
  input.spellcheck = false;
  input.maxLength = 60;
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      const value = input.value.trim();
      if (value.length > 0) void window.vm.setTitle(id, value);
      closeColorMenu();
    } else if (event.key === "Escape") {
      closeColorMenu();
    }
  });
  menu.append(input);

  // The master takes no colour of its own: the reserved violet is its identity.
  if (pane.master) {
    const note = document.createElement("div");
    note.className = "menu-note";
    note.textContent = "Master session: fixed colour";
    menu.append(note);
    document.body.append(menu);
    colorMenu = menu;
    input.focus();
    input.select();
    return;
  }

  const swatches = document.createElement("div");
  swatches.className = "swatches";
  menu.append(swatches);

  for (const entry of PALETTE) {
    const swatch = document.createElement("button");
    swatch.className = "swatch";
    swatch.style.background = entry.value;
    swatch.title = entry.name;
    swatch.addEventListener("click", () => {
      void window.vm.setColor(id, entry.value);
      closeColorMenu();
    });
    swatches.append(swatch);
  }

  const clear = document.createElement("button");
  clear.className = "swatch clear";
  clear.textContent = "×";
  clear.title = "No colour";
  clear.addEventListener("click", () => {
    void window.vm.setColor(id, null);
    closeColorMenu();
  });
  swatches.append(clear);

  document.body.append(menu);
  colorMenu = menu;
  input.focus();
  input.select();
}

window.addEventListener("click", closeColorMenu);
window.addEventListener("blur", closeColorMenu);

const tabsEl = document.getElementById("tabs") as HTMLElement;
const panesEl = document.getElementById("panes") as HTMLElement;
const statusEl = document.getElementById("status") as HTMLElement;
const newTabEl = document.getElementById("new-tab") as HTMLButtonElement;
const dividerEl = document.getElementById("divider") as HTMLElement;
const pinEl = document.getElementById("toggle-pin") as HTMLButtonElement;
const orientationEl = document.getElementById("toggle-orientation") as HTMLButtonElement;
const notifyEl = document.getElementById("toggle-notify") as HTMLButtonElement;
const voiceEl = document.getElementById("toggle-voice") as HTMLButtonElement;

// The pinned state is changed from two places — the toolbar button and the one on
// the master tab itself — so both go through here.
function setPinned(value: boolean): void {
  pinned = value;
  pinEl.classList.toggle("on", pinned);
  for (const pane of panes.values()) {
    if (pane.master) pane.tab.classList.toggle("unpinned", !pinned);
  }
  layout();
}

pinEl.addEventListener("click", () => setPinned(!pinned));

notifyEl.addEventListener("click", () => {
  void (async () => {
    const enabled = await window.vm.setNotify(!notifyEl.classList.contains("on"));
    notifyEl.classList.toggle("on", enabled);
  })();
});

// Mic permission is requested before the (much heavier) local models are
// loaded in the main process: no point paying that cost if access is denied.
// Called from the toolbar button and at startup, where the microphone comes up
// with the application.
async function setVoiceOn(on: boolean): Promise<void> {
  if (on) {
    try {
      await startVoiceCapture();
    } catch (error) {
      console.error("voice: could not access the microphone", error);
      return;
    }
    const enabled = await window.vm.setVoiceEnabled(true);
    if (!enabled) {
      stopVoiceCapture();
      return;
    }
    voiceEl.classList.add("on");
  } else {
    await window.vm.setVoiceEnabled(false);
    stopVoiceCapture();
    voiceEl.classList.remove("on", "recording");
  }
}

voiceEl.addEventListener("click", () => void setVoiceOn(!voiceEl.classList.contains("on")));

window.vm.onVoiceState((state) => {
  voiceEl.classList.toggle("recording", state === "recording" || state === "transcribing");
  // "idle" means listening actually ended — the button was clicked off or the
  // pipeline broke — not a pause between utterances.
  if (state === "idle") {
    stopVoiceCapture();
    voiceEl.classList.remove("on", "recording");
  }
});

// The main process fires this when the master agent finishes its boot turn:
// its instructions are read and its watcher is mounted, so speech now has
// somewhere to go. Starting capture earlier would transcribe into a channel
// nobody reads yet.
window.vm.onVoiceAutostart(() => {
  if (!voiceEl.classList.contains("on")) void setVoiceOn(true);
});

orientationEl.addEventListener("click", () => {
  orientation = orientation === "columns" ? "rows" : "columns";
  orientationEl.textContent = orientation === "columns" ? "⬌" : "⬍";
  layout();
});

dividerEl.addEventListener("mousedown", (event) => {
  event.preventDefault();
  const rect = panesEl.getBoundingClientRect();

  const onMove = (move: MouseEvent): void => {
    const raw =
      orientation === "columns"
        ? (move.clientX - rect.left) / rect.width
        : (move.clientY - rect.top) / rect.height;
    masterRatio = Math.min(MAX_RATIO, Math.max(MIN_RATIO, raw));
    layout();
  };

  const onUp = (): void => {
    window.removeEventListener("mousemove", onMove);
    window.removeEventListener("mouseup", onUp);
    document.body.classList.remove("dragging");
  };

  document.body.classList.add("dragging");
  window.addEventListener("mousemove", onMove);
  window.addEventListener("mouseup", onUp);
});

function createPane(summary: { id: string; title: string; cwd: string; master?: boolean }): Pane {
  const tab = document.createElement("div");
  tab.className = summary.master ? "tab master" : "tab";
  tab.dataset["status"] = "idle";
  tab.title = summary.master
    ? `${summary.cwd}\nMaster session: out of reach of external control`
    : summary.cwd;
  // The master is not closable: instead of a close button it carries one that
  // hides it from the split view.
  tab.innerHTML = summary.master
    ? `<span class="dot"></span><span class="label"></span><span class="hide" title="Hide from split view">◆</span>`
    : `<span class="dot"></span><span class="label"></span><span class="close">×</span>`;
  (tab.querySelector(".label") as HTMLElement).textContent = summary.master
    ? `◆ ${summary.title}`
    : summary.title;

  tab.addEventListener("click", (event) => {
    const target = event.target as HTMLElement;

    if (target.classList.contains("close")) {
      void window.vm.close(summary.id);
      return;
    }

    if (target.classList.contains("hide")) {
      setPinned(!pinned);
      return;
    }

    activate(summary.id);
  });

  tabsEl.append(tab);

  const host = document.createElement("div");
  host.className = "pane";
  panesEl.append(host);

  const term = new Terminal({
    theme: THEME,
    fontFamily: "SF Mono, Menlo, monospace",
    fontSize: 12.5,
    cursorBlink: true,
    allowProposedApi: true,
    scrollback: 5000,
  });

  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(host);

  term.onData((data) => void window.vm.write(summary.id, data));

  // The pty is sized from the renderer: it is the one that knows the real size.
  term.onResize(({ cols, rows }) => void window.vm.resize(summary.id, cols, rows));

  const pane: Pane = {
    id: summary.id,
    term,
    fit,
    tab,
    host,
    master: summary.master ?? false,
    title: summary.title,
  };

  tab.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    event.stopPropagation();
    const rect = tab.getBoundingClientRect();
    // Anchored to the tab, clamped to the window width so the menu is not cut off
    // on the first or the last one.
    const left = Math.min(rect.left, window.innerWidth - 210);
    showTabMenu(pane, Math.max(8, left), rect.bottom + 4);
  });

  panes.set(summary.id, pane);
  return pane;
}

function masterPane(): Pane | undefined {
  return [...panes.values()].find((p) => p.master);
}

/**
 * Decides which panes are visible and in what proportion. With the master pinned
 * and focus on another tab both are shown; while on the master, it takes it all.
 */
function layout(): void {
  const master = masterPane();
  const split = pinned && master !== undefined && active !== null && active !== master.id;

  for (const pane of panes.values()) {
    const visible = pane.id === active || (split && pane.master);
    pane.host.classList.toggle("visible", visible);
    pane.tab.classList.toggle("active", pane.id === active);

    if (!visible) {
      pane.host.style.flex = "";
      continue;
    }

    if (!split) {
      pane.host.style.flex = "1 1 0";
      pane.host.style.order = "1";
      continue;
    }

    // The divider has order 2: the master sits before and the follower after.
    const share = pane.master ? masterRatio : 1 - masterRatio;
    pane.host.style.flex = `${share} 1 0`;
    pane.host.style.order = pane.master ? "1" : "3";
  }

  panesEl.classList.toggle("split", split);
  panesEl.dataset["orientation"] = orientation;
  dividerEl.style.display = split ? "block" : "none";

  refit();
}

// xterm does not resize itself: rows and columns must be recomputed after every
// layout change.
function refit(): void {
  requestAnimationFrame(() => {
    for (const pane of panes.values()) {
      if (pane.host.classList.contains("visible")) pane.fit.fit();
    }
    if (active) panes.get(active)?.term.focus();
  });
}

function activate(id: string): void {
  if (!panes.has(id)) return;
  active = id;
  layout();
}

function removePane(id: string): void {
  const pane = panes.get(id);
  if (!pane) return;

  pane.term.dispose();
  pane.tab.remove();
  pane.host.remove();
  panes.delete(id);

  if (active === id) {
    const next = panes.keys().next();
    active = next.done ? null : next.value;
  }

  layout();
}

async function openTerminal(cwd?: string, title?: string): Promise<void> {
  const summary = await window.vm.create({ cwd, title });
  if (!panes.has(summary.id)) createPane(summary);
  applyLabel(panes.get(summary.id) as Pane, summary.title, summary.color);
  activate(summary.id);
}

window.vm.onData((id, chunk) => {
  panes.get(id)?.term.write(chunk);
});

window.vm.onEvent((payload) => {
  const event = payload as {
    type: string;
    terminalId: string;
    detail: Record<string, unknown>;
  };

  const pane = panes.get(event.terminalId);
  if (!pane) return;

  if (event.type === "status") {
    pane.tab.dataset["status"] = String(event.detail["status"] ?? "idle");
  } else if (event.type === "exit") {
    pane.tab.dataset["status"] = "exited";
  } else if (event.type === "prompt") {
    pane.tab.dataset["status"] = "waiting";
  }
});

// Terminals created from the MCP server: the window did not ask for them, so it
// has to build their pane on hearing about it. The guard covers the ones it did
// open, whose pane already exists when this event arrives.
window.vm.onCreated((summary) => {
  if (panes.has(summary.id)) return;
  const pane = createPane(summary);
  applyLabel(pane, summary.title, summary.color);
  activate(summary.id);
});

window.vm.onClosed((id) => removePane(id));

window.vm.onLabel((summary) => {
  const pane = panes.get(summary.id);
  if (pane) applyLabel(pane, summary.title, summary.color);
});

window.vm.onMcpReady((url) => {
  statusEl.textContent = `MCP :${new URL(url).port}`;
});

let homeDir = "";
newTabEl.addEventListener("click", () => void openTerminal(homeDir || undefined));

window.addEventListener("resize", refit);

void (async () => {
  setPinned(pinned);
  const info = await window.vm.info();
  homeDir = info.home;
  notifyEl.classList.toggle("on", info.notify);
  voiceEl.classList.toggle("on", info.voiceEnabled);
  if (info.voiceEnabled) void startVoiceCapture();
  // Port only: the URL carries the access secret and must not be on display.
  if (info.mcpUrl) statusEl.textContent = `MCP :${new URL(info.mcpUrl).port}`;

  // The first tab opened from the window becomes the master, and starts in the
  // directory holding its instructions.
  await openTerminal(info.masterDir, "master");
})();
