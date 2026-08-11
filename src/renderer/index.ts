import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import type { VoiceMasterApi } from "../preload/index";

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

// El violeta (#bb9af7) queda reservado a la sesión maestra y no se ofrece aquí:
// si otra pestaña pudiera tomarlo, el color dejaría de identificarla.
const PALETTE: Array<{ name: string; value: string }> = [
  { name: "rojo", value: "#f7768e" },
  { name: "naranja", value: "#ff9e64" },
  { name: "amarillo", value: "#e0af68" },
  { name: "verde", value: "#9ece6a" },
  { name: "cian", value: "#7dcfff" },
  { name: "azul", value: "#7aa2f7" },
  { name: "gris", value: "#565f89" },
  { name: "rosa", value: "#ff75a0" },
];

const panes = new Map<string, Pane>();
let active: string | null = null;
let colorMenu: HTMLElement | null = null;

// Vista dividida: con la maestra fijada, moverse a otra pestaña la muestra junto
// a ella en lugar de reemplazarla.
let pinned = true;
let orientation: "columns" | "rows" = "columns";
let masterRatio = 0.5;

const MIN_RATIO = 0.15;
const MAX_RATIO = 0.85;

// El color identifica la pestaña; el punto de estado conserva su propio color
// para no perder la señal de qué está haciendo la terminal.
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

  // La maestra no admite color propio: el violeta reservado es su identidad.
  if (pane.master) {
    const note = document.createElement("div");
    note.className = "menu-note";
    note.textContent = "Sesión maestra: color fijo";
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
  clear.title = "Sin color";
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

// El estado de fijación se cambia desde dos sitios —el botón de la barra y el de
// la propia pestaña maestra—, así que ambos pasan por aquí.
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
    ? `${summary.cwd}\nSesión maestra: fuera del alcance del control externo`
    : summary.cwd;
  // La maestra no se cierra: en lugar del botón de cierre lleva uno que la
  // oculta de la vista dividida.
  tab.innerHTML = summary.master
    ? `<span class="dot"></span><span class="label"></span><span class="hide" title="Ocultar de la vista dividida">◆</span>`
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

  // El pty se dimensiona desde el renderer: es quien conoce el tamaño real.
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
    // Se ancla a la pestaña, acotado al ancho de la ventana para que el menú no
    // quede cortado en la primera ni en la última.
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
 * Decide qué paneles se ven y en qué proporción. Con la maestra fijada y el foco
 * en otra pestaña se muestran ambos; estando en la maestra, ella ocupa todo.
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

    // El divisor tiene orden 2: la maestra queda antes y la seguidora después.
    const share = pane.master ? masterRatio : 1 - masterRatio;
    pane.host.style.flex = `${share} 1 0`;
    pane.host.style.order = pane.master ? "1" : "3";
  }

  panesEl.classList.toggle("split", split);
  panesEl.dataset["orientation"] = orientation;
  dividerEl.style.display = split ? "block" : "none";

  refit();
}

// xterm no se redimensiona solo: hay que recalcular filas y columnas después de
// cada cambio de disposición.
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

// Terminales creadas desde el servidor MCP: la ventana no las pidió, así que
// tiene que construir su panel al enterarse. El guard cubre las que sí abrió
// ella, cuyo panel ya existe cuando llega este evento.
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
  // Solo el puerto: la URL lleva el secreto de acceso y no debe quedar a la vista.
  if (info.mcpUrl) statusEl.textContent = `MCP :${new URL(info.mcpUrl).port}`;

  // La primera pestaña abierta desde la ventana queda como maestra, y arranca en
  // el directorio con sus instrucciones.
  await openTerminal(info.masterDir, "maestra");
})();
