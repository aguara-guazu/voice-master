import { contextBridge, ipcRenderer } from "electron";
import type { IpcRendererEvent } from "electron";

export interface TerminalSummary {
  id: string;
  title: string;
  cwd: string;
  shell: string;
  pid: number;
  status: string;
  exitCode: number | null;
  master: boolean;
  color: string | null;
}

const api = {
  list: (): Promise<TerminalSummary[]> => ipcRenderer.invoke("terminals:list"),

  create: (options: { cwd?: string; title?: string }): Promise<TerminalSummary> =>
    ipcRenderer.invoke("terminals:create", options),

  write: (id: string, data: string): Promise<void> =>
    ipcRenderer.invoke("terminals:write", id, data),

  resize: (id: string, cols: number, rows: number): Promise<void> =>
    ipcRenderer.invoke("terminals:resize", id, cols, rows),

  close: (id: string): Promise<void> => ipcRenderer.invoke("terminals:close", id),

  setColor: (id: string, color: string | null): Promise<void> =>
    ipcRenderer.invoke("terminals:setColor", id, color),

  setTitle: (id: string, title: string): Promise<void> =>
    ipcRenderer.invoke("terminals:setTitle", id, title),

  snapshot: (id: string, lines: number): Promise<string[]> =>
    ipcRenderer.invoke("terminals:snapshot", id, lines),

  info: (): Promise<{
    mcpUrl: string | null;
    eventLog: string;
    home: string;
    masterDir: string;
    notify: boolean;
  }> => ipcRenderer.invoke("app:info"),

  setNotify: (enabled: boolean): Promise<boolean> =>
    ipcRenderer.invoke("app:set-notify", enabled),

  onData: (handler: (id: string, chunk: string) => void): void => {
    ipcRenderer.on("terminal:data", (_e: IpcRendererEvent, id: string, chunk: string) =>
      handler(id, chunk),
    );
  },

  onEvent: (handler: (payload: unknown) => void): void => {
    ipcRenderer.on("terminal:event", (_e: IpcRendererEvent, payload: unknown) => handler(payload));
  },

  // Una terminal puede nacer desde la ventana o desde el servidor MCP. Este
  // evento es la única vía por la que la interfaz se entera de las segundas.
  onCreated: (handler: (summary: TerminalSummary) => void): void => {
    ipcRenderer.on("terminal:created", (_e: IpcRendererEvent, summary: TerminalSummary) =>
      handler(summary),
    );
  },

  onClosed: (handler: (id: string) => void): void => {
    ipcRenderer.on("terminal:closed", (_e: IpcRendererEvent, id: string) => handler(id));
  },

  onMcpReady: (handler: (url: string) => void): void => {
    ipcRenderer.on("app:mcp-ready", (_e: IpcRendererEvent, url: string) => handler(url));
  },

  // Un cambio de nombre o color puede venir de la ventana o del servidor MCP;
  // ambos llegan por aquí para que la interfaz sea el reflejo de un solo estado.
  onLabel: (handler: (summary: TerminalSummary) => void): void => {
    ipcRenderer.on("terminal:label", (_e: IpcRendererEvent, summary: TerminalSummary) =>
      handler(summary),
    );
  },
};

contextBridge.exposeInMainWorld("vm", api);

export type VoiceMasterApi = typeof api;
