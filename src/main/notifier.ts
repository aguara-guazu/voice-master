import type { Registry } from "./registry";
import type { TerminalEvent } from "./terminal";

// Window over which events are grouped before notifying: if several tabs change
// at once, a single message goes out instead of one per event.
const BATCH_MS = 1500;

// Silence required after the user's last keystroke in the master tab. The notice
// is written into its terminal, so doing it while they are composing something
// would mangle their text.
const USER_QUIET_MS = 4000;

// The status must have settled this long before writing: right at the end of a
// turn the TUI is still redrawing and swallows text written into it.
const STATUS_SETTLE_MS = 1500;

// Retry delay when the master is busy or the user has just typed.
const RETRY_MS = 2000;

// Cap on events per message: a notice listing thirty things does not get read.
const MAX_LISTED = 6;

/**
 * Wakes the master session by writing a notice into its terminal.
 *
 * Without this the master session only acts when the user speaks to it: nothing
 * interrupts it when a tab finishes or is left awaiting a decision, so it cannot
 * react to what happens in the others.
 *
 * It is the application that writes, not the MCP server. The master session still
 * cannot reach itself through its tools: this hands it information, not control.
 */
export class MasterNotifier {
  private pending: TerminalEvent[] = [];
  private timer: NodeJS.Timeout | null = null;

  /**
   * Off by default. The master session can follow the event log with a background
   * command, which serves the same purpose without writing into its terminal or
   * risking clobbering what the user types. This remains as a fallback for
   * environments where that is not possible.
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

    // An event from the master itself is not reported back to it: that is its own
    // activity.
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

    // With no agent session in the master there is nobody to notify: the text
    // would land in the command interpreter, which would try to run it. Events are
    // dropped rather than queued, because nobody is going to read them.
    if (!master.hasAgentSession) {
      this.pending = [];
      return;
    }

    // Do not interrupt the master while it works, nor clobber what the user is
    // typing. Both cases retry later: a notice may arrive late, but it must not
    // corrupt the session.
    if (
      master.status === "running" ||
      master.msSinceStatusChange() < STATUS_SETTLE_MS ||
      master.msSinceUserInput() < USER_QUIET_MS
    ) {
      this.timer = setTimeout(() => this.flush(), RETRY_MS);
      return;
    }

    const events = this.pending;
    this.pending = [];

    try {
      master.write(`${this.compose(events)}\r`);
    } catch {
      // The master may have closed between the check and the write.
    }
  }

  /**
   * Writes the notice. It is marked as automatic so the session does not mistake
   * it for a message from the user, and it describes what happened without saying
   * what to do: the decision remains the user's.
   */
  private compose(events: TerminalEvent[]): string {
    const lines = events.slice(0, MAX_LISTED).map((event) => describe(event));
    const extra = events.length - lines.length;
    if (extra > 0) lines.push(`and ${extra} more event(s)`);

    return (
      `[voice-master automatic notice] ${lines.join("; ")}. ` +
      "Check events_recent if you need the detail. " +
      "If this is worth telling the user, do so; otherwise no reply is needed."
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
      const result = code === 0 || code === null ? "" : ` with exit code ${String(code)}`;
      return `${where} finished a ${String(detail["seconds"])}s task${result}`;
    }
    case "prompt":
      return `${where} appears to be awaiting an answer`;
    case "exit":
      return `${where} ended its process (code ${String(detail["code"])})`;
    default: {
      const payload = (detail["payload"] ?? {}) as Record<string, unknown>;
      const kind = String(payload["event"]);
      if (kind === "permission_request") {
        return `${where} asks permission to use ${String(payload["tool_name"])}`;
      }
      if (kind === "idle_prompt") return `${where} is waiting for your input`;
      if (kind === "stop_failure") return `${where} failed to finish its turn`;
      return `${where} finished its turn`;
    }
  }
}
