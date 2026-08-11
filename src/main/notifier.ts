import type { Registry } from "./registry";
import type { Terminal, TerminalEvent } from "./terminal";

// Ventana en la que se agrupan los eventos antes de avisar: si varias pestañas
// cambian a la vez, se manda un solo mensaje en lugar de uno por evento.
const BATCH_MS = 1500;

// Silencio exigido tras la última tecla del usuario en la pestaña maestra. El
// aviso se escribe en su terminal, de modo que hacerlo mientras redacta algo le
// mezclaría el texto.
const USER_QUIET_MS = 4000;

// Reintento cuando la maestra está ocupada o el usuario acaba de escribir.
const RETRY_MS = 2000;

// Cota de eventos por mensaje: un aviso que enumera treinta cosas no se lee.
const MAX_LISTED = 6;

/**
 * Despierta a la sesión maestra escribiendo un aviso en su terminal.
 *
 * Sin esto la sesión maestra solo actúa cuando el usuario le habla: nada la
 * interrumpe cuando una pestaña termina o queda esperando una decisión, así que
 * no puede reaccionar a lo que ocurre en las demás.
 *
 * Es la aplicación la que escribe, no el servidor MCP. La sesión maestra sigue
 * sin poder alcanzarse a sí misma por sus herramientas: aquí no se le da control,
 * se le entrega información.
 */
export class MasterNotifier {
  private pending: TerminalEvent[] = [];
  private timer: NodeJS.Timeout | null = null;

  /**
   * Apagado por omisión. La sesión maestra puede seguir el registro de eventos
   * con un comando en segundo plano, mecanismo que cumple la misma función sin
   * escribir en su terminal ni arriesgar pisar lo que el usuario teclea. Esto
   * queda como respaldo para entornos donde eso no sea posible.
   */
  private enabled = false;

  constructor(private registry: Registry) {
    this.registry.on("event", (event: TerminalEvent) => this.consider(event));
  }

  setEnabled(value: boolean): void {
    this.enabled = value;
    if (!value) {
      this.pending = [];
      if (this.timer) clearTimeout(this.timer);
      this.timer = null;
    }
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  private consider(event: TerminalEvent): void {
    if (!this.enabled) return;
    if (!isActionable(event)) return;

    // Un evento de la propia maestra no se le reporta: es su propia actividad.
    const source = this.registry.peek(event.terminalId);
    if (!source || source.master) return;

    this.pending.push(event);
    if (!this.timer) {
      this.timer = setTimeout(() => this.flush(), BATCH_MS);
    }
  }

  private flush(): void {
    this.timer = null;
    if (this.pending.length === 0) return;

    const master = this.registry.master();
    if (!master) {
      this.pending = [];
      return;
    }

    // Sin una sesión de agente en la maestra no hay a quién avisar: el texto
    // caería en el intérprete de comandos, que intentaría ejecutarlo. Los eventos
    // se descartan en lugar de encolarse, porque nadie va a leerlos.
    if (!master.hasAgentSession) {
      this.pending = [];
      return;
    }

    // No interrumpir a la maestra mientras trabaja ni pisar lo que el usuario
    // esté escribiendo. En ambos casos se reintenta más tarde: el aviso puede
    // llegar con retraso, pero no debe corromper la sesión.
    if (master.status === "running" || master.msSinceUserInput() < USER_QUIET_MS) {
      this.timer = setTimeout(() => this.flush(), RETRY_MS);
      return;
    }

    const events = this.pending;
    this.pending = [];

    try {
      master.write(`${this.compose(events)}\r`);
    } catch {
      // La maestra pudo cerrarse entre la comprobación y la escritura.
    }
  }

  /**
   * Redacta el aviso. Va marcado como automático para que la sesión no lo
   * confunda con un mensaje del usuario, y describe qué pasó sin indicar qué
   * hacer: la decisión sigue siendo del usuario.
   */
  private compose(events: TerminalEvent[]): string {
    const lines = events.slice(0, MAX_LISTED).map((event) => describe(event));
    const extra = events.length - lines.length;
    if (extra > 0) lines.push(`y ${extra} evento(s) más`);

    return (
      `[aviso automático de voice-master] ${lines.join("; ")}. ` +
      "Consultá events_recent si necesitás el detalle. " +
      "Si esto amerita informar al usuario, hacelo; si no, no hace falta responder."
    );
  }
}

function isActionable(event: TerminalEvent): boolean {
  if (event.type === "task-finished" || event.type === "prompt" || event.type === "exit") {
    return true;
  }
  if (event.type !== "notification") return false;

  const payload = event.detail["payload"] as Record<string, unknown> | undefined;
  const kind = payload?.["event"];
  return (
    kind === "stop" ||
    kind === "stop_failure" ||
    kind === "idle_prompt" ||
    kind === "permission_request"
  );
}

function describe(event: TerminalEvent): string {
  const where = `${event.terminalId} "${event.title}"`;
  const detail = event.detail;

  switch (event.type) {
    case "task-finished": {
      const code = detail["exitCode"];
      const result = code === 0 || code === null ? "" : ` con código ${String(code)}`;
      return `${where} terminó una tarea de ${String(detail["seconds"])}s${result}`;
    }
    case "prompt":
      return `${where} parece esperar una respuesta`;
    case "exit":
      return `${where} terminó su proceso (código ${String(detail["code"])})`;
    default: {
      const payload = (detail["payload"] ?? {}) as Record<string, unknown>;
      const kind = String(payload["event"]);
      if (kind === "permission_request") {
        return `${where} pide permiso para usar ${String(payload["tool_name"])}`;
      }
      if (kind === "idle_prompt") return `${where} espera tu indicación`;
      if (kind === "stop_failure") return `${where} falló al terminar su turno`;
      return `${where} terminó su turno`;
    }
  }
}
