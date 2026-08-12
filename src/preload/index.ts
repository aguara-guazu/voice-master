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
    voiceEnabled: boolean;
  }> => ipcRenderer.invoke("app:info"),

  setNotify: (enabled: boolean): Promise<boolean> =>
    ipcRenderer.invoke("app:set-notify", enabled),

  setVoiceEnabled: (enabled: boolean): Promise<boolean> =>
    ipcRenderer.invoke("voice:set-enabled", enabled),

  // Fire-and-forget: chunks arrive several times a second, an ack per chunk
  // would be pure overhead.
  sendAudioChunk: (buffer: ArrayBuffer): void => ipcRenderer.send("voice:audio-chunk", buffer),

  onVoiceState: (handler: (state: string) => void): void => {
    ipcRenderer.on("voice:state", (_e: IpcRendererEvent, state: string) => handler(state));
  },

  // Fired once, when the master agent finishes its boot turn: the moment from
  // which spoken input has somewhere to go.
  onVoiceAutostart: (handler: () => void): void => {
    ipcRenderer.on("voice:autostart", () => handler());
  },

  // Synthesised audio arrives in sentence-aligned chunks as the model produces
  // them, so playback starts before the whole utterance exists.
  // Float32Array<ArrayBuffer> rather than the default ArrayBufferLike: the
  // renderer feeds these straight into an AudioBuffer, which rejects a buffer
  // that might be shared.
  onSpeechChunk: (
    handler: (samples: Float32Array<ArrayBuffer>, sampleRate: number) => void,
  ): void => {
    ipcRenderer.on("speech:chunk", (_e: IpcRendererEvent, buffer: ArrayBuffer, sampleRate: number) =>
      handler(new Float32Array(buffer), sampleRate),
    );
  },

  // No more chunks are coming: whatever is already scheduled is the whole
  // utterance. Playback still has to drain before the microphone reopens.
  onSpeechEnd: (handler: () => void): void => {
    ipcRenderer.on("speech:end", () => handler());
  },

  onSpeechSpeaking: (handler: (speaking: boolean) => void): void => {
    ipcRenderer.on("speech:speaking", (_e: IpcRendererEvent, speaking: boolean) =>
      handler(speaking),
    );
  },

  // Reports the speakers have gone quiet, which is what reopens the microphone.
  notifySpeechFinished: (): void => ipcRenderer.send("speech:finished"),

  onData: (handler: (id: string, chunk: string) => void): void => {
    ipcRenderer.on("terminal:data", (_e: IpcRendererEvent, id: string, chunk: string) =>
      handler(id, chunk),
    );
  },

  onEvent: (handler: (payload: unknown) => void): void => {
    ipcRenderer.on("terminal:event", (_e: IpcRendererEvent, payload: unknown) => handler(payload));
  },

  // A terminal can be born from the window or from the MCP server. This event
  // is the only way the interface learns about the latter.
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

  // A name or colour change can come from the window or from the MCP server;
  // both arrive here so the interface reflects a single source of state.
  onLabel: (handler: (summary: TerminalSummary) => void): void => {
    ipcRenderer.on("terminal:label", (_e: IpcRendererEvent, summary: TerminalSummary) =>
      handler(summary),
    );
  },
};

contextBridge.exposeInMainWorld("vm", api);

export type VoiceMasterApi = typeof api;
