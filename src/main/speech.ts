import { EventEmitter } from "node:events";
import path from "node:path";
import { OfflineTts } from "sherpa-onnx-node";

const MODEL_DIR = "vits-piper-es_AR-daniela-high";
const MODEL_FILE = "es_AR-daniela-high.onnx";

// Piper's es_AR-daniela reads faster than is comfortable to listen to at 1.0.
// sherpa maps this to the inverse of the length scale, so below 1 is slower.
// Settled by ear against the running application, listening to each candidate
// before keeping it.
const DEFAULT_SPEED = 0.82;

// Guards against a request that would occupy the synthesiser for minutes. The
// master session is instructed to speak in short turns; this is the backstop
// for an instruction that was not followed, not the expected size.
const MAX_CHARACTERS = 2000;

// The renderer reports back when the audio actually stops coming out of the
// speakers, which is what releases the microphone. If that report never
// arrives — a closed window, a playback failure — the microphone would stay
// muted for the rest of the session, so the wait is capped. Generous on top of
// the generated duration: it only has to cover scheduling, not synthesis.
const PLAYBACK_ACK_GRACE_MS = 10_000;

export declare interface SpeechController {
  on(event: "chunk", listener: (samples: Float32Array, sampleRate: number) => void): this;
  on(event: "end", listener: () => void): this;
  on(event: "speaking", listener: (speaking: boolean) => void): this;
}

/**
 * Speaks text through the local Piper voice.
 *
 * The master session writes its own spoken version of a turn and hands it over
 * through the `speak` MCP tool: the text arrives already normalised for the ear
 * — no paths, no identifiers, numbers spelled out — because deciding what is
 * worth saying out loud is a content decision only its author can make. Nothing
 * here rewrites the text.
 *
 * Synthesis is streamed. `generateAsync` reports sentence-aligned chunks as they
 * come out of the model, each one forwarded to the renderer to be scheduled for
 * playback, so speech starts on the first sentence instead of after the whole
 * utterance. Measured locally on an M1 Pro: first chunk at 253 ms against
 * 2722 ms for the complete generation of the same text.
 *
 * Entirely local, no network call. The espeak-ng phonemiser travels inside the
 * model directory, so nothing has to be installed on the system.
 */
export class SpeechController extends EventEmitter {
  private tts: OfflineTts | null = null;
  private loadingPromise: Promise<void> | null = null;

  private _speaking = false;
  private playbackAck: (() => void) | null = null;

  // Backs the end-of-turn check. Nothing forces the master session to call
  // `speak`, and a turn it forgets to speak is a turn the user may never notice.
  private spokenSinceCheck = false;
  private nudgedLastCheck = false;

  // One utterance at a time: two voices over each other are unintelligible, and
  // the microphone gate is a single flag. A request arriving mid-speech waits.
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private modelsDir: string) {
    super();
  }

  get speaking(): boolean {
    return this._speaking;
  }

  /** Loads the model ahead of the first request; ~580 ms measured locally. */
  preload(): void {
    void this.ensureLoaded().catch((error) => {
      console.error("speech: could not preload the voice model", error);
    });
  }

  /**
   * Synthesises and plays, resolving once the audio has finished coming out of
   * the speakers rather than when generation ends. The master session waits on
   * this call, so a turn cannot pile its next utterance on top of this one.
   */
  async speak(text: string, speed = DEFAULT_SPEED): Promise<{ characters: number; seconds: number }> {
    const clean = text.trim();
    if (!clean) throw new Error("nothing to say: the text is empty");
    if (clean.length > MAX_CHARACTERS) {
      throw new Error(`the text exceeds ${MAX_CHARACTERS} characters; say it in shorter turns`);
    }

    const run = this.queue.then(() => this.synthesise(clean, speed));
    // The queue must survive a failed utterance, or every later call inherits
    // the rejection. The caller still gets the error through `run`.
    this.queue = run.catch(() => undefined);
    return run;
  }

  /**
   * Reports that the renderer has finished playing. Called from the playback
   * acknowledgement; harmless when nothing is speaking.
   */
  notifyPlaybackFinished(): void {
    this.playbackAck?.();
  }

  /**
   * Answers the master session's end-of-turn check: "ok" when it spoke since
   * the previous end of turn, "missing" when it did not.
   *
   * The turn boundary is this call itself rather than a prompt event, so the
   * check does not depend on how the turn was started — typed, spoken, or woken
   * by the watcher.
   *
   * A "missing" answer is returned at most once in a row. If the session ends
   * another turn without speaking after being told to, the check gives up and
   * answers "ok": the alternative is a Stop hook that blocks the same turn
   * forever, which is worse than a silent turn.
   */
  reportTurnEnd(): "ok" | "missing" {
    if (this.spokenSinceCheck) {
      this.spokenSinceCheck = false;
      this.nudgedLastCheck = false;
      return "ok";
    }
    if (this.nudgedLastCheck) {
      this.nudgedLastCheck = false;
      return "ok";
    }
    this.nudgedLastCheck = true;
    return "missing";
  }

  private async synthesise(text: string, speed: number): Promise<{ characters: number; seconds: number }> {
    await this.ensureLoaded();
    const tts = this.tts;
    if (!tts) throw new Error("the voice model is not loaded");

    this.setSpeaking(true);
    try {
      const audio = await tts.generateAsync({
        text,
        sid: 0,
        speed,
        // enableExternalBuffer defaults to true and crashes under Electron's
        // V8 build ("External buffers are not allowed"). Same reason as the
        // VAD path in voice.ts.
        enableExternalBuffer: false,
        onProgress: ({ samples }) => {
          // The buffer is reused across callbacks by the native side; the copy
          // is what survives the trip over IPC.
          this.emit("chunk", Float32Array.from(samples), tts.sampleRate);
        },
      });

      const seconds = audio.samples.length / audio.sampleRate;
      this.spokenSinceCheck = true;
      this.emit("end");
      await this.awaitPlayback(seconds);
      return { characters: text.length, seconds };
    } finally {
      this.setSpeaking(false);
    }
  }

  /**
   * Waits for the renderer's acknowledgement, and no longer than the audio's
   * own duration plus a margin. Playback runs on the renderer's clock, so the
   * duration alone is a lower bound, not the answer.
   */
  private awaitPlayback(seconds: number): Promise<void> {
    return new Promise((resolve) => {
      let settled = false;
      const done = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.playbackAck = null;
        resolve();
      };

      const timer = setTimeout(() => {
        console.error("speech: playback was never acknowledged, releasing the microphone");
        done();
      }, seconds * 1000 + PLAYBACK_ACK_GRACE_MS);

      this.playbackAck = done;
    });
  }

  private async ensureLoaded(): Promise<void> {
    if (this.tts) return;
    if (!this.loadingPromise) this.loadingPromise = this.load();
    return this.loadingPromise;
  }

  private async load(): Promise<void> {
    const dir = path.join(this.modelsDir, MODEL_DIR);
    this.tts = await OfflineTts.createAsync({
      model: {
        vits: {
          model: path.join(dir, MODEL_FILE),
          tokens: path.join(dir, "tokens.txt"),
          // Piper models phonemise with espeak-ng; this directory ships with
          // the model, so no system installation is involved.
          dataDir: path.join(dir, "espeak-ng-data"),
        },
        numThreads: 2,
        debug: 0,
      },
      // One sentence per batch is what makes the progress callback fire early:
      // the first chunk is ready as soon as the first sentence is, instead of
      // after the model has worked through the whole text.
      maxNumSentences: 1,
    });
  }

  private setSpeaking(value: boolean): void {
    if (this._speaking === value) return;
    this._speaking = value;
    this.emit("speaking", value);
  }
}
