// Plays the audio synthesised in the main process, which has no web APIs of its
// own. Chunks arrive over IPC as the model produces them and are scheduled back
// to back on the audio clock, so the utterance plays as one continuous stretch
// rather than a chunk at a time.

// Cushion between "the chunk arrived" and "the chunk starts playing". The model
// runs ahead of playback once it is going (real-time factor around 0.36 on this
// machine), but the first sentence is short and the second one is not ready the
// instant the first ends. Without this the gap lands as a click; with it, as a
// pause at a sentence boundary, where a pause belongs.
const SCHEDULE_LEAD_SECONDS = 0.15;

let context: AudioContext | null = null;
let nextStartAt = 0;
let pending = 0;
let ended = false;

/**
 * Wires playback to the main process. Called once at startup: the audio context
 * is created on the first chunk, not here, so nothing is allocated in a session
 * where the master session never speaks.
 */
export function startSpeechPlayback(): void {
  window.vm.onSpeechChunk((samples, sampleRate) => {
    play(samples, sampleRate);
  });

  window.vm.onSpeechEnd(() => {
    ended = true;
    // Generation can finish after the last chunk has already drained — a single
    // very short utterance, or audio that failed to schedule at all.
    if (pending === 0) reportFinished();
  });
}

function play(samples: Float32Array<ArrayBuffer>, sampleRate: number): void {
  try {
    // The context is created at the model's own rate so the samples are handed
    // over untouched; the device resamples downstream. A separate context from
    // the capture one, which runs at 16 kHz — a context has a single rate.
    if (!context || context.sampleRate !== sampleRate) {
      void context?.close();
      context = new AudioContext({ sampleRate });
      nextStartAt = 0;
    }

    const buffer = context.createBuffer(1, samples.length, sampleRate);
    buffer.copyToChannel(samples, 0);

    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(context.destination);

    // Falling behind the clock means the previous chunk has already finished:
    // start from now instead of scheduling into the past, which would play the
    // chunk immediately and overlap the tail of whatever is still sounding.
    const earliest = context.currentTime + SCHEDULE_LEAD_SECONDS;
    const startAt = Math.max(nextStartAt, earliest);
    nextStartAt = startAt + buffer.duration;

    pending += 1;
    source.onended = () => {
      pending -= 1;
      if (ended && pending === 0) reportFinished();
    };
    source.start(startAt);
  } catch (error) {
    console.error("speech: could not play the synthesised audio", error);
    // The main process is waiting on this to reopen the microphone. Staying
    // quiet here would leave it muted until the grace period expires.
    if (ended) reportFinished();
  }
}

function reportFinished(): void {
  ended = false;
  nextStartAt = 0;
  window.vm.notifySpeechFinished();
}
