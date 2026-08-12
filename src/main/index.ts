import { randomBytes } from "node:crypto";
import { appendFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { app, BrowserWindow, ipcMain } from "electron";
import { Registry } from "./registry";
import { prepareMasterSession, writeMcpConfig } from "./master-session";
import { MasterNotifier } from "./notifier";
import { VoiceController } from "./voice";
import type { VoiceState } from "./voice";
import { SpeechController } from "./speech";
import { startMcpServer } from "./mcp";
import type { McpEndpoint } from "./mcp";
import type { Terminal, TerminalEvent } from "./terminal";

const MCP_PORT = Number(process.env.VOICE_MASTER_MCP_PORT ?? 7317);

// First message of the master agent's session. Passed as a CLI argument so no
// keystrokes need injecting into a TUI whose readiness cannot be observed.
// Single-quoted for the shell: nothing in it may expand or need escaping.
const MASTER_BOOT_PROMPT =
  "Session start: read AGENTS.md in this directory and follow it now - " +
  "set up your watcher first, then tell the user in one line that you are ready.";

let window: BrowserWindow | null = null;
let registry: Registry | null = null;
let mcp: McpEndpoint | null = null;
let masterDir: string = os.homedir();
let notifier: MasterNotifier | null = null;
let voice: VoiceController | null = null;
let speech: SpeechController | null = null;

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

/**
 * Starts the agent in the master tab as soon as its shell draws a prompt, same
 * wait as terminal_open's `run`: writing earlier loses the command, and loading
 * the user's profile has no predictable duration. On timeout (a shell without
 * integration markers) it writes anyway.
 */
function autostartMasterAgent(terminal: Terminal): void {
  void terminal.waitForPrompt(8000).then(() => {
    try {
      terminal.write(`claude '${MASTER_BOOT_PROMPT}'\r`);
    } catch (error) {
      console.error("could not start the master agent:", error);
    }
  });
}

function wireVoice(controller: VoiceController): void {
  controller.on("state", (state: VoiceState) => {
    console.log(`voice: state -> ${state}`); // TEMPORARY, see voice.ts's logAudioLevel note
    send("voice:state", state);
  });
}

/**
 * Audio synthesised in this process has to be played where the web APIs are, so
 * every chunk crosses to the renderer as it comes out of the model.
 *
 * The microphone is gated on "speaking" rather than on the individual chunks:
 * it closes when synthesis starts and reopens only once the renderer reports
 * the sound has stopped. Anything narrower would leave the tail of an utterance
 * being captured while the gate is already open.
 */
function wireSpeech(controller: SpeechController, listening: VoiceController): void {
  controller.on("chunk", (samples: Float32Array, sampleRate: number) => {
    send("speech:chunk", samples.buffer, sampleRate);
  });
  controller.on("end", () => send("speech:end"));
  controller.on("speaking", (speaking: boolean) => {
    listening.setMuted(speaking);
    send("speech:speaking", speaking);
  });
}

/**
 * Fires the microphone exactly when the master agent finishes its boot turn:
 * by then it has read its instructions and mounted the watcher on the voice
 * channel, so speech has somewhere to go. Capturing earlier would transcribe
 * into a file nobody reads yet.
 */
function armVoiceAutostart(reg: Registry): void {
  const onEvent = (event: TerminalEvent): void => {
    if (event.type !== "notification") return;
    const payload = event.detail["payload"] as Record<string, unknown> | undefined;
    const kind = payload?.["event"];
    if (kind !== "stop" && kind !== "stop_failure") return;
    if (!reg.peek(event.terminalId)?.master) return;
    reg.off("event", onEvent);
    send("voice:autostart");
  };
  reg.on("event", onEvent);
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
    // The master session is not usable until its agent runs, so it comes up on
    // its own instead of waiting for the user to type the command by hand.
    if (terminal.master) autostartMasterAgent(terminal);
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
  // mix text in while they type. During shutdown the registry empties while the
  // renderer is still alive, so a trailing keystroke is dropped, not an error.
  ipcMain.handle("terminals:write", (_event, id: string, data: string) => {
    if (quitting) return;
    const terminal = reg.get(id);
    terminal.markUserInput();
    terminal.write(data);
  });

  ipcMain.handle("terminals:resize", (_event, id: string, cols: number, rows: number) => {
    if (quitting) return;
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
    voiceEnabled: voice?.enabled ?? false,
  }));

  ipcMain.handle("voice:set-enabled", async (_event, enabled: boolean) => {
    return (await voice?.setEnabled(enabled)) ?? false;
  });

  // Fire-and-forget: acking each chunk would be pure overhead at several
  // messages a second, and there is nothing useful to return.
  ipcMain.on("voice:audio-chunk", (_event, buffer: ArrayBuffer) => {
    voice?.pushAudio(new Int16Array(buffer));
  });

  // The renderer owns the audio clock, so this is the only accurate signal that
  // the speakers have gone quiet and the microphone can open again.
  ipcMain.on("speech:finished", () => {
    speech?.notifyPlaybackFinished();
  });
}

void app.whenReady().then(async () => {
  const stateDir = app.getPath("userData");

  // In development __dirname points at dist/main and resources live two levels
  // up. In a packaged application they are shipped as extraResources — outside
  // the asar, since the model files are opened by native code that needs real
  // paths on disk — and process.resourcesPath is where they land.
  const resourcesDir = app.isPackaged
    ? process.resourcesPath
    : path.join(__dirname, "..", "..", "resources");

  try {
    masterDir = await prepareMasterSession(stateDir, resourcesDir);
  } catch (error) {
    // Without the instructions directory the application is still usable; the
    // master session starts in the home directory and this is logged.
    console.error("could not prepare the master session directory:", error);
  }

  registry = new Registry(stateDir);
  await registry.init();
  notifier = new MasterNotifier(registry);

  // The master session tails this file; appending nothing creates it ahead of
  // the watcher without touching existing content.
  const voiceLog = path.join(stateDir, "voice.jsonl");
  try {
    await appendFile(voiceLog, "", "utf8");
  } catch (error) {
    console.error("could not create the voice channel file:", error);
  }

  const modelsDir = path.join(resourcesDir, "voice");
  voice = new VoiceController(voiceLog, modelsDir);
  voice.preload();
  speech = new SpeechController(modelsDir);
  speech.preload();
  registerIpc(registry);
  wireRegistry(registry);
  wireVoice(voice);
  wireSpeech(speech, voice);
  armVoiceAutostart(registry);

  // Access secret for the server, new on every start. It is only written to the
  // configuration of the master session's directory, so no other session or
  // process can use the tab tools.
  const token = randomBytes(16).toString("hex");

  // The server comes up before the window opens: the master tab is created when
  // the renderer loads, and its session reads the MCP configuration at startup.
  try {
    mcp = await startMcpServer(registry, speech, MCP_PORT, token);
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

// Whisper's Metal backend aborts the process at exit (a native assertion in
// its own cleanup code) unless its context is released first. That release
// is async, so quitting has to wait for it rather than fire-and-forget it:
// preventDefault holds the quit open until cleanup settles, then quits again.
let quitting = false;

app.on("before-quit", (event) => {
  if (quitting) return;
  event.preventDefault();
  quitting = true;
  void (async () => {
    registry?.disposeAll();
    await Promise.allSettled([mcp?.close(), voice?.dispose()]);
    app.quit();
  })();
});
