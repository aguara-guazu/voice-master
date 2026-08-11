import { EventEmitter } from "node:events";
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

// Silence after which the buffer is checked for a pending question. Below about
// 250 ms the normal output of a command triggers false positives.
const QUIET_MS = 450;

// Duration from which the end of a run counts as an event worth interrupting
// someone for. Below this threshold, finishing is expected and carries no news.
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
   * The master session's terminal. It stays out of the MCP server's reach and its
   * events are never written to the bus: this is where the agent orchestrating
   * the others runs, so exposing it would leave it acting on itself.
   */
  readonly master: boolean;

  /**
   * Throwaway directory created by the application for this terminal. Deleted on
   * close. `null` when the terminal works on a user directory, which is never
   * touched.
   */
  readonly temporaryDir: string | null;

  private proc: pty.IPty;
  private mirror: HeadlessTerminal;
  private quietTimer: NodeJS.Timeout | null = null;
  private lastPrompt: string | null = null;
  private runStartedAt: number | null = null;

  // Set on the first OSC 133 marker: from then on state comes from the shell and
  // is no longer inferred from output.
  private integrated = false;
  private commandActive = false;
  private lastExitCode: number | null = null;

  // The terminal received state events from a CLI agent. See handleNotification.
  private structuredSource = false;

  // Timestamp of the user's last keystroke. Starts at zero so an automatic notice
  // is not held back on a terminal nobody has touched yet.
  private lastUserInputAt = 0;

  // The shell has drawn a prompt at least once. See waitForPrompt().
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
    // The title is set in the constructor rather than afterwards: the creation
    // event must already carry the final name so the interface need not fix it.
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

    // The mirror consumes the same stream as the renderer, so screen state is
    // available in the main process without depending on the window.
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

    // Without shell markers, state can only be inferred from output. This is a
    // fallback: it cannot tell a slow silent command from an idle shell.
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

    // An agent reporting its own state is authoritative: from here the screen
    // heuristic is redundant and would only add false positives, because a TUI's
    // input box looks a lot like a pending question.
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

  /** JSON body of a CLI agent notification; null when it isn't one. */
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

    // With an agent reporting its state, the screen is not interpreted.
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
      // With shell markers, the move to idle is decided by the end of the
      // command. Silence alone does not mean it finished: a process can take
      // minutes without writing anything.
      if (!this.integrated && !this.commandActive) this.setStatus("idle");
      return;
    }

    this.setStatus("waiting");

    // The same question stays on screen while nobody answers, so it is reported
    // once per detected text.
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

    // The end of a task is marked by the shell with 133;D. Moving to "waiting"
    // while a command is still in flight only means that command is awaiting an
    // answer: the task has not finished and should not be announced.
    if (this.integrated && this.commandActive) return;

    // A run that lasted long enough is reported separately from the state change:
    // it is the signal that justifies notifying someone who isn't watching.
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

  /** Last `count` non-empty lines of the visible buffer plus scrollback. */
  tail(count: number): string[] {
    const lines = this.snapshot(count * 4);
    while (lines.length > 0 && (lines[lines.length - 1] ?? "").trim() === "") {
      lines.pop();
    }
    return lines.slice(-count);
  }

  /**
   * Reads the mirror's buffer.
   *
   * The end of the content is not `buffer.length`: that value includes the empty
   * rows of the viewport. In the normal buffer the content ends at the cursor
   * (`baseY + cursorY`). In the alternate buffer — a full-screen application —
   * the cursor moves all over the screen and there is content below it, so the
   * whole viewport is returned.
   */
  snapshot(lines: number): string[] {
    const buffer = this.mirror.buffer.active;
    const alternate = buffer.type === "alternate";
    const end = alternate
      ? buffer.length
      : Math.min(buffer.baseY + buffer.cursorY + 1, buffer.length);
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
      throw new Error(`terminal ${this.id} has already exited`);
    }
    this.proc.write(data);
  }

  /**
   * Waits for the shell to draw its first prompt, the point from which it accepts
   * commands. Resolves `false` on timeout, which happens with shells that emit no
   * markers; the caller then decides whether to write anyway.
   *
   * A fixed delay would not do: loading the user's profile can take considerably
   * longer than any reasonable wait.
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
   * Records that a write came from the user's keyboard. Lets anything writing
   * automatically wait until they stop typing.
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
   * Visible name of the tab. Whitespace is collapsed and the text trimmed: the
   * value can arrive from an external channel and is painted in the interface,
   * where a newline or a very long string would break the tab bar.
   */
  setTitle(title: string): void {
    const clean = title.replace(/\s+/g, " ").trim().slice(0, 60);
    if (clean.length === 0) {
      throw new Error("the name cannot be empty");
    }
    this._title = clean;
  }

  get color(): string | null {
    return this._color;
  }

  /**
   * The terminal has an agent session reporting its state. Inferred from having
   * received at least one structured notification.
   */
  get hasAgentSession(): boolean {
    return this.structuredSource;
  }

  /**
   * Identifying colour of the tab. Kept here rather than in the interface so it
   * survives a window reload. `null` restores the default look.
   *
   * Only six-digit hexadecimal notation is accepted: the value ends up
   * interpolated into a style, and restricting the format prevents injecting
   * arbitrary CSS from an external channel.
   */
  setColor(color: string | null): void {
    if (color !== null && !/^#[0-9a-fA-F]{6}$/.test(color)) {
      throw new Error(`invalid colour: ${color}. Expected #rrggbb or null`);
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
        // The process may have died between the check and the kill.
      }
    }
    this.mirror.dispose();
    this.removeAllListeners();
  }
}
