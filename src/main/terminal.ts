import { EventEmitter } from "node:events";
import os from "node:os";
import * as pty from "node-pty";
import { Terminal as HeadlessTerminal } from "@xterm/headless";
import { detectPrompt, looksLikeShellPrompt, scanOsc } from "./detect";
import type { OscNotification, PromptDetection } from "./detect";
import { sanitizeEnv } from "./shell-integration";

export type TerminalStatus = "running" | "idle" | "waiting" | "exited";

export interface TerminalEvent {
  type: "notification" | "prompt" | "status" | "exit" | "task-finished";
  terminalId: string;
  title: string;
  cwd: string;
  at: string;
  detail: Record<string, unknown>;
}

export interface TerminalOptions {
  id: string;
  cwd: string;
  shell?: string;
  args?: string[];
  cols?: number;
  rows?: number;
  scrollback?: number;
  env?: Record<string, string>;
  master?: boolean;
  temporaryDir?: string | null;
  title?: string;
}

// Silencio tras el cual se evalúa el buffer en busca de una pregunta pendiente.
// Por debajo de ~250ms el output normal de un comando dispara falsos positivos.
const QUIET_MS = 450;

// Duración a partir de la cual el fin de una ejecución se considera un evento
// que vale interrumpir a alguien. Por debajo de este umbral, terminar es lo
// esperable y no aporta información.
const LONG_TASK_MS = 15_000;

export declare interface Terminal {
  on(event: "data", listener: (chunk: string) => void): this;
  on(event: "event", listener: (payload: TerminalEvent) => void): this;
  on(event: "exit", listener: (code: number) => void): this;
  on(event: "prompt-ready", listener: () => void): this;
  once(event: "prompt-ready", listener: () => void): this;
  off(event: "prompt-ready", listener: () => void): this;
}

export class Terminal extends EventEmitter {
  readonly id: string;
  readonly cwd: string;
  readonly shell: string;

  /**
   * Terminal de la sesión maestra. Queda fuera del alcance del servidor MCP y
   * sus eventos no se escriben en el bus: es donde corre el agente que orquesta
   * a las demás, de modo que exponerla lo dejaría actuando sobre sí mismo.
   */
  readonly master: boolean;

  /**
   * Directorio temporal creado por la aplicación para esta terminal. Se elimina
   * al cerrarla. `null` cuando la terminal trabaja sobre un directorio del
   * usuario, que nunca se toca.
   */
  readonly temporaryDir: string | null;

  private proc: pty.IPty;
  private mirror: HeadlessTerminal;
  private quietTimer: NodeJS.Timeout | null = null;
  private lastPrompt: string | null = null;
  private runStartedAt: number | null = null;

  // Se activa al recibir el primer marcador OSC 133: a partir de ahí el estado
  // proviene del shell y deja de inferirse del output.
  private integrated = false;
  private commandActive = false;
  private lastExitCode: number | null = null;

  // La terminal recibió eventos de estado de un agente CLI. Ver handleNotification.
  private structuredSource = false;

  // Momento de la última tecla del usuario. Arranca en cero para no bloquear un
  // aviso automático en una terminal con la que nadie interactuó todavía.
  private lastUserInputAt = 0;

  // El shell ya dibujó un prompt al menos una vez. Ver waitForPrompt().
  private promptSeen = false;

  private _status: TerminalStatus = "idle";
  private _title: string;
  private _exitCode: number | null = null;
  private _color: string | null = null;

  constructor(options: TerminalOptions) {
    super();

    this.id = options.id;
    this.cwd = options.cwd;
    this.master = options.master ?? false;
    this.temporaryDir = options.temporaryDir ?? null;
    this.shell = options.shell ?? process.env.SHELL ?? "/bin/zsh";
    // El título se fija en el constructor y no despues: el evento de creación
    // debe llevar ya el nombre definitivo para que la interfaz no lo corrija.
    this._title = options.title ?? options.cwd.split("/").filter(Boolean).pop() ?? this.shell;

    const cols = options.cols ?? 120;
    const rows = options.rows ?? 32;

    this.proc = pty.spawn(this.shell, options.args ?? ["-l"], {
      name: "xterm-256color",
      cols,
      rows,
      cwd: options.cwd,
      env: {
        ...sanitizeEnv(process.env),
        TERM: "xterm-256color",
        ...(options.env ?? {}),
      },
    });

    // El espejo consume el mismo stream que el renderer, de modo que el estado
    // de pantalla queda disponible en el proceso main sin depender de la ventana.
    this.mirror = new HeadlessTerminal({
      cols,
      rows,
      allowProposedApi: true,
      scrollback: options.scrollback ?? 5000,
    });

    this.proc.onData((chunk) => this.ingest(chunk));
    this.proc.onExit(({ exitCode }) => this.handleExit(exitCode));
  }

  get status(): TerminalStatus {
    return this._status;
  }

  get title(): string {
    return this._title;
  }

  get exitCode(): number | null {
    return this._exitCode;
  }

  get pid(): number {
    return this.proc.pid;
  }

  private ingest(chunk: string): void {
    this.mirror.write(chunk);
    this.emit("data", chunk);

    const { notifications, marks } = scanOsc(chunk);

    for (const notification of notifications) {
      this.handleNotification(notification);
    }

    if (marks.length > 0) this.integrated = true;

    for (const mark of marks) {
      if (mark.kind === "start") {
        this.commandActive = true;
        this.setStatus("running");
      } else {
        this.commandActive = false;
        this.lastExitCode = mark.exitCode;
        this.lastPrompt = null;
        this.setStatus("idle");

        if (!this.promptSeen) {
          this.promptSeen = true;
          this.emit("prompt-ready");
        }
      }
    }

    // Sin marcadores del shell el estado solo puede inferirse del output. Es un
    // respaldo: no distingue un comando lento y silencioso de una shell ociosa.
    if (!this.integrated && marks.length === 0) {
      this.setStatus("running");
    }

    this.scheduleQuietCheck();
  }

  private handleNotification(notification: OscNotification): void {
    const payload = this.parseAgentPayload(notification);

    this.emitEvent("notification", {
      kind: notification.kind,
      title: notification.title,
      body: notification.body,
      ...(payload ? { agentEvent: payload["event"], payload } : {}),
    });

    if (!payload) return;

    // Un agente que informa su propio estado es autoritativo: a partir de aquí
    // la heurística de pantalla sobra y solo aportaría falsos positivos, porque
    // el cuadro de entrada de una TUI se parece a una pregunta pendiente.
    this.structuredSource = true;

    switch (payload["event"]) {
      case "prompt_submit":
      case "post_tool_use":
        this.setStatus("running");
        break;
      case "idle_prompt":
      case "permission_request":
        this.setStatus("waiting");
        break;
      case "stop":
      case "stop_failure":
        this.setStatus("idle");
        break;
    }
  }

  /** Cuerpo JSON de una notificación de agente CLI; null si no lo es. */
  private parseAgentPayload(notification: OscNotification): Record<string, unknown> | null {
    if (!notification.title.startsWith("warp://cli-agent")) return null;
    try {
      const parsed: unknown = JSON.parse(notification.body);
      return typeof parsed === "object" && parsed !== null
        ? (parsed as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  }

  private scheduleQuietCheck(): void {
    if (this.quietTimer) clearTimeout(this.quietTimer);
    this.quietTimer = setTimeout(() => this.onQuiet(), QUIET_MS);
  }

  private onQuiet(): void {
    this.quietTimer = null;
    if (this._status === "exited") return;

    // Con un agente informando su estado, la pantalla no se interpreta.
    if (this.structuredSource) return;

    const tail = this.tail(8);
    const last = tail[tail.length - 1] ?? "";

    if (looksLikeShellPrompt(last)) {
      this.lastPrompt = null;
      if (!this.commandActive) this.setStatus("idle");
      return;
    }

    const detection = detectPrompt(tail);
    if (!detection) {
      // Con marcadores del shell, el paso a idle lo decide el fin del comando.
      // El silencio por sí solo no significa que haya terminado: un proceso
      // puede tardar minutos sin escribir nada.
      if (!this.integrated && !this.commandActive) this.setStatus("idle");
      return;
    }

    this.setStatus("waiting");

    // La misma pregunta permanece en pantalla mientras nadie responde; se
    // notifica una sola vez por texto detectado.
    if (this.lastPrompt === detection.line) return;
    this.lastPrompt = detection.line;
    this.emitPrompt(detection);
  }

  private emitPrompt(detection: PromptDetection): void {
    this.emitEvent("prompt", {
      line: detection.line,
      confidence: detection.confidence,
      matched: detection.matched,
      context: this.tail(6),
    });
  }

  private setStatus(next: TerminalStatus): void {
    if (this._status === next) return;

    const previous = this._status;
    this._status = next;
    this.emitEvent("status", { status: next });

    if (next === "running") {
      this.runStartedAt = Date.now();
      return;
    }

    if (previous !== "running" || this.runStartedAt === null) return;

    // El fin de una tarea lo marca el shell con 133;D. Pasar a "waiting" con un
    // comando todavía en curso solo significa que ese comando espera una
    // respuesta: la tarea no terminó y no corresponde anunciarla.
    if (this.integrated && this.commandActive) return;

    // Una ejecución que duró lo suficiente se reporta aparte del cambio de
    // estado: es la señal que justifica avisar a alguien que no está mirando.
    const runMs = Date.now() - this.runStartedAt;
    this.runStartedAt = null;
    if (runMs < LONG_TASK_MS) return;

    this.emitEvent("task-finished", {
      runMs,
      seconds: Math.round(runMs / 1000),
      outcome: next,
      exitCode: this.lastExitCode,
      tail: this.tail(6),
    });
  }

  private handleExit(code: number): void {
    if (this.quietTimer) clearTimeout(this.quietTimer);
    this.quietTimer = null;
    this._exitCode = code;
    this._status = "exited";
    this.emitEvent("exit", { code });
    this.emit("exit", code);
  }

  private emitEvent(type: TerminalEvent["type"], detail: Record<string, unknown>): void {
    const payload: TerminalEvent = {
      type,
      terminalId: this.id,
      title: this._title,
      cwd: this.cwd,
      at: new Date().toISOString(),
      detail,
    };
    this.emit("event", payload);
  }

  /** Últimas `count` líneas no vacías del buffer visible más scrollback. */
  tail(count: number): string[] {
    const lines = this.snapshot(count * 4);
    while (lines.length > 0 && (lines[lines.length - 1] ?? "").trim() === "") {
      lines.pop();
    }
    return lines.slice(-count);
  }

  /**
   * Lee el buffer del espejo.
   *
   * El final del contenido no es `buffer.length`: ese valor incluye las filas
   * vacías del viewport. En el buffer normal el contenido termina en el cursor
   * (`baseY + cursorY`). En el buffer alternativo —una aplicación de pantalla
   * completa— el cursor se mueve por toda la pantalla y hay contenido por
   * debajo, así que se devuelve el viewport completo.
   */
  snapshot(lines: number): string[] {
    const buffer = this.mirror.buffer.active;
    const alternate = buffer.type === "alternate";
    const end = alternate ? buffer.length : Math.min(buffer.baseY + buffer.cursorY + 1, buffer.length);
    const from = Math.max(0, end - lines);
    const out: string[] = [];

    for (let i = from; i < end; i++) {
      const line = buffer.getLine(i);
      out.push(line ? line.translateToString(true) : "");
    }

    return out;
  }

  write(data: string): void {
    if (this._status === "exited") {
      throw new Error(`la terminal ${this.id} ya terminó`);
    }
    this.proc.write(data);
  }

  /**
   * Espera a que el shell dibuje su primer prompt, momento a partir del cual
   * acepta órdenes. Resuelve `false` si vence el plazo, lo que ocurre con shells
   * que no emiten marcadores; en ese caso quien llama decide si escribir igual.
   *
   * Un retraso fijo no serviría: la carga del perfil del usuario puede tardar
   * bastante más que cualquier valor razonable de espera.
   */
  waitForPrompt(timeoutMs: number): Promise<boolean> {
    if (this.promptSeen) return Promise.resolve(true);

    return new Promise((resolve) => {
      const finish = (value: boolean): void => {
        clearTimeout(timer);
        this.off("prompt-ready", onReady);
        resolve(value);
      };
      const onReady = (): void => finish(true);
      const timer = setTimeout(() => finish(false), timeoutMs);
      this.once("prompt-ready", onReady);
    });
  }

  /**
   * Registra que la escritura vino del teclado del usuario. Permite a quien
   * quiera escribir de forma automática esperar a que deje de teclear.
   */
  markUserInput(): void {
    this.lastUserInputAt = Date.now();
  }

  msSinceUserInput(): number {
    return Date.now() - this.lastUserInputAt;
  }

  resize(cols: number, rows: number): void {
    if (this._status === "exited") return;
    this.proc.resize(cols, rows);
    this.mirror.resize(cols, rows);
  }

  /**
   * Nombre visible de la pestaña. Se normalizan los espacios y se recorta: el
   * valor puede venir de un canal externo y se pinta en la interfaz, donde un
   * salto de línea o un texto muy largo romperían la barra de pestañas.
   */
  setTitle(title: string): void {
    const clean = title.replace(/\s+/g, " ").trim().slice(0, 60);
    if (clean.length === 0) {
      throw new Error("el nombre no puede quedar vacío");
    }
    this._title = clean;
  }

  get color(): string | null {
    return this._color;
  }

  /**
   * La terminal tiene una sesión de agente que informa su estado. Se deduce de
   * haber recibido al menos una notificación estructurada.
   */
  get hasAgentSession(): boolean {
    return this.structuredSource;
  }

  /**
   * Color de identificación de la pestaña. Se guarda aquí y no en la interfaz
   * para que sobreviva a un recargado de la ventana. `null` la devuelve al
   * aspecto por defecto.
   *
   * Se acepta únicamente notación hexadecimal de seis dígitos: el valor termina
   * interpolado en un estilo, y restringir el formato evita inyectar CSS
   * arbitrario desde un canal externo.
   */
  setColor(color: string | null): void {
    if (color !== null && !/^#[0-9a-fA-F]{6}$/.test(color)) {
      throw new Error(`color inválido: ${color}. Se espera #rrggbb o null`);
    }
    this._color = color;
  }

  dispose(): void {
    if (this.quietTimer) clearTimeout(this.quietTimer);
    this.quietTimer = null;
    if (this._status !== "exited") {
      try {
        this.proc.kill();
      } catch {
        // El proceso puede haber muerto entre la comprobación y el kill.
      }
    }
    this.mirror.dispose();
    this.removeAllListeners();
  }
}
