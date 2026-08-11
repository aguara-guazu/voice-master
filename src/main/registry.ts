import { EventEmitter } from "node:events";
import { appendFile, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Terminal } from "./terminal";
import type { TerminalEvent, TerminalOptions } from "./terminal";
import { CLI_AGENT_ENV, prepareShellIntegration } from "./shell-integration";

const TEMP_PREFIX = "voice-master-";

// Events an agent session emits as part of its normal progress. None of them
// calls for a decision and they arrive by the dozen while it works.
const AGENT_PROGRESS = new Set(["prompt_submit", "tool_complete", "post_tool_use"]);

function isAgentProgress(event: TerminalEvent): boolean {
  if (event.type !== "notification") return false;
  const payload = event.detail["payload"] as Record<string, unknown> | undefined;
  return typeof payload?.["event"] === "string" && AGENT_PROGRESS.has(payload["event"]);
}

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
 * Registry of live terminals and event bus.
 *
 * Events are also written to an append-only JSONL file: that is the channel an
 * external process can follow without holding a connection open against the MCP
 * server, which only answers requests.
 */
export class Registry extends EventEmitter {
  private terminals = new Map<string, Terminal>();
  private counter = 0;
  private eventLog: string;
  private stateDir: string;
  private baseEnv: Record<string, string> = { ...CLI_AGENT_ENV };

  // The event file is kept across runs, but terminal identifiers restart. Without
  // this cut-off a query would return events from tabs of previous sessions that
  // no longer exist.
  private startedAt: string;

  constructor(stateDir: string) {
    super();
    this.stateDir = stateDir;
    this.eventLog = path.join(stateDir, "events.jsonl");
    this.startedAt = new Date().toISOString();
  }

  /**
   * Prepares shell integration. Must run before creating terminals: without it
   * state is inferred from output and a slow, silent command passes for idle.
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

  /** Whether a live master terminal exists. */
  hasMaster(): boolean {
    return [...this.terminals.values()].some((t) => t.master);
  }

  /**
   * `allowMaster` distinguishes the origin: only terminals opened from the window
   * can end up marked as master. While none exists, the next one opened from the
   * interface becomes it, so closing it does not leave the application without a
   * master session for good.
   */
  create(options: Omit<TerminalOptions, "id"> & { id?: string; allowMaster?: boolean }): Terminal {
    const id = options.id ?? `t${++this.counter}`;
    if (this.terminals.has(id)) {
      throw new Error(`a terminal with id ${id} already exists`);
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
      // The master does not write to the bus: that is where the conversation with
      // the agent watching this file happens, and its end-of-turn events carry the
      // query and the answer. They are still emitted in memory so the interface
      // can paint state.
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
      throw new Error(`terminal ${id} does not exist`);
    }
    return terminal;
  }

  has(id: string): boolean {
    return this.terminals.has(id);
  }

  /** Returns the terminal or undefined, without throwing. */
  peek(id: string): Terminal | undefined {
    return this.terminals.get(id);
  }

  /** The live master terminal, if any. */
  master(): Terminal | undefined {
    return [...this.terminals.values()].find((t) => t.master);
  }

  /** Terminals exposed to external control. Excludes the master. */
  list(): TerminalSummary[] {
    return [...this.terminals.values()].filter((t) => !t.master).map((t) => this.summarize(t));
  }

  /** Every terminal, master included. For the interface only. */
  listAll(): TerminalSummary[] {
    return [...this.terminals.values()].map((t) => this.summarize(t));
  }

  /**
   * Access restricted to external control. Rejects the master terminal by its
   * identifier: hiding it from the listing is not enough, because identifiers are
   * sequential and guessed on the first try.
   */
  getControllable(id: string): Terminal {
    const terminal = this.get(id);
    if (terminal.master) {
      throw new Error(`terminal ${id} is the master session and takes no external control`);
    }
    return terminal;
  }

  /** Propagates a name or colour change to the interface, wherever it came from. */
  notifyLabel(id: string): void {
    this.emit("label", this.summarize(this.get(id)));
  }

  /**
   * Creates a throwaway directory for a session that should leave no trace. It is
   * deleted when the terminal closes.
   *
   * The name includes the process pid so that, on a later run, abandoned
   * directories can be told apart from those belonging to another live instance.
   */
  async createTempDir(): Promise<string> {
    return mkdtemp(path.join(tmpdir(), `${TEMP_PREFIX}${process.pid}-`));
  }

  /**
   * Removes throwaway directories from instances that no longer exist.
   *
   * Neither macOS nor Windows guarantees clearing the temp directory on shutdown:
   * system cleanup runs by age or on a schedule. If the application terminates
   * abnormally its directories are left behind and nobody claims them, so they are
   * swept at startup.
   *
   * Only those whose pid is no longer alive are removed, so another running
   * instance is left alone.
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

      // Signal 0 checks the process exists without affecting it. Only ESRCH means
      // it does not; EPERM means it is alive and owned by another user, in which
      // case its directory must not be touched.
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
   * Deletes a throwaway directory created by the application. The prefix is
   * checked first: the path comes from a terminal's state and a recursive delete
   * over a user directory would be irreversible.
   */
  private async removeTempDir(dir: string): Promise<void> {
    const expected = path.join(tmpdir(), TEMP_PREFIX);
    if (!dir.startsWith(expected)) {
      this.emit("log-error", new Error(`skipped deleting a foreign directory: ${dir}`));
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
   * Most recent events, newest first. Read from the file rather than from memory
   * so no ever-growing history is kept in the process; the file is already the
   * record.
   *
   * By default, events that do not warrant a decision are dropped: `status` ones
   * and progress notifications from an agent session. An active session emits one
   * notification per tool call, so without this filter a thirty-event query fills
   * with noise and leaves out what needed to be seen.
   *
   * Asking for an explicit type in `types` returns everything of that type,
   * without the fine filter.
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
   * Waits for an event worth deciding on and returns it. If nothing happens
   * within the deadline, returns an empty list.
   *
   * It exists because the protocol cannot wake a client: a session that wants to
   * learn about something has to ask. By blocking here, whoever delegates a task
   * can wait for its end in a single call instead of polling.
   *
   * Master terminal events are not reported, as in the record.
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
