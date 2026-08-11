// @fugood/whisper.node's package.json points "types" at lib/index.d.ts, which
// the published package does not actually ship (only lib/index.ts). This
// covers only the transcription surface this project calls; see
// node_modules/@fugood/whisper.node/lib/binding.ts for the full native API.
declare module "@fugood/whisper.node" {
  export interface NativeContextOptions {
    filePath: string;
    modelUrl?: string;
    useFlashAttn?: boolean;
    useGpu?: boolean;
    maxModelBytes?: number;
  }

  export interface TranscribeOptions {
    language?: string;
    translate?: boolean;
    maxThreads?: number;
    beamSize?: number;
    prompt?: string;
  }

  export interface TranscribeResult {
    language?: string;
    result: string;
    segments: Array<{ text: string; t0: number; t1: number }>;
    isAborted: boolean;
  }

  export interface WhisperContext {
    transcribeData(
      audioData: ArrayBuffer,
      options?: TranscribeOptions,
    ): { stop: () => Promise<void>; promise: Promise<TranscribeResult> };
    release(): Promise<void>;
  }

  export function initWhisper(options: NativeContextOptions): Promise<WhisperContext>;
}
