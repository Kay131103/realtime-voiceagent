import { describe, expect, it } from "vitest";

import { transcriptReducer, type TranscriptAction, type TranscriptEntry } from "./transcript";

const run = (actions: TranscriptAction[]) =>
  actions.reduce<TranscriptEntry[]>(transcriptReducer, []);

const simplify = (entries: TranscriptEntry[]) =>
  entries.map(({ speaker, text, status }) => ({ speaker, text, status }));

describe("transcriptReducer", () => {
  it("merges consecutive fragments from the same speaker", () => {
    const entries = run([
      { type: "fragment", speaker: "user", text: "Hello" },
      { type: "fragment", speaker: "user", text: " there" },
    ]);
    expect(simplify(entries)).toEqual([{ speaker: "user", text: "Hello there", status: "streaming" }]);
  });

  it("finalizes the user entry when the assistant starts", () => {
    const entries = run([
      { type: "fragment", speaker: "user", text: "Hi" },
      { type: "fragment", speaker: "assistant", text: "Hello!" },
      { type: "turnComplete" },
    ]);
    expect(simplify(entries)).toEqual([
      { speaker: "user", text: "Hi", status: "complete" },
      { speaker: "assistant", text: "Hello!", status: "complete" },
    ]);
  });

  it("starts a new entry for the next turn by the same speaker", () => {
    const entries = run([
      { type: "fragment", speaker: "assistant", text: "One" },
      { type: "turnComplete" },
      { type: "fragment", speaker: "assistant", text: "Two" },
    ]);
    expect(entries).toHaveLength(2);
    expect(entries[0].id).not.toBe(entries[1].id);
  });

  it("marks the assistant entry as interrupted on barge-in", () => {
    const entries = run([
      { type: "fragment", speaker: "user", text: "Tell me a story" },
      { type: "fragment", speaker: "assistant", text: "Once upon" },
      { type: "interrupted" },
      { type: "fragment", speaker: "user", text: "Stop" },
    ]);
    expect(simplify(entries)).toEqual([
      { speaker: "user", text: "Tell me a story", status: "complete" },
      { speaker: "assistant", text: "Once upon", status: "interrupted" },
      { speaker: "user", text: "Stop", status: "streaming" },
    ]);
  });

  it("ignores empty fragments and supports reset", () => {
    const entries = run([{ type: "fragment", speaker: "user", text: "" }]);
    expect(entries).toEqual([]);
    expect(transcriptReducer(run([{ type: "fragment", speaker: "user", text: "x" }]), { type: "reset" })).toEqual(
      [],
    );
  });
});
