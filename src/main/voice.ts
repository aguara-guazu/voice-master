import { EventEmitter } from "node:events";
import { appendFile } from "node:fs/promises";
import path from "node:path";
import { CircularBuffer, OfflineSpeechDenoiser, Vad } from "sherpa-onnx-node";
import { initWhisper } from "@fugood/whisper.node";
import type { WhisperContext } from "@fugood/whisper.node";

export type VoiceState = "idle" | "recording" | "transcribing";

const SAMPLE_RATE = 16000;

// silero-vad's native chunk size at 16 kHz; feeding it any other size throws.
const VAD_WINDOW = 512;

// Caps one utterance: if the VAD reports continuous speech for this long, the
// segment is flushed to transcription instead of growing without bound.
const MAX_UTTERANCE_MS = 15_000;

// A single transcription failure is treated as transient and listening resumes;
// this many in a row point at a broken pipeline and turn the microphone off.
const MAX_CONSECUTIVE_FAILURES = 3;

export declare interface VoiceController {
  on(event: "state", listener: (state: VoiceState) => void): this;
}

/**
 * Always-on dictation into the voice channel: while enabled, the microphone
 * listens continuously and each utterance — segmented by sherpa-onnx's VAD,
 * denoised (sherpa-onnx's dpdfnet8), transcribed by whisper.cpp — is appended
 * as one JSON line to the voice log. Nothing is typed into any terminal: the
 * master session watches that file with the same tail-and-wake mechanism it
 * uses for tab events, and receives every line as the user's spoken message.
 * Entirely local, no network call in any step.
 *
 * Two earlier delivery designs were dropped; the reasoning is in notes.md.
 * Typing into the master's TUI lost text to redraw races and paste detection
 * even with delivery confirmation on top. A wake word (sherpa-onnx
 * KeywordSpotter) never fired on a real voice; its model is still in
 * resources/voice/kws-model/ to pick back up later.
 *
 * Models load lazily (`ensureLoaded`), but `preload()` is called at
 * application start so that enabling — which happens when the master agent
 * finishes its boot turn — is immediate.
 */
export class VoiceController extends EventEmitter {
  private vad: Vad | null = null;
  private vadBuffer: CircularBuffer | null = null;
  private denoiser: OfflineSpeechDenoiser | null = null;
  private whisper: WhisperContext | null = null;
  private loadingPromise: Promise<void> | null = null;

  private _enabled = false;
  private _state: VoiceState = "idle";
  private speechStartedAt = 0;
  private consecutiveFailures = 0;

  constructor(
    private voiceLog: string,
    private modelsDir: string,
  ) {
    super();
  }

  get enabled(): boolean {
    return this._enabled;
  }

  get state(): VoiceState {
    return this._state;
  }

  /**
   * Starts loading the models ahead of time so enabling later is immediate.
   * The master agent's boot turn takes long enough to hide the load, and the
   * microphone comes up right when that turn ends.
   */
  preload(): void {
    void this.ensureLoaded().catch((error) => {
      console.error("voice: could not preload the local models", error);
    });
  }

  /**
   * Returns the state actually reached: loading the models can fail. Enabling
   * starts listening immediately and stays listening between utterances;
   * silence never turns it off, only this method or a broken pipeline does.
   */
  async setEnabled(value: boolean): Promise<boolean> {
    if (value) {
      try {
        await this.ensureLoaded();
      } catch (error) {
        console.error("voice: could not load the local models", error);
        return false;
      }
      this._enabled = true;
      this.beginRecording();
    } else {
      this._enabled = false;
      this.setState("idle");
    }
    return this._enabled;
  }

  /** Feeds a chunk of mono 16 kHz PCM16 samples captured in the renderer. */
  pushAudio(pcm16: Int16Array): void {
    if (!this._enabled || !this.vad || !this.vadBuffer) return;

    logAudioLevel(pcm16);

    if (this._state === "recording") {
      this.feedVad(toFloat32(pcm16));
    }
    // "transcribing": audio arriving mid-transcription is dropped. A short
    // command finishes transcribing in well under a second on this pipeline.
  }

  private async ensureLoaded(): Promise<void> {
    if (this.vad && this.whisper) return;
    if (!this.loadingPromise) this.loadingPromise = this.load();
    return this.loadingPromise;
  }

  private async load(): Promise<void> {
    this.vad = new Vad(
      {
        sileroVad: {
          model: path.join(this.modelsDir, "silero_vad.onnx"),
          threshold: 0.5,
          minSpeechDuration: 0.25,
          minSilenceDuration: 0.6,
          windowSize: VAD_WINDOW,
        },
        sampleRate: SAMPLE_RATE,
        numThreads: 1,
        debug: false,
      },
      60,
    );
    this.vadBuffer = new CircularBuffer(30 * SAMPLE_RATE);

    // dpdfnet8: the "best enhancement quality" variant of the four shipped
    // (baseline/2/4/8) — not resource-constrained here, so quality over the
    // lighter ones. Applied once to the finished utterance, not per-chunk:
    // simpler than streaming denoising and matches where it is needed (right
    // before whisper), not the VAD, which segments fine on raw audio.
    this.denoiser = new OfflineSpeechDenoiser({
      model: {
        dpdfnet: { model: path.join(this.modelsDir, "denoiser-dpdfnet8.onnx"), attenuationLimitDb: 12 },
        numThreads: 1,
        debug: 0,
      },
    });

    this.whisper = await initWhisper({
      filePath: path.join(this.modelsDir, "whisper-small.bin"),
      useGpu: true,
    });
  }

  private beginRecording(): void {
    this.vad?.reset();
    this.vadBuffer?.reset();
    this.speechStartedAt = 0;
    this.setState("recording");
  }

  private feedVad(samples: Float32Array): void {
    const vad = this.vad;
    const buffer = this.vadBuffer;
    if (!vad || !buffer) return;

    buffer.push(samples);
    while (buffer.size() >= VAD_WINDOW) {
      // enableExternalBuffer defaults to true in the library, which crashes
      // ("External buffers are not allowed") under Electron's V8 build,
      // though it works fine under a plain Node runtime. Verified locally.
      const window = buffer.get(buffer.head(), VAD_WINDOW, false);
      buffer.pop(VAD_WINDOW);
      vad.acceptWaveform(window);
    }

    this.drainSegment();
    if (this._state !== "recording") return; // a segment just moved us to "transcribing"

    // Listening has no timeout: silence is the normal state between utterances.
    // Only continuous speech is capped, so a segment the VAD never closes
    // (sustained noise, a conversation nearby) still gets flushed.
    if (!vad.isDetected()) {
      this.speechStartedAt = 0;
      return;
    }
    if (this.speechStartedAt === 0) {
      this.speechStartedAt = Date.now();
    } else if (Date.now() - this.speechStartedAt > MAX_UTTERANCE_MS) {
      vad.flush();
      this.speechStartedAt = 0;
      this.drainSegment();
    }
  }

  /** At most one utterance per drain: later segments are left for next time. */
  private drainSegment(): void {
    const vad = this.vad;
    if (!vad || vad.isEmpty()) return;
    const segment = vad.front(false); // see the note on buffer.get() above
    vad.pop();
    void this.transcribe(segment.samples);
  }

  private async transcribe(samples: Float32Array): Promise<void> {
    if (!this.whisper) return;
    this.setState("transcribing");

    try {
      const cleaned = this.denoiser
        ? this.denoiser.run({ samples, sampleRate: SAMPLE_RATE, enableExternalBuffer: false }).samples
        : samples;
      const pcm16 = toInt16(cleaned);
      const { promise } = this.whisper.transcribeData(pcm16.buffer as ArrayBuffer, { language: "es" });
      const result = await promise;
      this.consecutiveFailures = 0;
      const text = result.result.trim();
      // A manual click off during transcription lands here with _enabled
      // already false: the transcription still ran, but nothing is published.
      if (text && this._enabled) await this.publish(text);
    } catch (error) {
      console.error("voice: transcription failed", error);
      this.consecutiveFailures += 1;
      if (this.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        console.error("voice: repeated transcription failures, turning off");
        this._enabled = false;
      }
    }

    if (this._enabled) this.beginRecording();
    else this.setState("idle");
  }

  /**
   * Appends the utterance to the voice channel. The master session's watcher
   * turns each line into a wake-up with the text attached, so delivery does
   * not depend on the state of any terminal: no TUI redraw race, no paste
   * detection, nothing to confirm. Lines written while nobody watches the
   * file simply sit there unread.
   */
  private async publish(text: string): Promise<void> {
    const line = JSON.stringify({ type: "voice", at: new Date().toISOString(), text });
    try {
      await appendFile(this.voiceLog, `${line}\n`, "utf8");
      console.log(`voice: published ${text.length} characters to the voice channel`);
    } catch (error) {
      console.error("voice: could not write to the voice channel", error);
    }
  }

  private setState(state: VoiceState): void {
    if (this._state === state) return;
    this._state = state;
    this.emit("state", state);
  }

  /**
   * Releases the whisper context before the process exits. Without this, the
   * Metal backend hits a native assertion in its own exit-time cleanup
   * (`ggml-metal-device.m`, GGML_ASSERT([rsets->data count] == 0)) and the
   * whole process aborts with SIGABRT instead of quitting cleanly. Verified
   * locally: reproduced under Electron's runtime, gone once released first.
   */
  async dispose(): Promise<void> {
    try {
      await this.whisper?.release();
    } catch (error) {
      console.error("voice: failed to release the whisper context", error);
    }
  }
}

function toFloat32(pcm16: Int16Array): Float32Array {
  const out = new Float32Array(pcm16.length);
  for (let i = 0; i < pcm16.length; i++) out[i] = (pcm16[i] ?? 0) / 32768;
  return out;
}

function toInt16(samples: Float32Array): Int16Array {
  const out = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i] ?? 0));
    out[i] = clamped < 0 ? clamped * 32768 : clamped * 32767;
  }
  return out;
}

// TEMPORARY: diagnosing whether real microphone audio reaches this process at
// all, since nothing in the UI currently surfaces that. Remove once dictation
// has been confirmed working end to end with a real voice.
let lastLevelLogAt = 0;
function logAudioLevel(pcm16: Int16Array): void {
  const now = Date.now();
  if (now - lastLevelLogAt < 1000) return;
  lastLevelLogAt = now;

  let sumSquares = 0;
  let peak = 0;
  for (let i = 0; i < pcm16.length; i++) {
    const sample = pcm16[i] ?? 0;
    sumSquares += sample * sample;
    peak = Math.max(peak, Math.abs(sample));
  }
  const rms = Math.sqrt(sumSquares / pcm16.length);
  console.log(`voice: audio level rms=${rms.toFixed(0)} peak=${peak} (of 32767)`);
}
