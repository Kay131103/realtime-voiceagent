// User-facing error model. Every failure path in the session maps to one of these.

export type AgentErrorCode =
  | "mic-permission-denied"
  | "mic-not-found"
  | "mic-in-use"
  | "mic-unsupported"
  | "mic-disconnected"
  | "backend-unreachable"
  | "token-failed"
  | "rate-limited"
  | "connection-failed"
  | "connection-timeout"
  | "connection-lost"
  | "unknown";

export class AgentError extends Error {
  constructor(
    readonly code: AgentErrorCode,
    message: string,
    /** Whether "Reconnect" / "Try again" makes sense for this error. */
    readonly retryable = true,
  ) {
    super(message);
    this.name = "AgentError";
  }
}

export function microphoneError(err: unknown): AgentError {
  const name = err instanceof DOMException || err instanceof Error ? err.name : "";
  switch (name) {
    case "NotAllowedError":
    case "SecurityError":
      return new AgentError(
        "mic-permission-denied",
        "Microphone access was blocked. Allow microphone access for this site in your browser settings, then try again.",
      );
    case "NotFoundError":
    case "OverconstrainedError":
      return new AgentError("mic-not-found", "No microphone was found. Connect one and try again.");
    case "NotReadableError":
    case "AbortError":
      return new AgentError(
        "mic-in-use",
        "The microphone could not be opened. It may be in use by another application.",
      );
    default:
      return new AgentError(
        "unknown",
        `Could not start the microphone: ${err instanceof Error ? err.message : String(err)}`,
      );
  }
}

export function toAgentError(err: unknown): AgentError {
  if (err instanceof AgentError) return err;
  const message = err instanceof Error ? err.message : String(err);
  return new AgentError("unknown", message || "Something went wrong.");
}
