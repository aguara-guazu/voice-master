import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * Installs the master session's working directory and returns its path.
 *
 * The instruction files are copied from the application's resources on every
 * start, overwriting whatever was there: they are part of the program, not the
 * user's material, and a stale copy would leave the master session working from
 * rules that no longer match the available tools.
 *
 * It is installed under the data directory rather than inside the application so
 * the master session works on a stable, writable path.
 */
export async function prepareMasterSession(stateDir: string, appDir: string): Promise<string> {
  const target = path.join(stateDir, "master-session");
  const source = path.join(appDir, "resources", "master-session");

  await mkdir(target, { recursive: true });
  await cp(source, target, { recursive: true, force: true });

  // The log paths depend on the platform and the user, so the instructions
  // carry them as placeholders resolved at install time.
  const instructions = path.join(target, "AGENTS.md");
  const eventLog = path.join(stateDir, "events.jsonl");
  const voiceLog = path.join(stateDir, "voice.jsonl");
  const text = await readFile(instructions, "utf8");
  await writeFile(
    instructions,
    text.replaceAll("{{EVENT_LOG}}", eventLog).replaceAll("{{VOICE_LOG}}", voiceLog),
    "utf8",
  );

  return target;
}

/**
 * Declares the MCP server in the master session's directory.
 *
 * Without this the session reads instructions describing tools it does not have.
 * The effective URL is written rather than a fixed one because the port is
 * configurable and may resolve to another if the intended one is taken.
 *
 * Must run before the master tab opens: the file is read when the session starts,
 * not during it.
 */
export async function writeMcpConfig(masterDir: string, url: string): Promise<void> {
  const config = {
    mcpServers: {
      "voice-master": {
        type: "http",
        url,
      },
    },
  };

  await writeFile(path.join(masterDir, ".mcp.json"), `${JSON.stringify(config, null, 2)}\n`, "utf8");

  // Project permissions so the master session has the tools without manual
  // approvals. They apply to this directory only: no other session inherits them.
  const settings = {
    enableAllProjectMcpServers: true,
    permissions: {
      allow: ["mcp__voice-master"],
    },
  };

  const settingsDir = path.join(masterDir, ".claude");
  await mkdir(settingsDir, { recursive: true });
  await writeFile(
    path.join(settingsDir, "settings.json"),
    `${JSON.stringify(settings, null, 2)}\n`,
    "utf8",
  );
}
