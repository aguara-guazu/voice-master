import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// Marcadores semánticos OSC 133: el shell informa dónde empieza y termina cada
// comando. Sin esto el estado de la terminal solo puede inferirse del output, y
// un comando que tarda sin imprimir nada resulta indistinguible de una shell en
// reposo.
const ZSHRC = `# Generado por voice-master. No editar: se reescribe en cada arranque.
# Reenvía la configuración del usuario y añade marcadores OSC 133.

VM_ORIG="\${VM_ZDOTDIR_ORIG:-$HOME}"
[[ -f "$VM_ORIG/.zshrc" ]] && source "$VM_ORIG/.zshrc"

autoload -Uz add-zsh-hook 2>/dev/null && {
  _vm_preexec() { printf '\\033]133;C\\007' }
  _vm_precmd()  { local code=$?; printf '\\033]133;D;%s\\007' "$code" }
  add-zsh-hook preexec _vm_preexec
  add-zsh-hook precmd  _vm_precmd
}
`;

// zsh resuelve .zshenv y .zprofile dentro de ZDOTDIR; sin estos reenvíos, apuntar
// ZDOTDIR a otro directorio dejaría fuera la configuración del usuario.
const ZSHENV = `VM_ORIG="\${VM_ZDOTDIR_ORIG:-$HOME}"
[[ -f "$VM_ORIG/.zshenv" ]] && source "$VM_ORIG/.zshenv"
`;

const ZPROFILE = `VM_ORIG="\${VM_ZDOTDIR_ORIG:-$HOME}"
[[ -f "$VM_ORIG/.zprofile" ]] && source "$VM_ORIG/.zprofile"
`;

export interface ShellIntegration {
  dir: string;
  env: Record<string, string>;
}

/**
 * Prepara un ZDOTDIR propio que reenvía a la configuración del usuario y añade
 * los marcadores de comando. No modifica ningún archivo del usuario.
 *
 * Devuelve null para shells distintos de zsh: bash y fish usan otros hooks y
 * todavía no están implementados.
 */
export async function prepareShellIntegration(
  stateDir: string,
  shell: string,
): Promise<ShellIntegration | null> {
  if (!shell.endsWith("zsh")) return null;

  const dir = path.join(stateDir, "shell-integration", "zsh");
  await mkdir(dir, { recursive: true });

  await Promise.all([
    writeFile(path.join(dir, ".zshrc"), ZSHRC, "utf8"),
    writeFile(path.join(dir, ".zshenv"), ZSHENV, "utf8"),
    writeFile(path.join(dir, ".zprofile"), ZPROFILE, "utf8"),
  ]);

  return {
    dir,
    env: {
      ZDOTDIR: dir,
      VM_ZDOTDIR_ORIG: process.env["ZDOTDIR"] ?? os.homedir(),
    },
  };
}

/**
 * Variables que el plugin oficial de Claude Code para Warp comprueba antes de
 * emitir sus notificaciones estructuradas (`should-use-structured.sh`). El
 * transporte es OSC 777 sobre el stdout del pty, no un canal privado de Warp:
 * declarando compatibilidad con el protocolo, el plugin emite y esta aplicación
 * lo recibe igual.
 *
 * La versión es un valor fijado a mano. Si Warp endurece la comprobación o el
 * formato del payload cambia, esto deja de funcionar en silencio: el detector de
 * pantalla queda como respaldo.
 */
export const CLI_AGENT_ENV: Record<string, string> = {
  WARP_CLI_AGENT_PROTOCOL_VERSION: "1",
  WARP_CLIENT_VERSION: "v0.2026.07.29.09.05.stable_02",
};

// Variables que Claude Code exporta a sus procesos hijos. Si la aplicación se
// lanza desde una sesión de Claude Code, heredarlas hace que toda terminal que
// abra parezca una sesión anidada: entre otros efectos, el marcador de sesión
// hija desactiva el guardado del transcript, y sin transcript los eventos de fin
// de turno llegan sin la consulta ni la respuesta.
const AGENT_VARS = [
  "CLAUDECODE",
  "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_EXECPATH",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_CODE_VERSION",
  "CLAUDE_EFFORT",
  "CLAUDE_PID",
];

/** Copia el entorno descartando lo que no debe heredar una terminal nueva. */
export function sanitizeEnv(source: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined || AGENT_VARS.includes(key)) continue;
    out[key] = value;
  }
  return out;
}
