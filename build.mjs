import { build } from "esbuild";
import { cp, mkdir } from "node:fs/promises";

// node-pty, sherpa-onnx-node and @fugood/whisper.node all load a native .node
// through a dynamic require/import: they must stay external to the bundle.
// Electron and built-in modules are resolved at runtime too.
const mainExternals = ["electron", "node-pty", "sherpa-onnx-node", "@fugood/whisper.node"];

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

// Loaded via audioContext.audioWorklet.addModule(): a worklet runs in its own
// global scope and cannot be part of the main renderer bundle.
await build({
  ...common,
  entryPoints: ["src/renderer/voice-worklet.ts"],
  outfile: "dist/renderer/voice-worklet.js",
  platform: "browser",
  format: "iife",
  target: "chrome130",
});

await cp("src/renderer/index.html", "dist/renderer/index.html");
await cp("src/renderer/style.css", "dist/renderer/style.css");
await cp("node_modules/@xterm/xterm/css/xterm.css", "dist/renderer/xterm.css");
