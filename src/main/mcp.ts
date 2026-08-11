import type { Server } from "node:http";
import { createMcpExpressApp } from "@modelcontextprotocol/express";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import * as z from "zod";
import type { Registry } from "./registry";

// El tipo de retorno se deja inferir: la unión de resultados del SDK discrimina
// por el literal "text", que se ensancharía a string con una anotación propia.
function text(value: unknown) {
  const body = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return { content: [{ type: "text" as const, text: body }] };
}

function buildServer(registry: Registry): McpServer {
  const server = new McpServer({ name: "voice-master", version: "0.1.0" });

  server.registerTool(
    "terminals_list",
    {
      description:
        "Lista las terminales abiertas con su id, título, directorio y estado. " +
        "El estado 'waiting' indica que la terminal espera una respuesta interactiva. " +
        "No incluye la sesión maestra, que queda fuera de alcance por diseño.",
      inputSchema: z.object({}),
    },
    async () => text(registry.list()),
  );

  server.registerTool(
    "terminal_read",
    {
      description:
        "Devuelve las últimas líneas de una terminal, leídas del buffer de pantalla. " +
        "Funciona igual sobre una shell normal que sobre una aplicación de pantalla completa.",
      inputSchema: z.object({
        id: z.string().describe("Identificador de la terminal"),
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
        "Abre una terminal nueva y la deja lista en una sola llamada: directorio, nombre, " +
        "color y comando inicial. Con 'cwd' trabaja sobre ese directorio; con 'temporary' en " +
        "true se crea uno temporal que se borra al cerrar la pestaña. Hay que indicar uno de " +
        "los dos.\n\n" +
        "Usar 'run' para lanzar un agente (por ejemplo 'claude'): se espera a que el shell " +
        "esté listo antes de escribirlo. Evita tener que encadenar terminal_label y " +
        "terminal_write después de abrir.",
      inputSchema: z.object({
        cwd: z.string().optional().describe("Directorio de trabajo, ruta absoluta"),
        temporary: z
          .boolean()
          .default(false)
          .describe("Crea un directorio temporal en lugar de usar 'cwd'"),
        title: z.string().optional(),
        color: z
          .string()
          .regex(/^#[0-9a-fA-F]{6}$/)
          .optional()
          .describe("Color de identificación en formato #rrggbb"),
        run: z
          .string()
          .optional()
          .describe("Comando a ejecutar una vez que el shell esté listo, por ejemplo 'claude'"),
        shell: z.string().optional().describe("Shell a ejecutar; por defecto la del usuario"),
      }),
    },
    async ({ cwd, temporary, title, color, run, shell }) => {
      if (!temporary && !cwd) {
        throw new Error("hay que indicar 'cwd' o poner 'temporary' en true");
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
        // Escribir antes de que el shell dibuje su prompt puede perder la orden,
        // y la carga del perfil del usuario no tiene una duración previsible.
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
        "Envía texto a una terminal. Requiere confirmación previa del usuario: no " +
        "invocar por iniciativa propia. Con submit=true agrega un salto de línea. " +
        "Para responder a un selector, usar las secuencias de flechas en 'text'.",
      inputSchema: z.object({
        id: z.string(),
        text: z.string().describe("Texto a escribir en el pty"),
        submit: z.boolean().default(false).describe("Agrega \\r al final"),
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
        "Eventos recientes de las pestañas, del más nuevo al más viejo. Tipos: " +
        "'task-finished' (terminó una ejecución de 15 s o más, con duración y código de " +
        "salida), 'prompt' (una terminal espera respuesta), 'notification' (una aplicación " +
        "notificó; las sesiones de agente informan aquí su estado), 'exit' (murió el proceso) " +
        "y 'status'. Es la forma de saber qué pasó sin sondear cada terminal. No incluye la " +
        "sesión maestra.\n\n" +
        "Por omisión se devuelve solo lo que amerita una decisión: quedan fuera los 'status' y " +
        "las notificaciones de avance de un agente ('prompt_submit', 'tool_complete', " +
        "'post_tool_use'), que llegan por decenas mientras trabaja. Para ver también esas, " +
        "pedir explícitamente types: ['notification'].",
      inputSchema: z.object({
        limit: z.number().int().min(1).max(200).default(30),
        types: z
          .array(z.string())
          .optional()
          .describe("Tipos a incluir sin filtro fino; si se omite, se devuelve solo lo accionable"),
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
        "Se queda esperando hasta que ocurra algo que amerite una decisión —una tarea que " +
        "termina, un agente que finaliza su turno o pide permiso, un proceso que muere— y lo " +
        "devuelve. Si no pasa nada dentro del plazo devuelve una lista vacía, y conviene volver " +
        "a llamar.\n\n" +
        "Usar esta herramienta después de delegar una tarea, en lugar de consultar " +
        "'events_recent' en bucle: la llamada no responde hasta que hay novedad, así que no se " +
        "gasta nada mientras el otro agente trabaja. No incluye la sesión maestra.",
      inputSchema: z.object({
        timeout_seconds: z
          .number()
          .int()
          .min(1)
          .max(120)
          .default(60)
          .describe("Cuánto esperar antes de devolver vacío"),
        types: z
          .array(z.string())
          .optional()
          .describe("Tipos a esperar; si se omite, se espera cualquier evento accionable"),
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
        "Cambia el nombre y/o el color de una pestaña. Sirve para organizar: por ejemplo, " +
        "marcar en rojo la que falló o renombrar según la tarea que corre. Ambos campos son " +
        "opcionales; el color se quita pasando null. No alcanza a la sesión maestra.",
      inputSchema: z.object({
        id: z.string(),
        title: z.string().optional().describe("Nombre visible; se recorta a 60 caracteres"),
        color: z
          .string()
          .regex(/^#[0-9a-fA-F]{6}$/)
          .nullable()
          .optional()
          .describe("Color en formato #rrggbb, o null para quitarlo"),
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
      description: "Cierra una terminal y termina su proceso.",
      inputSchema: z.object({ id: z.string() }),
    },
    async ({ id }) => {
      registry.getControllable(id);
      registry.close(id);
      return text({ id, closed: true });
    },
  );

  return server;
}

export interface McpEndpoint {
  port: number;
  url: string;
  close: () => Promise<void>;
}

/**
 * Publica el servidor MCP por HTTP en loopback.
 *
 * El handler recibe una fábrica: se construye un McpServer por petición, así que
 * las herramientas cierran sobre el registro compartido en lugar de sobre estado
 * propio de una instancia.
 */
export async function startMcpServer(
  registry: Registry,
  port: number,
  token: string,
): Promise<McpEndpoint> {
  const handler = createMcpHandler(() => buildServer(registry));
  const node = toNodeHandler(handler);

  const app = createMcpExpressApp();

  // El secreto va en la ruta y no en una cabecera: hay defectos abiertos en los
  // que el cliente no envía las cabeceras declaradas en `.mcp.json`, mientras que
  // la URL viaja siempre. Cualquier otra ruta no existe, de modo que conocer el
  // puerto no alcanza para usar el servidor.
  app.all(`/mcp/${token}`, (req, res) => void node(req, res, req.body));

  const server: Server = await new Promise((resolve, reject) => {
    const instance = app.listen(port, "127.0.0.1", () => resolve(instance));
    instance.on("error", reject);
  });

  const address = server.address();
  const bound = typeof address === "object" && address !== null ? address.port : port;

  return {
    port: bound,
    url: `http://127.0.0.1:${bound}/mcp/${token}`,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
