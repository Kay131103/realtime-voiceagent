"use client";

import { useVoiceAgent } from "@/hooks/useVoiceAgent";
import { StatusIndicator } from "./StatusIndicator";
import { Transcript } from "./Transcript";

const button =
  "rounded-full px-6 py-2.5 text-sm font-semibold transition focus-visible:outline-2 focus-visible:outline-offset-2 disabled:cursor-not-allowed disabled:opacity-50";

export function VoiceAgent() {
  const agent = useVoiceAgent();
  const { phase, error } = agent;

  const busy = phase === "starting-microphone" || phase === "connecting" || phase === "reconnecting";
  const inConversation = busy || phase === "listening" || phase === "processing" || phase === "speaking";
  const canResume = phase === "error" && error?.retryable;

  return (
    <div className="mx-auto flex h-full w-full max-w-3xl flex-col gap-6 px-4 py-8">
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-2xl font-bold tracking-tight text-zinc-50">Gemini Voice Agent</h1>
        <p className="text-xs text-zinc-500">
          {agent.model ? `Model: ${agent.model}` : "Real-time voice via the Gemini Live API"}
        </p>
      </header>

      <section className="flex flex-col items-center gap-6 rounded-2xl border border-zinc-800 bg-zinc-900/60 p-6">
        <StatusIndicator
          phase={phase}
          userSpeaking={agent.userSpeaking}
          micLevel={agent.micLevel}
          muted={agent.muted}
        />

        {phase === "reconnecting" && agent.reconnectAttempt > 0 ? (
          <p className="text-xs text-amber-300">Retry {agent.reconnectAttempt}…</p>
        ) : null}

        {error ? (
          <div role="alert" data-testid="error-banner" className="w-full rounded-xl border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-200">
            {error.message}
          </div>
        ) : null}

        <div className="flex flex-wrap justify-center gap-3">
          {inConversation ? (
            <>
              <button
                type="button"
                onClick={() => agent.setMuted(!agent.muted)}
                disabled={busy}
                className={`${button} bg-zinc-800 text-zinc-100 hover:bg-zinc-700 focus-visible:outline-zinc-400`}
              >
                {agent.muted ? "Unmute" : "Mute"}
              </button>
              <button
                type="button"
                onClick={agent.end}
                className={`${button} bg-red-600 text-white hover:bg-red-500 focus-visible:outline-red-400`}
              >
                End Conversation
              </button>
            </>
          ) : (
            <>
              {canResume ? (
                <button
                  type="button"
                  onClick={agent.reconnect}
                  className={`${button} bg-amber-500 text-zinc-950 hover:bg-amber-400 focus-visible:outline-amber-300`}
                >
                  Reconnect
                </button>
              ) : null}
              <button
                type="button"
                onClick={agent.start}
                className={`${button} bg-emerald-500 text-zinc-950 hover:bg-emerald-400 focus-visible:outline-emerald-300`}
              >
                {phase === "idle" ? "Start Conversation" : "Start New Conversation"}
              </button>
            </>
          )}
        </div>
        <p className="text-center text-xs text-zinc-500">
          Tip: use headphones to keep Gemini from hearing itself.
        </p>
      </section>

      <Transcript entries={agent.transcript} />
    </div>
  );
}
