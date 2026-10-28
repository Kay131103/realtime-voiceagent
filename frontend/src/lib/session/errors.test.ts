import { describe, expect, it } from "vitest";

import { AgentError, microphoneError, toAgentError } from "./errors";

const domError = (name: string) => new DOMException("x", name);

describe("microphoneError", () => {
  it.each([
    ["NotAllowedError", "mic-permission-denied"],
    ["SecurityError", "mic-permission-denied"],
    ["NotFoundError", "mic-not-found"],
    ["NotReadableError", "mic-in-use"],
  ])("maps %s to %s", (name, code) => {
    const err = microphoneError(domError(name));
    expect(err.code).toBe(code);
    expect(err.message.length).toBeGreaterThan(10);
  });

  it("falls back to unknown", () => {
    expect(microphoneError(new Error("weird")).code).toBe("unknown");
  });
});

describe("toAgentError", () => {
  it("passes AgentErrors through and wraps others", () => {
    const agentError = new AgentError("token-failed", "nope");
    expect(toAgentError(agentError)).toBe(agentError);
    expect(toAgentError(new Error("boom"))).toMatchObject({ code: "unknown", message: "boom" });
    expect(toAgentError("str").message).toBe("str");
  });
});
