"use client";

import { useEffect, useRef } from "react";

import type { TranscriptEntry } from "@/lib/session/transcript";

export function Transcript({ entries }: { entries: TranscriptEntry[] }) {
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [entries]);

  return (
    <section className="flex min-h-0 flex-1 flex-col rounded-2xl border border-zinc-800 bg-zinc-900/60">
      <h2 className="border-b border-zinc-800 px-4 py-3 text-sm font-medium text-zinc-300">Transcript</h2>
      <div className="flex-1 space-y-3 overflow-y-auto p-4" aria-live="polite">
        {entries.length === 0 ? (
          <p className="text-sm text-zinc-500">The conversation transcript will appear here.</p>
        ) : (
          entries.map((e) => (
            <div key={e.id} className={`flex ${e.speaker === "user" ? "justify-end" : "justify-start"}`}>
              <div
                className={`max-w-[85%] rounded-2xl px-4 py-2 text-sm leading-relaxed ${
                  e.speaker === "user" ? "bg-emerald-600/20 text-emerald-50" : "bg-zinc-800 text-zinc-100"
                } ${e.status === "streaming" ? "opacity-80" : ""}`}
              >
                <span className="mb-0.5 block text-[11px] font-medium uppercase tracking-wide text-zinc-400">
                  {e.speaker === "user" ? "You" : "Gemini"}
                </span>
                {e.text.trim()}
                {e.status === "interrupted" ? (
                  <span className="ml-1 text-xs italic text-zinc-400">(interrupted)</span>
                ) : null}
              </div>
            </div>
          ))
        )}
        <div ref={endRef} />
      </div>
    </section>
  );
}
