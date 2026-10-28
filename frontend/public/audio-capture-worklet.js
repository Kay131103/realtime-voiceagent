// AudioWorklet that batches microphone frames (128 samples per render quantum)
// into ~40 ms chunks and hands them to the main thread for resampling/encoding.
class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.chunkSize = Math.round(sampleRate * 0.04);
    this.buffer = new Float32Array(this.chunkSize);
    this.offset = 0;
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (channel) {
      let read = 0;
      while (read < channel.length) {
        const n = Math.min(channel.length - read, this.chunkSize - this.offset);
        this.buffer.set(channel.subarray(read, read + n), this.offset);
        this.offset += n;
        read += n;
        if (this.offset === this.chunkSize) {
          this.port.postMessage(this.buffer, [this.buffer.buffer]);
          this.buffer = new Float32Array(this.chunkSize);
          this.offset = 0;
        }
      }
    }
    return true;
  }
}

registerProcessor("capture-processor", CaptureProcessor);
