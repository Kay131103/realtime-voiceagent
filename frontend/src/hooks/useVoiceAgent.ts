"use client";

import { useEffect, useState, useSyncExternalStore } from "react";

import { VoiceAgentSession } from "@/lib/gemini/live-session";

export function useVoiceAgent() {
  const [session] = useState(() => new VoiceAgentSession());
  const snapshot = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);

  useEffect(() => {
    const onPageHide = () => session.end();
    window.addEventListener("pagehide", onPageHide);
    return () => {
      window.removeEventListener("pagehide", onPageHide);
      // Release mic, audio and socket when the component unmounts.
      if (session.active) session.end();
    };
  }, [session]);

  return {
    ...snapshot,
    start: () => void session.start(),
    end: () => session.end(),
    reconnect: () => void session.reconnect(),
    setMuted: (muted: boolean) => session.setMuted(muted),
  };
}
