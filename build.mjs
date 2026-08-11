import { build } from "esbuild";
import { cp, mkdir } from "node:fs/promises";

// node-pty carga un .node nativo por require dinámico: debe quedar externo al bundle.
// Electron y los módulos built-in también se resuelven en runtime.
const mainExternals = ["electron", "node-pty"];

const common = {
  bundle: true,
  sourcemap: true,
  logLevel: "info",
};

await mkdir("dist/renderer", { recursive: true });

await build({
  ...common,
  entryPoints: ["src/main/index.ts"],
  outfile: "dist/main/index.js",
  platform: "node",
  format: "cjs",
  target: "node22",
  external: mainExternals,
});

await build({
  ...common,
  entryPoints: ["src/preload/index.ts"],
  outfile: "dist/preload/index.js",
  platform: "node",
  format: "cjs",
  target: "node22",
  external: ["electron"],
});

await build({
  ...common,
  entryPoints: ["src/renderer/index.ts"],
  outfile: "dist/renderer/index.js",
  platform: "browser",
  format: "iife",
  target: "chrome130",
});

await cp("src/renderer/index.html", "dist/renderer/index.html");
await cp("src/renderer/style.css", "dist/renderer/style.css");
await cp("node_modules/@xterm/xterm/css/xterm.css", "dist/renderer/xterm.css");
