import type { Phase } from "@/lib/gemini/live-session";

const PHASES: Record<Phase, { label: string; hint: string; dot: string; ring: string }> = {
  idle: { label: "Ready", hint: "Press Start to talk to Gemini.", dot: "bg-zinc-500", ring: "ring-zinc-700" },
  "starting-microphone": {
    label: "Requesting microphone",
    hint: "Allow microphone access in your browser prompt.",
    dot: "bg-amber-400 animate-pulse",
    ring: "ring-amber-500/40",
  },
  connecting: {
    label: "Connecting",
    hint: "Opening a live session with Gemini…",
    dot: "bg-amber-400 animate-pulse",
    ring: "ring-amber-500/40",
  },
  listening: { label: "Listening", hint: "Go ahead and speak.", dot: "bg-emerald-400", ring: "ring-emerald-500/50" },
  processing: {
    label: "Thinking",
    hint: "Gemini is preparing a reply.",
    dot: "bg-sky-400 animate-pulse",
    ring: "ring-sky-500/50",
  },
  speaking: {
    label: "Speaking",
    hint: "Speak at any time to interrupt.",
    dot: "bg-violet-400",
    ring: "ring-violet-500/60",
  },
  reconnecting: {
    label: "Reconnecting",
    hint: "The connection dropped; resuming the conversation…",
    dot: "bg-amber-400 animate-pulse",
    ring: "ring-amber-500/40",
  },
  error: { label: "Error", hint: "See the message below.", dot: "bg-red-500", ring: "ring-red-500/50" },
  ended: { label: "Conversation ended", hint: "Press Start to begin a new one.", dot: "bg-zinc-500", ring: "ring-zinc-700" },
};

export function StatusIndicator({
  phase,
  userSpeaking,
  micLevel,
  muted,
}: {
  phase: Phase;
  userSpeaking: boolean;
  micLevel: number;
  muted: boolean;
}) {
  const info = PHASES[phase];
  const live = phase === "listening" || phase === "processing" || phase === "speaking";
  const label = phase === "listening" && userSpeaking ? "Hearing you" : info.label;

  return (
    <div className="flex flex-col items-center gap-4" role="status" aria-live="polite">
      <div
        className={`relative flex h-36 w-36 items-center justify-center rounded-full bg-zinc-900 ring-8 transition-all duration-300 ${info.ring}`}
        style={live && !muted ? { transform: `scale(${1 + micLevel * 0.15})` } : undefined}
      >
        <span
          className={`h-14 w-14 rounded-full transition-colors ${info.dot} ${phase === "speaking" ? "animate-pulse" : ""}`}
        />
        {phase === "connecting" || phase === "reconnecting" || phase === "starting-microphone" ? (
          <span className="absolute inset-0 animate-spin rounded-full border-4 border-transparent border-t-amber-400" />
        ) : null}
      </div>
      <div className="text-center">
        <p className="text-lg font-semibold text-zinc-100" data-testid="phase-label">
          {label}
          {live && muted ? " (muted)" : ""}
        </p>
        <p className="text-sm text-zinc-400">{info.hint}</p>
      </div>
      {live ? (
        <div className="h-1.5 w-40 overflow-hidden rounded-full bg-zinc-800" aria-label="Microphone level">
          <div
            className="h-full rounded-full bg-emerald-400 transition-[width] duration-75"
            style={{ width: `${muted ? 0 : Math.round(micLevel * 100)}%` }}
          />
        </div>
      ) : null}
    </div>
  );
}
