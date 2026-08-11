// Captures the microphone in the renderer (the main process has no web APIs)
// and streams mono 16 kHz PCM16 chunks to the main process over IPC, where
// the wake word and transcription models run.
const SAMPLE_RATE = 16000;

let audioContext: AudioContext | null = null;
let mediaStream: MediaStream | null = null;
let workletNode: AudioWorkletNode | null = null;

export async function startVoiceCapture(): Promise<void> {
  if (audioContext) return;

  // echoCancellation specifically engages macOS's shared Voice Processing I/O
  // audio unit. Apple confirms two apps requesting it on the same input can
  // starve each other's stream (https://developer.apple.com/forums/thread/751100)
  // — exactly the case with a video call or Discord running at the same time.
  // autoGainControl is a separate, per-app software stage with no such
  // conflict; leaving it off produced unusably quiet raw samples (measured
  // ~25-40 RMS of 32767 at rest, only ~100-200 while speaking) on this
  // machine's built-in mic, so it stays on.
  mediaStream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: true },
  });

  // The context resamples any source to this rate on its own; the mic's
  // native rate (commonly 48 kHz) never needs handling here.
  audioContext = new AudioContext({ sampleRate: SAMPLE_RATE });
  await audioContext.audioWorklet.addModule("voice-worklet.js");

  const source = audioContext.createMediaStreamSource(mediaStream);
  workletNode = new AudioWorkletNode(audioContext, "voice-capture");
  workletNode.port.onmessage = (event: MessageEvent<Float32Array>) => {
    window.vm.sendAudioChunk(toInt16(event.data).buffer as ArrayBuffer);
  };

  // A worklet with no path to the destination is not guaranteed to be pulled.
  // Route through a muted gain node instead of leaving the mic unconnected.
  const silence = audioContext.createGain();
  silence.gain.value = 0;
  source.connect(workletNode).connect(silence).connect(audioContext.destination);
}

export function stopVoiceCapture(): void {
  workletNode?.port.close();
  workletNode?.disconnect();
  workletNode = null;
  void audioContext?.close();
  audioContext = null;
  for (const track of mediaStream?.getTracks() ?? []) track.stop();
  mediaStream = null;
}

function toInt16(samples: Float32Array): Int16Array {
  const out = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i] ?? 0));
    out[i] = clamped < 0 ? clamped * 32768 : clamped * 32767;
  }
  return out;
}
