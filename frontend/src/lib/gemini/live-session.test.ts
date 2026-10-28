// Isolated tests for the session controller. Gemini, the microphone and the
// audio output are all fakes here - these do NOT exercise the real Live API.
import type { LiveCallbacks, LiveConnectConfig, LiveServerMessage, LiveSendRealtimeInputParameters } from "@google/genai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { MicrophoneOptions } from "@/lib/audio/microphone";
import { int16ToBase64 } from "@/lib/audio/pcm";
import { AgentError } from "@/lib/session/errors";
import { CONNECT_TIMEOUT_MS, MAX_AUTO_RECONNECTS, VoiceAgentSession, type LiveConnection } from "./live-session";
import type { SessionToken } from "./token";

class FakeConnection implements LiveConnection {
  sent: LiveSendRealtimeInputParameters[] = [];
  closed = false;
  constructor(
    readonly config: LiveConnectConfig,
    readonly callbacks: LiveCallbacks,
  ) {}
  sendRealtimeInput(p: LiveSendRealtimeInputParameters) {
    this.sent.push(p);
  }
  close() {
    this.closed = true;
  }
  message(msg: Partial<LiveServerMessage>) {
    this.callbacks.onmessage(msg as LiveServerMessage);
  }
  serverClose(code: number, reason = "") {
    this.callbacks.onclose?.({ code, reason } as CloseEvent);
  }
}

const flush = () => new Promise((r) => setTimeout(r, 0));

function setup(opts: { micError?: unknown; tokenError?: AgentError } = {}) {
  let clock = 1_000;
  const connections: FakeConnection[] = [];
  let mic: MicrophoneOptions | null = null;
  const micHandle = { stop: vi.fn() };
  const player = { enqueue: vi.fn(), clear: vi.fn(), close: vi.fn(), playing: false };
  let onPlayingChange: (p: boolean) => void = () => {};
  let tokenCount = 0;

  const deps = {
    now: () => clock,
    sleep: vi.fn(async () => {}),
    fetchToken: vi.fn(async (): Promise<SessionToken> => {
      if (opts.tokenError) throw opts.tokenError;
      tokenCount++;
      return {
        token: `auth_tokens/t${tokenCount}`,
        model: "gemini-3.8-live",
        apiVersion: "v1alpha",
        expireTime: "",
        newSessionExpireTime: "",
      };
    }),
    connectLive: vi.fn(async ({ config, callbacks }: { config: LiveConnectConfig; callbacks: LiveCallbacks }) => {
      const c = new FakeConnection(config, callbacks);
      connections.push(c);
      return c;
    }),
    startMicrophone: vi.fn(async (o: MicrophoneOptions) => {
      if (opts.micError) throw opts.micError;
      mic = o;
      return micHandle;
    }),
    createPlayer: vi.fn((cb: (p: boolean) => void) => {
      onPlayingChange = cb;
      return player;
    }),
  };

  const session = new VoiceAgentSession(deps);
  const phases: string[] = [];
  session.subscribe(() => {
    const p = session.getSnapshot().phase;
    if (phases[phases.length - 1] !== p) phases.push(p);
  });

  return {
    session,
    deps,
    phases,
    player,
    micHandle,
    connections,
    last: () => connections[connections.length - 1],
    snap: () => session.getSnapshot(),
    advance: (ms: number) => (clock += ms),
    speak: (level = 0.2) => mic!.onChunk({ pcm: new Int16Array([1, 2]), level }),
    micEnded: (e: AgentError) => mic!.onEnded(e),
    setPlaying: (p: boolean) => {
      player.playing = p;
      onPlayingChange(p);
    },
  };
}

async function startConnected(t: ReturnType<typeof setup>) {
  const started = t.session.start();
  await flush();
  t.last().message({ setupComplete: {} });
  await started;
}

describe("VoiceAgentSession", () => {
  it("only reports listening after Gemini confirms setup", async () => {
    const t = setup();
    const started = t.session.start();
    await flush();
    expect(t.snap().phase).toBe("connecting");
    expect(t.deps.connectLive).toHaveBeenCalledTimes(1);
    const { config } = t.deps.connectLive.mock.calls[0][0];
    expect(config.sessionResumption).toEqual({});
    expect(config.inputAudioTranscription).toEqual({});
    t.last().message({ setupComplete: {} });
    await started;
    expect(t.phases.filter((p) => p !== "idle")).toEqual(["starting-microphone", "connecting", "listening"]);
    expect(t.snap().model).toBe("gemini-3.8-live");
  });

  it("streams 16 kHz PCM only once the session is ready", async () => {
    const t = setup();
    const started = t.session.start();
    await flush();
    t.speak();
    expect(t.last().sent).toEqual([]);
    t.last().message({ setupComplete: {} });
    await started;
    t.speak();
    expect(t.last().sent).toEqual([
      { audio: { data: int16ToBase64(new Int16Array([1, 2])), mimeType: "audio/pcm;rate=16000" } },
    ]);
  });

  it("plays model audio, shows speaking, and records transcripts", async () => {
    const t = setup();
    await startConnected(t);
    t.last().message({ serverContent: { inputTranscription: { text: "What time is it?" } } });
    t.advance(1000);
    t.speak(0);
    expect(t.snap().phase).toBe("processing");

    const audio = int16ToBase64(new Int16Array([5, 6, 7]));
    t.last().message({
      serverContent: {
        modelTurn: { parts: [{ inlineData: { data: audio, mimeType: "audio/pcm;rate=24000" } }] },
        outputTranscription: { text: "It is noon." },
      },
    });
    expect(t.player.enqueue).toHaveBeenCalledWith(new Int16Array([5, 6, 7]), 24000);
    t.setPlaying(true);
    expect(t.snap().phase).toBe("speaking");

    t.last().message({ serverContent: { turnComplete: true } });
    t.setPlaying(false);
    expect(t.snap().phase).toBe("listening");
    expect(t.snap().transcript.map((e) => [e.speaker, e.text, e.status])).toEqual([
      ["user", "What time is it?", "complete"],
      ["assistant", "It is noon.", "complete"],
    ]);
  });

  it("stops playback immediately when Gemini reports an interruption", async () => {
    const t = setup();
    await startConnected(t);
    t.last().message({ serverContent: { outputTranscription: { text: "Once upon a" } } });
    t.setPlaying(true);
    t.player.clear.mockImplementation(() => t.setPlaying(false));
    t.last().message({ serverContent: { interrupted: true } });
    expect(t.player.clear).toHaveBeenCalled();
    expect(t.snap().phase).not.toBe("speaking");
    expect(t.snap().transcript[0].status).toBe("interrupted");
  });

  it("reports microphone permission errors without contacting the backend", async () => {
    const t = setup({ micError: new AgentError("mic-permission-denied", "blocked") });
    await t.session.start();
    expect(t.snap().phase).toBe("error");
    expect(t.snap().error?.code).toBe("mic-permission-denied");
    expect(t.deps.fetchToken).not.toHaveBeenCalled();
    expect(t.player.close).toHaveBeenCalled();
  });

  it("cleans up the microphone when the token request fails", async () => {
    const t = setup({ tokenError: new AgentError("backend-unreachable", "down") });
    await t.session.start();
    expect(t.snap().error?.code).toBe("backend-unreachable");
    expect(t.micHandle.stop).toHaveBeenCalled();
    expect(t.player.close).toHaveBeenCalled();
    expect(t.deps.connectLive).not.toHaveBeenCalled();
  });

  it("fails with the server's reason when the socket closes during setup", async () => {
    const t = setup();
    const started = t.session.start();
    await flush();
    t.last().serverClose(1008, "API key not valid");
    await started;
    expect(t.snap().error).toMatchObject({ code: "connection-failed", retryable: false });
    expect(t.snap().error?.message).toContain("API key not valid");
  });

  it("times out if setup never completes", async () => {
    vi.useFakeTimers();
    try {
      const t = setup();
      const started = t.session.start();
      await vi.advanceTimersByTimeAsync(CONNECT_TIMEOUT_MS + 1);
      await started;
      expect(t.snap().error?.code).toBe("connection-timeout");
      expect(t.last().closed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reconnects with the resumption handle after an unexpected close", async () => {
    const t = setup();
    await startConnected(t);
    t.last().message({ sessionResumptionUpdate: { resumable: true, newHandle: "h-1" } });
    t.last().serverClose(1011, "internal");
    expect(t.snap().phase).toBe("reconnecting");
    await flush();
    expect(t.connections).toHaveLength(2);
    expect(t.last().config.sessionResumption).toEqual({ handle: "h-1" });
    t.last().message({ setupComplete: {} });
    await flush();
    expect(t.snap().phase).toBe("listening");
    expect(t.deps.fetchToken).toHaveBeenCalledTimes(2);
  });

  it("switches sockets on goAway and closes the old one", async () => {
    const t = setup();
    await startConnected(t);
    const first = t.last();
    first.message({ sessionResumptionUpdate: { resumable: true, newHandle: "h-2" } });
    first.message({ goAway: { timeLeft: "10s" } });
    await flush();
    const second = t.last();
    expect(second).not.toBe(first);
    expect(second.config.sessionResumption).toEqual({ handle: "h-2" });
    second.message({ setupComplete: {} });
    await flush();
    expect(first.closed).toBe(true);
    expect(t.snap().phase).toBe("listening");
    // Late events from the old socket are ignored.
    first.serverClose(1000);
    expect(t.snap().phase).toBe("listening");
  });

  it("gives up after repeated reconnect failures, then recovers via reconnect()", async () => {
    const t = setup();
    await startConnected(t);
    t.deps.fetchToken.mockRejectedValue(new AgentError("backend-unreachable", "down"));
    t.last().serverClose(1011);
    for (let i = 0; i <= MAX_AUTO_RECONNECTS; i++) await flush();
    expect(t.snap().phase).toBe("error");
    expect(t.snap().error?.retryable).toBe(true);
    expect(t.deps.sleep).toHaveBeenCalledTimes(MAX_AUTO_RECONNECTS);
    expect(t.micHandle.stop).toHaveBeenCalled();

    t.deps.fetchToken.mockResolvedValue({
      token: "auth_tokens/again",
      model: "gemini-3.8-live",
      apiVersion: "v1alpha",
      expireTime: "",
      newSessionExpireTime: "",
    });
    const reconnecting = t.session.reconnect();
    await flush();
    t.last().message({ setupComplete: {} });
    await reconnecting;
    expect(t.snap().phase).toBe("listening");
  });

  it("does not retry fatal close codes", async () => {
    const t = setup();
    await startConnected(t);
    t.last().serverClose(1008, "Policy violation");
    expect(t.snap().phase).toBe("error");
    expect(t.snap().error?.retryable).toBe(false);
    expect(t.connections).toHaveLength(1);
  });

  it("releases everything on end() and ignores late messages", async () => {
    const t = setup();
    await startConnected(t);
    t.last().message({ serverContent: { outputTranscription: { text: "Hi" } } });
    t.session.end();
    expect(t.snap().phase).toBe("ended");
    expect(t.last().closed).toBe(true);
    expect(t.micHandle.stop).toHaveBeenCalled();
    expect(t.player.close).toHaveBeenCalled();
    t.last().message({ serverContent: { outputTranscription: { text: " late" } } });
    expect(t.snap().transcript[0].text).toBe("Hi");
  });

  it("stops a microphone that finishes starting after end()", async () => {
    const t = setup();
    const started = t.session.start();
    t.session.end();
    await started;
    expect(t.micHandle.stop).toHaveBeenCalled();
    expect(t.deps.fetchToken).not.toHaveBeenCalled();
    expect(t.snap().phase).toBe("ended");
  });

  it("stops sending audio while muted", async () => {
    const t = setup();
    await startConnected(t);
    t.session.setMuted(true);
    t.speak();
    expect(t.last().sent).toEqual([{ audioStreamEnd: true }]);
    t.session.setMuted(false);
    t.speak();
    expect(t.last().sent).toHaveLength(2);
  });

  it("surfaces a disconnected microphone", async () => {
    const t = setup();
    await startConnected(t);
    t.micEnded(new AgentError("mic-disconnected", "gone"));
    expect(t.snap().error?.code).toBe("mic-disconnected");
    expect(t.last().closed).toBe(true);
  });

  it("start() resets the transcript for a new conversation", async () => {
    const t = setup();
    await startConnected(t);
    t.last().message({ serverContent: { inputTranscription: { text: "one" } } });
    t.session.end();
    await startConnected(t);
    expect(t.snap().transcript).toEqual([]);
  });
});

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.useRealTimers());
