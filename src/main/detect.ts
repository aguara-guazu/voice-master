// Detection over the pty stream and over the screen buffer.
//
// Two independent mechanisms:
//   - scanOsc: OSC 9 / OSC 777 sequences in the raw stream. Emitted by any
//     application that notifies the terminal, the Claude Code plugin included.
//   - detectPrompt: a heuristic over the last lines of the rendered buffer. It
//     only makes sense to evaluate once the pty has been quiet for a while;
//     evaluating mid-write yields false positives on partial output.

export interface OscNotification {
  kind: "notify" | "generic";
  title: string;
  body: string;
  raw: string;
}

export type CommandMark = { kind: "start" } | { kind: "end"; exitCode: number | null };

export interface OscScan {
  notifications: OscNotification[];
  marks: CommandMark[];
}

// OSC opens with ESC ] and closes with BEL or ST (ESC \).
const OSC_PATTERN = /\x1b\](\d+);([\s\S]*?)(?:\x07|\x1b\\)/g;

export function scanOsc(chunk: string): OscScan {
  const notifications: OscNotification[] = [];
  const marks: CommandMark[] = [];
  OSC_PATTERN.lastIndex = 0;

  let match: RegExpExecArray | null;
  while ((match = OSC_PATTERN.exec(chunk)) !== null) {
    const code = match[1];
    const payload = match[2] ?? "";

    if (code === "777") {
      // Format: 777;notify;<title>;<body>. The body may be JSON and contain
      // semicolons, so only the first two fields are split off.
      const parts = payload.split(";");
      if (parts[0] !== "notify") continue;
      notifications.push({
        kind: "notify",
        title: parts[1] ?? "",
        body: parts.slice(2).join(";"),
        raw: payload,
      });
    } else if (code === "9") {
      notifications.push({ kind: "generic", title: "", body: payload, raw: payload });
    } else if (code === "133") {
      // A: prompt start, B: prompt end, C: command start, D[;code]: command end.
      // Only C and D delimit an execution.
      const [marker, value] = payload.split(";");
      if (marker === "C") {
        marks.push({ kind: "start" });
      } else if (marker === "D") {
        const parsed = Number.parseInt(value ?? "", 10);
        marks.push({ kind: "end", exitCode: Number.isNaN(parsed) ? null : parsed });
      } else if (marker === "A") {
        // The prompt is being drawn again: no command in flight. It carries no
        // exit code, so it is reported as unknown rather than as zero.
        marks.push({ kind: "end", exitCode: null });
      }
    }
  }

  return { notifications, marks };
}

export interface PromptDetection {
  matched: string;
  line: string;
  confidence: "high" | "medium";
}

// Explicit confirmations and selectors from the most common CLIs.
const HIGH_CONFIDENCE: RegExp[] = [
  /\[y\/n\]/i,
  /\(y\/n\)/i,
  /\[yes\/no\]/i,
  /\by\/n\b/i,
  /\?\s*$/,
  /:\s*$/,
  /›\s*$/,
  /\bpress\s+(enter|any key)\b/i,
  /\bcontinue\?\s*$/i,
  /\boverwrite\?/i,
  /\bare you sure\b/i,
  /\bdo you want to\b/i,
  /\bproceed\b.*\?/i,
  /\bpassword\b\s*:?\s*$/i,
  /\bpassphrase\b/i,
];

// Navigable option lists: the cursor marks the active row.
const MEDIUM_CONFIDENCE: RegExp[] = [
  /^\s*[❯>»]\s+\S/,
  /^\s*\d+[.)]\s+\S/,
  /\(use arrow keys\)/i,
  /\[\s*\]\s+\S/,
];

/**
 * Evaluates the last visible lines of the buffer. `tail` is expected to arrive
 * already trimmed, with no blank lines at the end.
 *
 * Returns null when no line matches. A medium-confidence result should not fire
 * on its own: confirm it against sustained inactivity.
 */
export function detectPrompt(tail: string[]): PromptDetection | null {
  if (tail.length === 0) return null;

  const last = tail[tail.length - 1] ?? "";
  const trimmed = last.trimEnd();

  for (const pattern of HIGH_CONFIDENCE) {
    if (pattern.test(trimmed)) {
      return { matched: pattern.source, line: trimmed, confidence: "high" };
    }
  }

  // A selector rarely sits on the very last line, so the preceding ones are checked.
  for (const line of tail.slice(-6)) {
    for (const pattern of MEDIUM_CONFIDENCE) {
      if (pattern.test(line)) {
        return { matched: pattern.source, line: line.trimEnd(), confidence: "medium" };
      }
    }
  }

  return null;
}

// An idle shell prompt is not a pending question. It is discarded before
// evaluating so that inactivity does not report it as awaiting an answer.
const SHELL_PROMPT = /(^|\s)[%$#❯➜]\s*$/;

export function looksLikeShellPrompt(line: string): boolean {
  return SHELL_PROMPT.test(line.trimEnd());
}
