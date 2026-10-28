import { OUTPUT_SAMPLE_RATE, int16ToFloat } from "./pcm";

export interface AudioPlayer {
  /** Queue a PCM16 chunk for gapless playback. */
  enqueue(pcm: Int16Array, sampleRate?: number): void;
  /** Stop everything immediately (used on barge-in / interruption). */
  clear(): void;
  readonly playing: boolean;
  close(): void;
}

export type CreatePlayer = (onPlayingChange: (playing: boolean) => void) => AudioPlayer;

/**
 * Schedules each chunk back-to-back on the AudioContext clock. Must be created
 * from a user gesture (the Start click) so the browser allows audio output.
 */
export const createPlayer: CreatePlayer = (onPlayingChange) => {
  const context = new AudioContext();
  void context.resume().catch(() => {});
  const sources = new Set<AudioBufferSourceNode>();
  let nextStart = 0;
  let playing = false;
  let closed = false;

  const setPlaying = (value: boolean) => {
    if (playing === value) return;
    playing = value;
    onPlayingChange(value);
  };

  return {
    get playing() {
      return playing;
    },
    enqueue(pcm, sampleRate = OUTPUT_SAMPLE_RATE) {
      if (closed || pcm.length === 0) return;
      const buffer = context.createBuffer(1, pcm.length, sampleRate);
      buffer.copyToChannel(int16ToFloat(pcm) as Float32Array<ArrayBuffer>, 0);
      const source = context.createBufferSource();
      source.buffer = buffer;
      source.connect(context.destination);
      // Small lead time absorbs network jitter when the queue has drained.
      nextStart = Math.max(nextStart, context.currentTime + 0.05);
      source.start(nextStart);
      nextStart += buffer.duration;
      sources.add(source);
      setPlaying(true);
      source.onended = () => {
        sources.delete(source);
        if (sources.size === 0) setPlaying(false);
      };
    },
    clear() {
      for (const source of sources) {
        source.onended = null;
        try {
          source.stop();
        } catch {
          // already stopped
        }
        source.disconnect();
      }
      sources.clear();
      nextStart = 0;
      setPlaying(false);
    },
    close() {
      if (closed) return;
      this.clear();
      closed = true;
      void context.close().catch(() => {});
    },
  };
};
