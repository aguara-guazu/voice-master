import type { Server } from "node:http";
import { createMcpExpressApp } from "@modelcontextprotocol/express";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import * as z from "zod";
import type { Registry } from "./registry";
import type { SpeechController } from "./speech";

// The return type is left to inference: the SDK's result union discriminates on
// the "text" literal, which a hand-written annotation would widen to string.
function text(value: unknown) {
  const body = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return { content: [{ type: "text" as const, text: body }] };
}

function buildServer(registry: Registry, speech: SpeechController): McpServer {
  const server = new McpServer({ name: "voice-master", version: "0.1.0" });

  server.registerTool(
    "terminals_list",
    {
      description:
        "Lists open terminals with their id, title, directory and state. The 'waiting' state " +
        "means the terminal is expecting an interactive answer. Excludes the master session, " +
        "which is out of reach by design.",
      inputSchema: z.object({}),
    },
    async () => text(registry.list()),
  );

  server.registerTool(
    "terminal_read",
    {
      description:
        "Returns the last lines of a terminal, read from its screen buffer. Works the same on a " +
        "plain shell as on a full-screen application.",
      inputSchema: z.object({
        id: z.string().describe("Terminal identifier"),
        lines: z.number().int().min(1).max(2000).default(60),
      }),
    },
    async ({ id, lines }) => {
      const terminal = registry.getControllable(id);
      return text({
        id,
        status: terminal.status,
        cwd: terminal.cwd,
        lines: terminal.snapshot(lines),
      });
    },
  );

  server.registerTool(
    "terminal_open",
    {
      description:
        "Opens a new terminal and leaves it ready in a single call: directory, name, colour and " +
        "initial command. With 'cwd' it works on that directory; with 'temporary' set to true a " +
        "throwaway one is created and deleted when the tab closes. One of the two is required.\n\n" +
        "Use 'run' to start an agent (for example 'claude'): the shell is given time to become " +
        "ready before the command is written. Saves chaining terminal_label and terminal_write " +
        "after opening.",
      inputSchema: z.object({
        cwd: z.string().optional().describe("Working directory, absolute path"),
        temporary: z
          .boolean()
          .default(false)
          .describe("Creates a throwaway directory instead of using 'cwd'"),
        title: z.string().optional(),
        color: z
          .string()
          .regex(/^#[0-9a-fA-F]{6}$/)
          .optional()
          .describe("Identifying colour in #rrggbb form"),
        run: z
          .string()
          .optional()
          .describe("Command to run once the shell is ready, for example 'claude'"),
        shell: z.string().optional().describe("Shell to run; defaults to the user's"),
      }),
    },
    async ({ cwd, temporary, title, color, run, shell }) => {
      if (!temporary && !cwd) {
        throw new Error("either 'cwd' or 'temporary' set to true is required");
      }

      const dir = temporary ? await registry.createTempDir() : (cwd as string);
      const terminal = registry.create({
        cwd: dir,
        shell,
        title,
        temporaryDir: temporary ? dir : null,
      });
      if (color) terminal.setColor(color);
      registry.notifyLabel(terminal.id);

      let ran = false;
      if (run) {
        // Writing before the shell draws its prompt can lose the command, and
        // loading the user's profile takes an unpredictable amount of time.
        await terminal.waitForPrompt(8000);
        terminal.write(`${run}\r`);
        ran = true;
      }

      return text({
        id: terminal.id,
        cwd: terminal.cwd,
        pid: terminal.pid,
        temporary,
        title: terminal.title,
        color: terminal.color,
        ran,
      });
    },
  );

  server.registerTool(
    "terminal_write",
    {
      description:
        "Sends text to a terminal. Requires the user's prior confirmation: do not call on your " +
        "own initiative. With submit=true a newline is appended. To answer a selector, send the " +
        "arrow-key sequences in 'text'.",
      inputSchema: z.object({
        id: z.string(),
        text: z.string().describe("Text to write into the pty"),
        submit: z.boolean().default(false).describe("Appends \\r at the end"),
      }),
    },
    async ({ id, text: payload, submit }) => {
      const terminal = registry.getControllable(id);
      terminal.write(submit ? `${payload}\r` : payload);
      return text({ id, written: payload.length, submitted: submit });
    },
  );

  server.registerTool(
    "events_recent",
    {
      description:
        "Recent tab events, newest first. Types: 'task-finished' (a run of 15 s or more ended, " +
        "with duration and exit code), 'prompt' (a terminal is awaiting an answer), " +
        "'notification' (an application notified; agent sessions report their state here), " +
        "'exit' (the process died) and 'status'. This is how to find out what happened without " +
        "polling every terminal. Excludes the master session.\n\n" +
        "By default only what warrants a decision is returned: 'status' events and agent progress " +
        "notifications ('prompt_submit', 'tool_complete', 'post_tool_use') are left out, since " +
        "they arrive by the dozen while an agent works. To see those too, ask explicitly for " +
        "types: ['notification'].",
      inputSchema: z.object({
        limit: z.number().int().min(1).max(200).default(30),
        types: z
          .array(z.string())
          .optional()
          .describe("Types to include without the fine filter; if omitted, only actionable ones"),
      }),
    },
    async ({ limit, types }) => {
      const events = await registry.recentEvents(limit, types);
      return text({ count: events.length, events });
    },
  );

  server.registerTool(
    "events_wait",
    {
      description:
        "Blocks until something worth deciding on happens — a task finishing, an agent ending " +
        "its turn or asking for permission, a process dying — and returns it. If nothing happens " +
        "within the deadline it returns an empty list, and calling again is the way to go.\n\n" +
        "Use this after delegating a task, rather than polling 'events_recent' in a loop: the " +
        "call doesn't answer until there is news, so nothing is spent while the other agent " +
        "works. Excludes the master session.",
      inputSchema: z.object({
        timeout_seconds: z
          .number()
          .int()
          .min(1)
          .max(120)
          .default(60)
          .describe("How long to wait before returning empty"),
        types: z
          .array(z.string())
          .optional()
          .describe("Types to wait for; if omitted, any actionable event"),
      }),
    },
    async ({ timeout_seconds, types }) => {
      const events = await registry.waitForEvent(timeout_seconds * 1000, types);
      return text({
        timedOut: events.length === 0,
        count: events.length,
        events,
      });
    },
  );

  server.registerTool(
    "terminal_label",
    {
      description:
        "Changes a tab's name and/or colour. Meant for organising: marking the one that failed in " +
        "red, or renaming it after the task it runs. Both fields are optional; passing null " +
        "clears the colour. Does not reach the master session.",
      inputSchema: z.object({
        id: z.string(),
        title: z.string().optional().describe("Visible name; trimmed to 60 characters"),
        color: z
          .string()
          .regex(/^#[0-9a-fA-F]{6}$/)
          .nullable()
          .optional()
          .describe("Colour in #rrggbb form, or null to clear it"),
      }),
    },
    async ({ id, title, color }) => {
      const terminal = registry.getControllable(id);
      if (title !== undefined) terminal.setTitle(title);
      if (color !== undefined) terminal.setColor(color);
      registry.notifyLabel(id);
      return text({ id, title: terminal.title, color: terminal.color });
    },
  );

  server.registerTool(
    "terminal_close",
    {
      description: "Closes a terminal and ends its process.",
      inputSchema: z.object({ id: z.string() }),
    },
    async ({ id }) => {
      registry.getControllable(id);
      registry.close(id);
      return text({ id, closed: true });
    },
  );

  server.registerTool(
    "speak",
    {
      description:
        "Says something out loud through the application's speakers, in Spanish. This is how the " +
        "user hears you: the terminal is what they read, this is what they hear.\n\n" +
        "The text is spoken exactly as given — nothing is rewritten, expanded or cleaned up — so " +
        "it has to be written to be heard, not read. It is not your terminal answer passed along: " +
        "it is a shorter spoken version of it, and writing it is your job.\n\n" +
        "Leave out everything that only works in writing: file paths, line references, " +
        "identifiers, function calls, flags, URLs, backticks, bullets and headings. Say what they " +
        "mean instead. Write numbers as they are pronounced ('cero coma nueve', 'dos mil " +
        "veintiséis'), and expand or drop abbreviations.\n\n" +
        "The microphone is muted while this plays, so the user cannot interrupt and nothing they " +
        "say meanwhile is heard. Keep it to a few sentences.\n\n" +
        "The call returns once the audio has finished playing.",
      inputSchema: z.object({
        text: z
          .string()
          .min(1)
          .describe("What to say, written to be heard: no symbols, numbers spelled out"),
        speed: z
          .number()
          .min(0.5)
          .max(2)
          .optional()
          .describe("Speaking rate; below 1 is slower. Omit it: the default is set by ear"),
      }),
    },
    async ({ text: payload, speed }) => {
      const result = await speech.speak(payload, speed);
      return text({ spoken: true, characters: result.characters, seconds: Number(result.seconds.toFixed(2)) });
    },
  );

  return server;
}

export interface McpEndpoint {
  port: number;
  url: string;
  turnEndUrl: string;
  close: () => Promise<void>;
}

/**
 * Publishes the MCP server over HTTP on loopback.
 *
 * The handler takes a factory: one McpServer is built per request, so the tools
 * close over the shared registry and speech controller rather than over
 * per-instance state.
 */
export async function startMcpServer(
  registry: Registry,
  speech: SpeechController,
  port: number,
  token: string,
): Promise<McpEndpoint> {
  const handler = createMcpHandler(() => buildServer(registry, speech));
  const node = toNodeHandler(handler);

  const app = createMcpExpressApp();

  // The secret goes in the path rather than a header: there are open defects
  // where the client does not send the headers declared in `.mcp.json`, whereas
  // the URL always travels. Any other path does not exist, so knowing the port is
  // not enough to use the server.
  app.all(`/mcp/${token}`, (req, res) => void node(req, res, req.body));

  // Not an MCP tool: this is for the master session's Stop hook, which is a
  // shell command and cannot call one. It answers whether the session spoke
  // during the turn that is ending. Same secret in the path as the tools.
  app.post(`/turn-end/${token}`, (_req, res) => {
    res.json({ speak: speech.reportTurnEnd() });
  });

  const server: Server = await new Promise((resolve, reject) => {
    const instance = app.listen(port, "127.0.0.1", () => resolve(instance));
    instance.on("error", reject);
  });

  const address = server.address();
  const bound = typeof address === "object" && address !== null ? address.port : port;

  return {
    port: bound,
    url: `http://127.0.0.1:${bound}/mcp/${token}`,
    turnEndUrl: `http://127.0.0.1:${bound}/turn-end/${token}`,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
