// Detección sobre el stream del pty y sobre el buffer de pantalla.
//
// Dos mecanismos independientes:
//   - scanOsc: secuencias OSC 9 / OSC 777 en el stream crudo. Las emite cualquier
//     aplicación que notifique al terminal, incluido el plugin de Claude Code.
//   - detectPrompt: heurística sobre las últimas líneas del buffer renderizado.
//     Solo tiene sentido evaluarla cuando el pty lleva un rato sin emitir datos;
//     evaluarla durante la escritura produce falsos positivos sobre output parcial.

export interface OscNotification {
  kind: "notify" | "generic";
  title: string;
  body: string;
  raw: string;
}

export type CommandMark =
  | { kind: "start" }
  | { kind: "end"; exitCode: number | null };

export interface OscScan {
  notifications: OscNotification[];
  marks: CommandMark[];
}

// OSC abre con ESC ] y cierra con BEL o ST (ESC \).
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
      // Formato: 777;notify;<title>;<body>. El body puede ser JSON y contener
      // punto y coma, de modo que solo se separan los dos primeros campos.
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
      // A: inicio de prompt, B: fin de prompt, C: inicio de comando,
      // D[;code]: fin de comando. Solo C y D delimitan una ejecución.
      const [marker, value] = payload.split(";");
      if (marker === "C") {
        marks.push({ kind: "start" });
      } else if (marker === "D") {
        const parsed = Number.parseInt(value ?? "", 10);
        marks.push({ kind: "end", exitCode: Number.isNaN(parsed) ? null : parsed });
      } else if (marker === "A") {
        // El prompt vuelve a dibujarse: no hay comando en curso. No transporta
        // código de salida, así que se reporta desconocido en lugar de cero.
        marks.push({ kind: "end", exitCode: null });
      }
    }
  }

  return { notifications, marks };
}

export interface PromptDetection {
  matched: string;
  line: string;
  confidence: "alta" | "media";
}

// Confirmaciones explícitas y selectores de las CLI más habituales.
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

// Listas de opciones navegables: el cursor marca la fila activa.
const MEDIUM_CONFIDENCE: RegExp[] = [
  /^\s*[❯>»]\s+\S/,
  /^\s*\d+[.)]\s+\S/,
  /\(use arrow keys\)/i,
  /\[\s*\]\s+\S/,
];

/**
 * Evalúa las últimas líneas visibles del buffer. `tail` debe venir ya recortado
 * y sin líneas en blanco al final.
 *
 * Devuelve null cuando ninguna línea coincide. Un resultado de confianza media
 * no debería dispararse solo: conviene confirmarlo con inactividad sostenida.
 */
export function detectPrompt(tail: string[]): PromptDetection | null {
  if (tail.length === 0) return null;

  const last = tail[tail.length - 1] ?? "";
  const trimmed = last.trimEnd();

  for (const pattern of HIGH_CONFIDENCE) {
    if (pattern.test(trimmed)) {
      return { matched: pattern.source, line: trimmed, confidence: "alta" };
    }
  }

  // Un selector rara vez ocupa la última línea: se revisan las anteriores.
  for (const line of tail.slice(-6)) {
    for (const pattern of MEDIUM_CONFIDENCE) {
      if (pattern.test(line)) {
        return { matched: pattern.source, line: line.trimEnd(), confidence: "media" };
      }
    }
  }

  return null;
}

// Un prompt de shell en reposo no es una pregunta pendiente. Se descarta antes
// de evaluar para que la inactividad no lo reporte como espera de respuesta.
const SHELL_PROMPT = /(^|\s)[%$#❯➜]\s*$/;

export function looksLikeShellPrompt(line: string): boolean {
  return SHELL_PROMPT.test(line.trimEnd());
}
