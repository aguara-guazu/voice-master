import { randomBytes } from "node:crypto";
import path from "node:path";
import os from "node:os";
import { app, BrowserWindow, ipcMain } from "electron";
import { Registry } from "./registry";
import { prepareMasterSession, writeMcpConfig } from "./master-session";
import { MasterNotifier } from "./notifier";
import { startMcpServer } from "./mcp";
import type { McpEndpoint } from "./mcp";
import type { TerminalEvent } from "./terminal";

const MCP_PORT = Number(process.env.VOICE_MASTER_MCP_PORT ?? 7317);

let window: BrowserWindow | null = null;
let registry: Registry | null = null;
let mcp: McpEndpoint | null = null;
let masterDir: string = os.homedir();
let notifier: MasterNotifier | null = null;

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1180,
    height: 760,
    backgroundColor: "#12131a",
    titleBarStyle: "hiddenInset",
    webPreferences: {
      preload: path.join(__dirname, "..", "preload", "index.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  void win.loadFile(path.join(__dirname, "..", "renderer", "index.html"));
  return win;
}

function send(channel: string, ...args: unknown[]): void {
  if (window && !window.isDestroyed()) {
    window.webContents.send(channel, ...args);
  }
}

function wireRegistry(reg: Registry): void {
  reg.on("data", (id: string, chunk: string) => send("terminal:data", id, chunk));
  reg.on("event", (payload: TerminalEvent) => send("terminal:event", payload));
  reg.on("created", (summary: unknown) => send("terminal:created", summary));
  reg.on("closed", (id: string) => send("terminal:closed", id));
  reg.on("label", (summary: unknown) => send("terminal:label", summary));
}

function registerIpc(reg: Registry): void {
  // La interfaz ve todas las terminales; el servidor MCP usa reg.list().
  ipcMain.handle("terminals:list", () => reg.listAll());

  ipcMain.handle("terminals:create", (_event, options: { cwd?: string; title?: string }) => {
    // allowMaster solo aquí: una terminal creada por MCP nunca puede ser maestra.
    const terminal = reg.create({
      cwd: options.cwd ?? os.homedir(),
      title: options.title,
      allowMaster: true,
    });
    return {
      id: terminal.id,
      title: terminal.title,
      cwd: terminal.cwd,
      pid: terminal.pid,
      status: terminal.status,
      master: terminal.master,
    };
  });

  // Esta ruta es el teclado del usuario: se marca para que los avisos
  // automáticos no le mezclen texto mientras escribe.
  ipcMain.handle("terminals:write", (_event, id: string, data: string) => {
    const terminal = reg.get(id);
    terminal.markUserInput();
    terminal.write(data);
  });

  ipcMain.handle("terminals:resize", (_event, id: string, cols: number, rows: number) => {
    reg.get(id).resize(cols, rows);
  });

  // La maestra no se cierra: ahí corre la sesión que administra a las demás, y
  // cerrarla deja la aplicación sin orquestador. Se oculta de la vista dividida
  // en su lugar. Ocultar el botón en la interfaz no basta: este canal recibe el
  // identificador y hay que rechazarlo aquí.
  ipcMain.handle("terminals:close", (_event, id: string) => {
    if (reg.get(id).master) {
      throw new Error("la sesión maestra no se puede cerrar; se oculta de la vista dividida");
    }
    reg.close(id);
  });

  // La maestra también admite nombre y color: su distintivo es el marcador del
  // título, no el tono.
  ipcMain.handle("terminals:setColor", (_event, id: string, color: string | null) => {
    reg.get(id).setColor(color);
    reg.notifyLabel(id);
  });

  ipcMain.handle("terminals:setTitle", (_event, id: string, title: string) => {
    reg.get(id).setTitle(title);
    reg.notifyLabel(id);
  });

  ipcMain.handle("terminals:snapshot", (_event, id: string, lines: number) =>
    reg.get(id).snapshot(lines),
  );

  ipcMain.handle("app:set-notify", (_event, enabled: boolean) => {
    notifier?.setEnabled(enabled);
    return notifier?.isEnabled ?? false;
  });

  ipcMain.handle("app:info", () => ({
    mcpUrl: mcp?.url ?? null,
    eventLog: reg.eventLogPath,
    home: os.homedir(),
    masterDir,
    notify: notifier?.isEnabled ?? false,
  }));
}

void app.whenReady().then(async () => {
  const stateDir = app.getPath("userData");

  // __dirname apunta a dist/main; los recursos viven dos niveles arriba.
  try {
    masterDir = await prepareMasterSession(stateDir, path.join(__dirname, "..", ".."));
  } catch (error) {
    // Sin el directorio de instrucciones la aplicación sigue siendo usable; la
    // sesión maestra arranca en el home y se avisa por consola.
    console.error("no se pudo preparar el directorio de la sesión maestra:", error);
  }

  registry = new Registry(stateDir);
  await registry.init();
  notifier = new MasterNotifier(registry);
  registerIpc(registry);
  wireRegistry(registry);

  // El servidor se levanta antes de abrir la ventana: la pestaña maestra se crea
  // al cargar el renderer, y su sesión lee la configuración MCP al iniciarse.
  // Secreto de acceso al servidor, nuevo en cada arranque. Solo queda escrito en
  // la configuración del directorio de la sesión maestra, de modo que ninguna otra
  // sesión ni proceso puede usar las herramientas de pestañas.
  const token = randomBytes(16).toString("hex");

  try {
    mcp = await startMcpServer(registry, MCP_PORT, token);
    await writeMcpConfig(masterDir, mcp.url);
  } catch (error) {
    console.error("no se pudo iniciar el servidor MCP:", error);
  }

  window = createWindow();
  window.webContents.once("did-finish-load", () => {
    if (mcp) send("app:mcp-ready", mcp.url);
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      window = createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  registry?.disposeAll();
  void mcp?.close();
});
