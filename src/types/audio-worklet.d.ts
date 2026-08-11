// The DOM lib does not include AudioWorkletGlobalScope: it is a separate
// realm from the window/document globals the rest of the renderer runs in.
// Minimal shim for the two globals src/renderer/voice-worklet.ts calls.
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor(options?: unknown);
  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>,
  ): boolean;
}

declare function registerProcessor(
  name: string,
  processorCtor: new (options?: unknown) => AudioWorkletProcessor,
): void;
