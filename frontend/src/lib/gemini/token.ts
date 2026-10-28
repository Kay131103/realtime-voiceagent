import { AgentError } from "@/lib/session/errors";

export interface SessionToken {
  token: string;
  model: string;
  apiVersion: string;
  expireTime: string;
  newSessionExpireTime: string;
}

export type FetchToken = () => Promise<SessionToken>;

const TOKEN_TIMEOUT_MS = 10_000;

/** Same-origin by default: Next.js rewrites /api/* to the FastAPI backend. */
const TOKEN_URL = `${process.env.NEXT_PUBLIC_BACKEND_URL ?? ""}/api/session-token`;

export const fetchSessionToken: FetchToken = async () => {
  let res: Response;
  try {
    res = await fetch(TOKEN_URL, {
      method: "POST",
      cache: "no-store",
      signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
    });
  } catch (err) {
    const timedOut = err instanceof DOMException && err.name === "TimeoutError";
    throw new AgentError(
      "backend-unreachable",
      timedOut
        ? "The backend did not respond in time. Is it running?"
        : "Could not reach the backend. Make sure it is running (see README).",
    );
  }

  if (!res.ok) {
    const detail = await readDetail(res);
    if (res.status === 429) {
      throw new AgentError("rate-limited", detail ?? "Too many attempts. Wait a minute.");
    }
    // The Next.js dev proxy answers 500 when the backend is down.
    if (res.status === 500 && !detail) {
      throw new AgentError("backend-unreachable", "Could not reach the backend. Is it running?");
    }
    throw new AgentError(
      "token-failed",
      detail ?? `The backend could not create a session (HTTP ${res.status}).`,
    );
  }

  const body = (await res.json()) as Partial<SessionToken>;
  if (!body.token || !body.model) {
    throw new AgentError("token-failed", "The backend returned an invalid session token.");
  }
  return body as SessionToken;
};

async function readDetail(res: Response): Promise<string | undefined> {
  try {
    const body = (await res.json()) as { detail?: unknown };
    return typeof body.detail === "string" ? body.detail : undefined;
  } catch {
    return undefined;
  }
}
