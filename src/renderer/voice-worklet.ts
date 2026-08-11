// Runs on the audio rendering thread, not the renderer's main thread: buffers
// 128-sample Web Audio render quanta into ~256 ms blocks before handing them
// off, so the main thread gets a few messages per second instead of ~125.
const CHUNK_SAMPLES = 4096;

class VoiceCaptureProcessor extends AudioWorkletProcessor {
  private buffer = new Float32Array(CHUNK_SAMPLES);
  private filled = 0;

  process(inputs: Float32Array[][]): boolean {
    const channel = inputs[0]?.[0];
    if (!channel) return true;

    let offset = 0;
    while (offset < channel.length) {
      const take = Math.min(CHUNK_SAMPLES - this.filled, channel.length - offset);
      this.buffer.set(channel.subarray(offset, offset + take), this.filled);
      this.filled += take;
      offset += take;

      if (this.filled === CHUNK_SAMPLES) {
        this.port.postMessage(this.buffer.slice());
        this.filled = 0;
      }
    }
    return true;
  }
}

registerProcessor("voice-capture", VoiceCaptureProcessor);
