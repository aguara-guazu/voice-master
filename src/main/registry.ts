import { EventEmitter } from "node:events";
import { appendFile, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const TEMP_PREFIX = "voice-master-";

// Eventos que una sesión de agente emite como parte de su avance normal. No
// piden ninguna decisión y llegan por decenas mientras trabaja.
const AGENT_PROGRESS = new Set(["prompt_submit", "tool_complete", "post_tool_use"]);

function isAgentProgress(event: TerminalEvent): boolean {
  if (event.type !== "notification") return false;
  const payload = event.detail["payload"] as Record<string, unknown> | undefined;
  return typeof payload?.["event"] === "string" && AGENT_PROGRESS.has(payload["event"]);
}
import { Terminal } from "./terminal";
import type { TerminalEvent, TerminalOptions } from "./terminal";
import { CLI_AGENT_ENV, prepareShellIntegration } from "./shell-integration";

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

/**
 * Registro de terminales vivas y bus de eventos.
 *
 * Los eventos se escriben además a un archivo JSONL append-only: es el canal
 * que un proceso externo puede seguir sin mantener una conexión abierta contra
 * el servidor MCP, que solo responde a peticiones.
 */
export class Registry extends EventEmitter {
  private terminals = new Map<string, Terminal>();
  private counter = 0;
  private eventLog: string;
  private stateDir: string;
  private baseEnv: Record<string, string> = { ...CLI_AGENT_ENV };

  // El archivo de eventos se conserva entre arranques, pero los identificadores
  // de terminal se reinician. Sin este corte, una consulta devolvería eventos de
  // pestañas de sesiones anteriores que ya no existen.
  private startedAt: string;

  constructor(stateDir: string) {
    super();
    this.stateDir = stateDir;
    this.eventLog = path.join(stateDir, "events.jsonl");
    this.startedAt = new Date().toISOString();
  }

  /**
   * Prepara la integración de shell. Debe ejecutarse antes de crear terminales:
   * sin ella el estado se infiere del output y un comando lento y silencioso
   * pasa por inactivo.
   */
  async init(shell = process.env["SHELL"] ?? "/bin/zsh"): Promise<void> {
    const integration = await prepareShellIntegration(this.stateDir, shell);
    if (integration) {
      this.baseEnv = { ...this.baseEnv, ...integration.env };
    }
    await this.sweepOrphanTempDirs();
  }

  get eventLogPath(): string {
    return this.eventLog;
  }

  /** Hay una terminal maestra viva. */
  hasMaster(): boolean {
    return [...this.terminals.values()].some((t) => t.master);
  }

  /**
   * `allowMaster` distingue el origen: solo las terminales abiertas desde la
   * ventana pueden quedar marcadas como maestras. Mientras no exista ninguna, la
   * primera que se abra desde la interfaz lo será, de modo que cerrarla no deja
   * a la aplicación sin sesión maestra de forma permanente.
   */
  create(
    options: Omit<TerminalOptions, "id"> & { id?: string; allowMaster?: boolean },
  ): Terminal {
    const id = options.id ?? `t${++this.counter}`;
    if (this.terminals.has(id)) {
      throw new Error(`ya existe una terminal con id ${id}`);
    }

    const master = options.master ?? (options.allowMaster === true && !this.hasMaster());

    const terminal = new Terminal({
      ...options,
      id,
      master,
      env: { ...this.baseEnv, ...(options.env ?? {}) },
    });
    this.terminals.set(id, terminal);

    terminal.on("event", (payload: TerminalEvent) => {
      // La maestra no escribe en el bus: ahí corre la conversación con el agente
      // que vigila el archivo, y sus eventos de fin de turno arrastran consulta
      // y respuesta. Sí se emiten en memoria para que la interfaz pinte estado.
      if (!terminal.master) void this.record(payload);
      this.emit("event", payload);
    });

    terminal.on("data", (chunk: string) => {
      this.emit("data", id, chunk);
    });

    this.emit("created", this.summarize(terminal));
    return terminal;
  }

  get(id: string): Terminal {
    const terminal = this.terminals.get(id);
    if (!terminal) {
      throw new Error(`no existe la terminal ${id}`);
    }
    return terminal;
  }

  has(id: string): boolean {
    return this.terminals.has(id);
  }

  /** Devuelve la terminal o undefined, sin lanzar. */
  peek(id: string): Terminal | undefined {
    return this.terminals.get(id);
  }

  /** La terminal maestra viva, si existe. */
  master(): Terminal | undefined {
    return [...this.terminals.values()].find((t) => t.master);
  }

  /** Terminales expuestas al control externo. Excluye la maestra. */
  list(): TerminalSummary[] {
    return [...this.terminals.values()]
      .filter((t) => !t.master)
      .map((t) => this.summarize(t));
  }

  /** Todas las terminales, incluida la maestra. Solo para la interfaz. */
  listAll(): TerminalSummary[] {
    return [...this.terminals.values()].map((t) => this.summarize(t));
  }

  /**
   * Acceso restringido al control externo. Rechaza la terminal maestra por su
   * identificador: ocultarla del listado no alcanza, porque los identificadores
   * son correlativos y se adivinan al primer intento.
   */
  getControllable(id: string): Terminal {
    const terminal = this.get(id);
    if (terminal.master) {
      throw new Error(`la terminal ${id} es la sesión maestra y no admite control externo`);
    }
    return terminal;
  }

  /** Propaga a la interfaz un cambio de nombre o color, venga de donde venga. */
  notifyLabel(id: string): void {
    this.emit("label", this.summarize(this.get(id)));
  }

  /**
   * Crea un directorio temporal para una sesión que no debe dejar rastro. Se
   * elimina al cerrar la terminal.
   *
   * El nombre incluye el pid del proceso para poder distinguir, en un arranque
   * posterior, los directorios abandonados de los que pertenecen a otra
   * instancia en marcha.
   */
  async createTempDir(): Promise<string> {
    return mkdtemp(path.join(tmpdir(), `${TEMP_PREFIX}${process.pid}-`));
  }

  /**
   * Elimina directorios temporales de instancias que ya no existen.
   *
   * Ni macOS ni Windows garantizan el borrado del directorio temporal al apagar
   * el equipo: la limpieza del sistema es por antigüedad o por programación. Si
   * la aplicación termina de forma anormal, sus directorios quedan sin borrar y
   * nadie los reclama, de modo que conviene barrerlos al arrancar.
   *
   * Solo se borran aquellos cuyo pid ya no está vivo, para no interferir con otra
   * instancia en ejecución.
   */
  private async sweepOrphanTempDirs(): Promise<void> {
    const base = tmpdir();
    let entries: string[];
    try {
      entries = await readdir(base);
    } catch {
      return;
    }

    for (const entry of entries) {
      if (!entry.startsWith(TEMP_PREFIX)) continue;

      const pid = Number.parseInt(entry.slice(TEMP_PREFIX.length).split("-")[0] ?? "", 10);
      if (Number.isNaN(pid)) continue;

      // Señal 0: comprueba la existencia del proceso sin afectarlo. Solo ESRCH
      // significa que no existe; EPERM indica que está vivo y pertenece a otro
      // usuario, caso en el que su directorio no debe tocarse.
      let abandoned = false;
      try {
        process.kill(pid, 0);
      } catch (error) {
        abandoned = (error as NodeJS.ErrnoException).code === "ESRCH";
      }

      if (abandoned) await this.removeTempDir(path.join(base, entry));
    }
  }

  close(id: string): void {
    const terminal = this.get(id);
    const temp = terminal.temporaryDir;
    terminal.dispose();
    this.terminals.delete(id);
    this.emit("closed", id);
    if (temp) void this.removeTempDir(temp);
  }

  disposeAll(): void {
    for (const terminal of this.terminals.values()) {
      const temp = terminal.temporaryDir;
      terminal.dispose();
      if (temp) void this.removeTempDir(temp);
    }
    this.terminals.clear();
  }

  /**
   * Borra un directorio temporal creado por la aplicación. Comprueba el prefijo
   * antes de borrar: la ruta llega desde el estado de una terminal y un borrado
   * recursivo sobre un directorio del usuario sería irreversible.
   */
  private async removeTempDir(dir: string): Promise<void> {
    const expected = path.join(tmpdir(), TEMP_PREFIX);
    if (!dir.startsWith(expected)) {
      this.emit("log-error", new Error(`se omitió borrar un directorio ajeno: ${dir}`));
      return;
    }
    try {
      await rm(dir, { recursive: true, force: true });
    } catch (error) {
      this.emit("log-error", error);
    }
  }

  private summarize(terminal: Terminal): TerminalSummary {
    return {
      id: terminal.id,
      title: terminal.title,
      cwd: terminal.cwd,
      shell: terminal.shell,
      pid: terminal.pid,
      status: terminal.status,
      exitCode: terminal.exitCode,
      master: terminal.master,
      color: terminal.color,
    };
  }

  /**
   * Últimos eventos registrados, del más nuevo al más viejo. Se lee del archivo
   * y no de memoria para no mantener un historial creciendo sin límite en el
   * proceso; el archivo ya es el registro.
   *
   * Por omisión se descartan los eventos que no ameritan una decisión: los
   * `status` y las notificaciones de progreso de una sesión de agente. Una sesión
   * activa emite una notificación por cada llamada a herramienta, de modo que sin
   * este filtro una consulta de treinta eventos se llena de ruido y deja fuera lo
   * que había que ver.
   *
   * Pidiendo un tipo explícito en `types` se devuelve todo lo de ese tipo, sin el
   * filtro fino.
   */
  async recentEvents(limit: number, types?: string[]): Promise<TerminalEvent[]> {
    let raw: string;
    try {
      raw = await readFile(this.eventLog, "utf8");
    } catch {
      return [];
    }

    const wanted = types && types.length > 0 ? new Set(types) : null;
    const out: TerminalEvent[] = [];
    const lines = raw.split("\n");

    for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
      const line = lines[i];
      if (!line) continue;

      let event: TerminalEvent;
      try {
        event = JSON.parse(line) as TerminalEvent;
      } catch {
        continue;
      }

      if (event.at < this.startedAt) break;

      if (wanted) {
        if (!wanted.has(event.type)) continue;
      } else if (event.type === "status" || isAgentProgress(event)) {
        continue;
      }

      out.push(event);
    }

    return out;
  }

  /**
   * Espera a que ocurra un evento que amerite una decisión y lo devuelve. Si no
   * ocurre nada dentro del plazo, devuelve una lista vacía.
   *
   * Existe porque el protocolo no permite despertar a un cliente: una sesión que
   * quiera enterarse de algo tiene que preguntar. Bloqueando aquí, quien delega
   * una tarea puede quedarse esperando su final en una sola llamada, en lugar de
   * consultar en bucle.
   *
   * Los eventos de la terminal maestra no se reportan, igual que en el registro.
   */
  async waitForEvent(timeoutMs: number, types?: string[]): Promise<TerminalEvent[]> {
    const wanted = types && types.length > 0 ? new Set(types) : null;

    return new Promise((resolve) => {
      const finish = (result: TerminalEvent[]): void => {
        clearTimeout(timer);
        this.off("event", onEvent);
        resolve(result);
      };

      const onEvent = (payload: TerminalEvent): void => {
        const terminal = this.terminals.get(payload.terminalId);
        if (terminal?.master) return;

        if (wanted) {
          if (!wanted.has(payload.type)) return;
        } else if (payload.type === "status" || isAgentProgress(payload)) {
          return;
        }

        finish([payload]);
      };

      const timer = setTimeout(() => finish([]), timeoutMs);
      this.on("event", onEvent);
    });
  }

  private async record(payload: TerminalEvent): Promise<void> {
    try {
      await appendFile(this.eventLog, `${JSON.stringify(payload)}\n`, "utf8");
    } catch (error) {
      this.emit("log-error", error);
    }
  }
}
