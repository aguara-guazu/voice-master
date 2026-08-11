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
  // The interface sees every terminal; the MCP server uses reg.list().
  ipcMain.handle("terminals:list", () => reg.listAll());

  ipcMain.handle("terminals:create", (_event, options: { cwd?: string; title?: string }) => {
    // allowMaster only here: a terminal created over MCP can never be the master.
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

  // This route is the user's keyboard: it is marked so automatic notices do not
  // mix text in while they type.
  ipcMain.handle("terminals:write", (_event, id: string, data: string) => {
    const terminal = reg.get(id);
    terminal.markUserInput();
    terminal.write(data);
  });

  ipcMain.handle("terminals:resize", (_event, id: string, cols: number, rows: number) => {
    reg.get(id).resize(cols, rows);
  });

  // The master is not closable: it runs the session administering the others, and
  // closing it leaves the application without an orchestrator. It hides from the
  // split view instead. Hiding the button in the interface is not enough: this
  // channel receives the identifier and has to reject it here.
  ipcMain.handle("terminals:close", (_event, id: string) => {
    if (reg.get(id).master) {
      throw new Error("the master session cannot be closed; it hides from the split view");
    }
    reg.close(id);
  });

  // The master takes a name and colour like any other tab: its distinguishing
  // mark is the title marker, not the hue.
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

  // __dirname points at dist/main; resources live two levels up.
  try {
    masterDir = await prepareMasterSession(stateDir, path.join(__dirname, "..", ".."));
  } catch (error) {
    // Without the instructions directory the application is still usable; the
    // master session starts in the home directory and this is logged.
    console.error("could not prepare the master session directory:", error);
  }

  registry = new Registry(stateDir);
  await registry.init();
  notifier = new MasterNotifier(registry);
  registerIpc(registry);
  wireRegistry(registry);

  // Access secret for the server, new on every start. It is only written to the
  // configuration of the master session's directory, so no other session or
  // process can use the tab tools.
  const token = randomBytes(16).toString("hex");

  // The server comes up before the window opens: the master tab is created when
  // the renderer loads, and its session reads the MCP configuration at startup.
  try {
    mcp = await startMcpServer(registry, MCP_PORT, token);
    await writeMcpConfig(masterDir, mcp.url);
  } catch (error) {
    console.error("could not start the MCP server:", error);
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
