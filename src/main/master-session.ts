import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * Instala el directorio de trabajo de la sesión maestra y devuelve su ruta.
 *
 * Los archivos de instrucciones se copian desde los recursos de la aplicación en
 * cada arranque, sobrescribiendo lo que hubiera: son parte del programa, no
 * material del usuario, y una copia vieja dejaría a la sesión maestra operando
 * con reglas que ya no corresponden a las herramientas disponibles.
 *
 * Se instala en el directorio de datos y no dentro de la aplicación para que la
 * sesión maestra trabaje sobre una ruta estable y escribible.
 */
export async function prepareMasterSession(stateDir: string, appDir: string): Promise<string> {
  const target = path.join(stateDir, "master-session");
  const source = path.join(appDir, "resources", "master-session");

  await mkdir(target, { recursive: true });
  await cp(source, target, { recursive: true, force: true });

  // La ruta del registro de eventos depende de la plataforma y del usuario, así
  // que las instrucciones la llevan como marcador y se resuelve al instalar.
  const instructions = path.join(target, "AGENTS.md");
  const eventLog = path.join(stateDir, "events.jsonl");
  const text = await readFile(instructions, "utf8");
  await writeFile(instructions, text.replaceAll("{{EVENT_LOG}}", eventLog), "utf8");

  return target;
}

/**
 * Declara el servidor MCP en el directorio de la sesión maestra.
 *
 * Sin esto, la sesión lee unas instrucciones que describen herramientas de las
 * que no dispone. Se escribe con la URL efectiva y no con una fija porque el
 * puerto es configurable y puede resolverse a otro si el previsto está ocupado.
 *
 * Debe ejecutarse antes de abrir la pestaña maestra: el archivo se lee al
 * iniciar la sesión, no durante ella.
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

  // Permisos de proyecto para que la sesión maestra disponga de las herramientas
  // sin aprobaciones manuales. Solo aplican en este directorio: ninguna otra
  // sesión los hereda.
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
