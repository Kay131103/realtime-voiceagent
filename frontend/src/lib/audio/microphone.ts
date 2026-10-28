import { AgentError, microphoneError } from "@/lib/session/errors";
import { INPUT_SAMPLE_RATE, floatToInt16, resample, rms } from "./pcm";

export interface MicrophoneChunk {
  /** 16 kHz mono PCM16 ready to send to Gemini. */
  pcm: Int16Array;
  /** RMS level of the chunk in [0, 1]. */
  level: number;
}

export interface MicrophoneHandle {
  stop(): void;
}

export interface MicrophoneOptions {
  onChunk(chunk: MicrophoneChunk): void;
  /** Called if the device goes away mid-session (unplugged, permission revoked). */
  onEnded(error: AgentError): void;
}

export type StartMicrophone = (options: MicrophoneOptions) => Promise<MicrophoneHandle>;

export const startMicrophone: StartMicrophone = async ({ onChunk, onEnded }) => {
  if (typeof window === "undefined" || !navigator.mediaDevices?.getUserMedia) {
    throw new AgentError(
      "mic-unsupported",
      "This browser cannot capture audio here. Use a current browser over https:// or http://localhost.",
      false,
    );
  }

  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        // Echo cancellation keeps the assistant's own voice from triggering barge-in.
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
  } catch (err) {
    throw microphoneError(err);
  }

  // Use the device's native rate (Firefox refuses to mix rates) and resample ourselves.
  const context = new AudioContext();
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    stream.getTracks().forEach((t) => t.stop());
    void context.close().catch(() => {});
  };

  try {
    await context.audioWorklet.addModule("/audio-capture-worklet.js");
    const source = context.createMediaStreamSource(stream);
    const worklet = new AudioWorkletNode(context, "capture-processor");
    // A muted sink keeps the graph pulled in every browser without echoing the mic.
    const sink = context.createGain();
    sink.gain.value = 0;
    source.connect(worklet).connect(sink).connect(context.destination);

    worklet.port.onmessage = (event: MessageEvent<Float32Array>) => {
      if (stopped) return;
      const samples = resample(event.data, context.sampleRate, INPUT_SAMPLE_RATE);
      onChunk({ pcm: floatToInt16(samples), level: rms(event.data) });
    };
    if (context.state === "suspended") await context.resume();
  } catch (err) {
    stop();
    throw new AgentError(
      "mic-unsupported",
      `Could not start audio processing: ${err instanceof Error ? err.message : String(err)}`,
      false,
    );
  }

  stream.getAudioTracks().forEach((track) =>
    track.addEventListener("ended", () => {
      if (stopped) return;
      stop();
      onEnded(new AgentError("mic-disconnected", "The microphone was disconnected."));
    }),
  );

  return { stop };
};
