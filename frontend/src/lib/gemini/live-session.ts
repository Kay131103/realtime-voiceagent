import {
  GoogleGenAI,
  Modality,
  VoiceActivityType,
  type LiveCallbacks,
  type LiveConnectConfig,
  type LiveSendRealtimeInputParameters,
  type LiveServerMessage,
} from "@google/genai";

import { startMicrophone, type MicrophoneHandle, type StartMicrophone } from "@/lib/audio/microphone";
import { INPUT_SAMPLE_RATE, base64ToInt16, int16ToBase64, sampleRateFromMime } from "@/lib/audio/pcm";
import { createPlayer, type AudioPlayer, type CreatePlayer } from "@/lib/audio/player";
import { AgentError, toAgentError } from "@/lib/session/errors";
import {
  transcriptReducer,
  type TranscriptAction,
  type TranscriptEntry,
} from "@/lib/session/transcript";
import { fetchSessionToken, type FetchToken, type SessionToken } from "./token";

export type Phase =
  | "idle"
  | "starting-microphone"
  | "connecting"
  | "listening"
  | "processing"
  | "speaking"
  | "reconnecting"
  | "error"
  | "ended";

export interface SessionSnapshot {
  phase: Phase;
  /** True while the user's voice is detected (server VAD or local level). */
  userSpeaking: boolean;
  muted: boolean;
  /** Mic RMS level in [0, 1], quantised to limit re-renders. */
  micLevel: number;
  error: AgentError | null;
  transcript: TranscriptEntry[];
  reconnectAttempt: number;
  model: string | null;
}

/** The subset of the SDK's Session we use; lets tests substitute a fake. */
export interface LiveConnection {
  sendRealtimeInput(params: LiveSendRealtimeInputParameters): void;
  close(): void;
}

export type ConnectLive = (args: {
  token: SessionToken;
  config: LiveConnectConfig;
  callbacks: LiveCallbacks;
}) => Promise<LiveConnection>;

export const connectGeminiLive: ConnectLive = ({ token, config, callbacks }) => {
  // The ephemeral token goes where an API key would; the SDK detects the
  // "auth_tokens/" prefix and uses the constrained, token-authenticated endpoint.
  const ai = new GoogleGenAI({ apiKey: token.token, httpOptions: { apiVersion: token.apiVersion } });
  return ai.live.connect({ model: token.model, config, callbacks });
};

export interface SessionDeps {
  fetchToken: FetchToken;
  connectLive: ConnectLive;
  startMicrophone: StartMicrophone;
  createPlayer: CreatePlayer;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

export const CONNECT_TIMEOUT_MS = 15_000;
export const MAX_AUTO_RECONNECTS = 3;
const SPEECH_LEVEL = 0.02;
const SPEECH_HANG_MS = 400;
const AWAIT_REPLY_TIMEOUT_MS = 15_000;
// 1007 (invalid payload) and 1008 (policy) mean the request itself is wrong
// (bad token, model or config); retrying would fail the same way.
const FATAL_CLOSE_CODES = new Set([1007, 1008]);

const defaultDeps: SessionDeps = {
  fetchToken: fetchSessionToken,
  connectLive: connectGeminiLive,
  startMicrophone,
  createPlayer,
  now: () => Date.now(),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

const initialSnapshot: SessionSnapshot = {
  phase: "idle",
  userSpeaking: false,
  muted: false,
  micLevel: 0,
  error: null,
  transcript: [],
  reconnectAttempt: 0,
  model: null,
};

/**
 * Owns one voice conversation: microphone, playback, the Live WebSocket and
 * reconnection. UI code subscribes to snapshots and calls start/end/reconnect.
 */
export class VoiceAgentSession {
  private deps: SessionDeps;
  private snapshot: SessionSnapshot = initialSnapshot;
  private listeners = new Set<() => void>();

  private mic: MicrophoneHandle | null = null;
  private player: AudioPlayer | null = null;
  private connection: LiveConnection | null = null;
  /** Bumped on start/end: async steps of an abandoned conversation bail out. */
  private sessionId = 0;
  /** Bumped per socket: callbacks from stale sockets are ignored. */
  private connectionId = 0;
  private ready = false;
  private resumeHandle: string | undefined;
  private lastVoiceAt = 0;
  private serverUserSpeaking = false;
  private awaitingReplySince: number | null = null;

  constructor(deps: Partial<SessionDeps> = {}) {
    this.deps = { ...defaultDeps, ...deps };
  }

  // ---- external store API (useSyncExternalStore) ----
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  getSnapshot = () => this.snapshot;

  get active() {
    return !["idle", "error", "ended"].includes(this.snapshot.phase);
  }

  /** Start a new conversation. Call from a click handler (audio needs a user gesture). */
  async start() {
    if (this.active) return;
    this.resumeHandle = undefined;
    this.update({ transcript: [], reconnectAttempt: 0, model: null });
    await this.open();
  }

  /** Reconnect after an error, resuming the previous conversation when possible. */
  async reconnect() {
    if (this.active) return;
    this.update({ reconnectAttempt: 0 });
    await this.open();
  }

  /** End the conversation and release every resource. */
  end() {
    this.teardown();
    this.update({ phase: "ended", error: null, userSpeaking: false, micLevel: 0 });
  }

  setMuted(muted: boolean) {
    this.update({ muted });
    if (muted) this.send({ audioStreamEnd: true });
  }

  // ---- lifecycle ----

  private async open() {
    const gen = ++this.sessionId;
    this.update({ phase: "starting-microphone", error: null });
    // Create the player synchronously, inside the user gesture.
    this.player = this.deps.createPlayer(() => this.recompute());

    try {
      this.mic = await this.deps.startMicrophone({
        onChunk: ({ pcm, level }) => this.onMicChunk(pcm, level),
        onEnded: (err) => this.fail(err),
      });
    } catch (err) {
      if (gen === this.sessionId) this.fail(toAgentError(err));
      return;
    }
    if (gen !== this.sessionId) {
      // end() was called while the permission prompt was open.
      this.mic.stop();
      this.mic = null;
      return;
    }
    await this.connectWithRetry("connecting");
  }

  private async connectWithRetry(phase: "connecting" | "reconnecting") {
    for (;;) {
      const gen = this.sessionId;
      try {
        await this.connect(phase);
        this.update({ reconnectAttempt: 0 });
        return;
      } catch (err) {
        if (gen !== this.sessionId) return; // ended meanwhile
        const error = toAgentError(err);
        const attempt = this.snapshot.reconnectAttempt;
        if (phase === "reconnecting" && error.retryable && attempt < MAX_AUTO_RECONNECTS) {
          this.update({ reconnectAttempt: attempt + 1 });
          await this.deps.sleep(500 * 2 ** attempt);
          if (gen !== this.sessionId) return;
          continue;
        }
        this.fail(error);
        return;
      }
    }
  }

  private async connect(phase: "connecting" | "reconnecting") {
    const gen = ++this.connectionId;
    this.ready = false;
    this.update({ phase });

    const token = await this.deps.fetchToken();
    if (gen !== this.connectionId) return;

    let resolveReady!: () => void;
    let rejectReady!: (e: AgentError) => void;
    const readyPromise = new Promise<void>((res, rej) => {
      resolveReady = res;
      rejectReady = rej;
    });

    const usedHandle = this.resumeHandle;
    const callbacks: LiveCallbacks = {
      onmessage: (msg) => {
        if (gen !== this.connectionId) return;
        if (msg.setupComplete) resolveReady();
        this.onMessage(msg);
      },
      onerror: () => {
        // Details arrive with the close event that always follows.
      },
      onclose: (event) => {
        if (gen !== this.connectionId) return;
        if (!this.ready) {
          rejectReady(closeError(event, "connection-failed"));
          return;
        }
        this.onUnexpectedClose(event);
      },
    };

    const config: LiveConnectConfig = {
      responseModalities: [Modality.AUDIO],
      inputAudioTranscription: {},
      outputAudioTranscription: {},
      // Always opt in so the server sends resumption handles.
      sessionResumption: usedHandle ? { handle: usedHandle } : {},
    };

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, rej) => {
      timer = setTimeout(
        () =>
          rej(new AgentError("connection-timeout", "Timed out connecting to Gemini. Check your network and try again.")),
        CONNECT_TIMEOUT_MS,
      );
    });

    const opened: { connection?: LiveConnection } = {};
    try {
      const connecting = this.deps.connectLive({ token, config, callbacks }).then((c) => {
        opened.connection = c;
        // Resolved after we gave up on this attempt: don't leak the socket.
        if (gen !== this.connectionId) c.close();
      });
      await Promise.race([connecting.then(() => readyPromise), timeout]);
    } catch (err) {
      this.connectionId++; // invalidate this attempt's callbacks
      // The resume handle may have expired; start fresh next time.
      if (usedHandle) this.resumeHandle = undefined;
      opened.connection?.close();
      throw err instanceof AgentError
        ? err
        : new AgentError("connection-failed", `Could not connect to Gemini: ${toAgentError(err).message}`);
    } finally {
      clearTimeout(timer);
    }
    if (gen !== this.connectionId || !opened.connection) return;

    this.connection = opened.connection;
    this.ready = true;
    this.update({ model: token.model });
    this.recompute(true);
  }

  private onUnexpectedClose(event: CloseEvent) {
    this.ready = false;
    this.connection = null;
    this.player?.clear();
    if (FATAL_CLOSE_CODES.has(event.code)) {
      this.fail(closeError(event, "connection-lost", false));
      return;
    }
    void this.connectWithRetry("reconnecting");
  }

  /** Planned reconnect: the server announced it will close the socket soon. */
  private reconnectNow() {
    const old = this.connection;
    this.connection = null;
    this.ready = false;
    void this.connectWithRetry("reconnecting").finally(() => {
      // Close the old socket after the switch; its callbacks are already ignored.
      old?.close();
    });
  }

  private teardown() {
    this.sessionId++;
    this.connectionId++;
    this.ready = false;
    this.connection?.close();
    this.connection = null;
    this.mic?.stop();
    this.mic = null;
    this.player?.close();
    this.player = null;
    this.awaitingReplySince = null;
    this.serverUserSpeaking = false;
  }

  private fail(error: AgentError) {
    this.teardown();
    this.dispatch({ type: "turnComplete" });
    this.update({ phase: "error", error, userSpeaking: false, micLevel: 0 });
  }

  // ---- streaming ----

  private onMicChunk(pcm: Int16Array, level: number) {
    const now = this.deps.now();
    if (level > SPEECH_LEVEL && !this.snapshot.muted) this.lastVoiceAt = now;
    if (!this.snapshot.muted) {
      this.send({
        audio: { data: int16ToBase64(pcm), mimeType: `audio/pcm;rate=${INPUT_SAMPLE_RATE}` },
      });
    }
    const micLevel = this.snapshot.muted ? 0 : Math.round(Math.min(1, level * 8) * 20) / 20;
    if (micLevel !== this.snapshot.micLevel) this.update({ micLevel });
    this.recompute();
  }

  private send(params: LiveSendRealtimeInputParameters) {
    if (!this.ready || !this.connection) return;
    try {
      this.connection.sendRealtimeInput(params);
    } catch {
      // Socket is closing; onclose will drive reconnection.
    }
  }

  private onMessage(msg: LiveServerMessage) {
    const now = this.deps.now();

    const update = msg.sessionResumptionUpdate;
    if (update?.resumable && update.newHandle) this.resumeHandle = update.newHandle;

    const activity = msg.voiceActivity?.voiceActivityType;
    if (activity === VoiceActivityType.ACTIVITY_START) this.serverUserSpeaking = true;
    if (activity === VoiceActivityType.ACTIVITY_END) {
      this.serverUserSpeaking = false;
      this.awaitingReplySince = now;
    }

    const content = msg.serverContent;
    if (content) {
      if (content.interrupted) {
        // Barge-in: drop queued audio immediately so the user is heard.
        this.player?.clear();
        this.dispatch({ type: "interrupted" });
        this.awaitingReplySince = now;
      }
      if (content.inputTranscription?.text) {
        this.dispatch({ type: "fragment", speaker: "user", text: content.inputTranscription.text });
        this.awaitingReplySince = now;
      }
      for (const part of content.modelTurn?.parts ?? []) {
        const data = part.inlineData;
        if (data?.data && data.mimeType?.startsWith("audio/")) {
          this.player?.enqueue(base64ToInt16(data.data), sampleRateFromMime(data.mimeType));
          this.awaitingReplySince = null;
        }
      }
      if (content.outputTranscription?.text) {
        this.dispatch({ type: "fragment", speaker: "assistant", text: content.outputTranscription.text });
        this.awaitingReplySince = null;
      }
      if (content.turnComplete) {
        this.dispatch({ type: "turnComplete" });
        this.awaitingReplySince = null;
      }
    }

    this.recompute();
    if (msg.goAway) this.reconnectNow();
  }

  private dispatch(action: TranscriptAction) {
    const transcript = transcriptReducer(this.snapshot.transcript, action);
    if (transcript !== this.snapshot.transcript) this.update({ transcript });
  }

  /** Derive listening / processing / speaking from the live signals. */
  private recompute(force = false) {
    if (!this.ready) return;
    const phase = this.snapshot.phase;
    if (!force && !["listening", "processing", "speaking"].includes(phase)) return;

    const now = this.deps.now();
    if (this.awaitingReplySince !== null && now - this.awaitingReplySince > AWAIT_REPLY_TIMEOUT_MS) {
      this.awaitingReplySince = null;
    }
    const userSpeaking =
      !this.snapshot.muted && (this.serverUserSpeaking || now - this.lastVoiceAt < SPEECH_HANG_MS);

    let next: Phase = "listening";
    if (this.player?.playing) next = "speaking";
    else if (this.awaitingReplySince !== null && !userSpeaking) next = "processing";

    if (next !== phase || userSpeaking !== this.snapshot.userSpeaking) {
      this.update({ phase: next, userSpeaking });
    }
  }

  private update(patch: Partial<SessionSnapshot>) {
    this.snapshot = { ...this.snapshot, ...patch };
    this.listeners.forEach((l) => l());
  }
}

function closeError(event: CloseEvent, code: "connection-failed" | "connection-lost", retryable = true) {
  const reason = event.reason ? `: ${event.reason}` : "";
  const fatal = FATAL_CLOSE_CODES.has(event.code);
  const message =
    code === "connection-failed"
      ? `Gemini closed the connection (code ${event.code})${reason}`
      : `Lost the connection to Gemini (code ${event.code})${reason}`;
  return new AgentError(code, message, retryable && !fatal);
}
