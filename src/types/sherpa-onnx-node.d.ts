// sherpa-onnx-node ships plain JS with JSDoc comments, no .d.ts. This covers
// only the keyword-spotting, VAD and text-to-speech surface this project
// actually calls; see node_modules/sherpa-onnx-node/{keyword-spotter,vad,
// non-streaming-tts,types}.js for the full native API.
declare module "sherpa-onnx-node" {
  export interface Waveform {
    samples: Float32Array;
    sampleRate: number;
  }

  export interface KeywordResult {
    start_time: number;
    keyword: string;
    timestamps: number[];
    tokens: string[];
  }

  export interface OnlineStream {
    acceptWaveform(wave: Waveform): void;
    inputFinished(): void;
  }

  export interface KeywordSpotterConfig {
    featConfig?: { sampleRate?: number; featureDim?: number };
    modelConfig: {
      transducer: { encoder: string; decoder: string; joiner: string };
      tokens: string;
      numThreads?: number;
      provider?: string;
      debug?: number | boolean;
    };
    maxActivePaths?: number;
    numTrailingBlanks?: number;
    keywordsScore?: number;
    keywordsThreshold?: number;
    keywordsFile: string;
  }

  export class KeywordSpotter {
    constructor(config: KeywordSpotterConfig);
    createStream(): OnlineStream;
    isReady(stream: OnlineStream): boolean;
    decode(stream: OnlineStream): void;
    reset(stream: OnlineStream): void;
    getResult(stream: OnlineStream): KeywordResult;
  }

  export interface SileroVadModelConfig {
    model: string;
    threshold?: number;
    minSpeechDuration?: number;
    minSilenceDuration?: number;
    windowSize?: number;
  }

  export interface VadConfig {
    sileroVad?: SileroVadModelConfig;
    sampleRate?: number;
    numThreads?: number;
    debug?: boolean;
  }

  export interface SpeechSegment {
    start: number;
    samples: Float32Array;
  }

  export class Vad {
    constructor(config: VadConfig, bufferSizeInSeconds: number);
    acceptWaveform(samples: Float32Array): void;
    isEmpty(): boolean;
    isDetected(): boolean;
    pop(): void;
    clear(): void;
    front(enableExternalBuffer?: boolean): SpeechSegment;
    reset(): void;
    flush(): void;
  }

  export class CircularBuffer {
    constructor(capacity: number);
    push(samples: Float32Array): void;
    get(startIndex: number, n: number, enableExternalBuffer?: boolean): Float32Array;
    pop(n: number): void;
    size(): number;
    head(): number;
    reset(): void;
  }

  export interface AudioProcessRequest {
    samples: Float32Array;
    sampleRate: number;
    enableExternalBuffer?: boolean;
  }

  export interface GeneratedAudio {
    samples: Float32Array;
    sampleRate: number;
  }

  export interface OfflineSpeechDenoiserConfig {
    model: {
      gtcrn?: { model: string };
      dpdfnet?: { model: string; attenuationLimitDb?: number };
      numThreads?: number;
      debug?: number | boolean;
      provider?: string;
    };
  }

  export class OfflineSpeechDenoiser {
    constructor(config: OfflineSpeechDenoiserConfig);
    readonly sampleRate: number;
    run(request: AudioProcessRequest): GeneratedAudio;
  }

  export interface OfflineTtsConfig {
    model: {
      vits?: { model: string; tokens: string; dataDir?: string; lexicon?: string; noiseScale?: number; noiseScaleW?: number; lengthScale?: number };
      numThreads?: number;
      debug?: number | boolean;
      provider?: string;
    };
    maxNumSentences?: number;
  }

  export interface TtsRequest {
    text: string;
    sid: number;
    speed: number;
    enableExternalBuffer?: boolean;
  }

  /** Return 0 or false to abort the generation in progress. */
  export type TtsProgress = (info: { samples: Float32Array; progress: number }) => number | boolean | void;

  export class OfflineTts {
    constructor(config: OfflineTtsConfig);
    static createAsync(config: OfflineTtsConfig): Promise<OfflineTts>;
    readonly sampleRate: number;
    readonly numSpeakers: number;
    generate(request: TtsRequest): GeneratedAudio;
    generateAsync(request: TtsRequest & { onProgress?: TtsProgress }): Promise<GeneratedAudio>;
  }
}
