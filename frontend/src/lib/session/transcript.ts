// Pure transcript reducer. Gemini streams transcription fragments for both
// sides; we merge consecutive fragments from the same speaker into one entry.

export type Speaker = "user" | "assistant";
export type EntryStatus = "streaming" | "complete" | "interrupted";

export interface TranscriptEntry {
  id: number;
  speaker: Speaker;
  text: string;
  status: EntryStatus;
}

export type TranscriptAction =
  | { type: "fragment"; speaker: Speaker; text: string }
  | { type: "turnComplete" }
  | { type: "interrupted" }
  | { type: "reset" };

let nextId = 1;

function finalize(entries: TranscriptEntry[], status: EntryStatus = "complete") {
  return entries.map((e) => (e.status === "streaming" ? { ...e, status } : e));
}

export function transcriptReducer(
  entries: TranscriptEntry[],
  action: TranscriptAction,
): TranscriptEntry[] {
  switch (action.type) {
    case "fragment": {
      if (!action.text) return entries;
      const last = entries[entries.length - 1];
      if (last && last.speaker === action.speaker && last.status === "streaming") {
        return [...entries.slice(0, -1), { ...last, text: last.text + action.text }];
      }
      // A new speaker starts: whatever was streaming is done.
      return [
        ...finalize(entries),
        { id: nextId++, speaker: action.speaker, text: action.text, status: "streaming" },
      ];
    }
    case "turnComplete":
      return finalize(entries);
    case "interrupted":
      return entries.map((e) =>
        e.status === "streaming"
          ? { ...e, status: e.speaker === "assistant" ? "interrupted" : "complete" }
          : e,
      );
    case "reset":
      return [];
  }
}
