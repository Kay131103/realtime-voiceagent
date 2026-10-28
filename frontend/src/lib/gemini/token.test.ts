import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchSessionToken } from "./token";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const stubFetch = (impl: () => Promise<Response>) => vi.stubGlobal("fetch", vi.fn(impl));

afterEach(() => vi.unstubAllGlobals());

describe("fetchSessionToken", () => {
  it("returns the token on success and POSTs to the same-origin proxy", async () => {
    const body = {
      token: "auth_tokens/abc",
      model: "gemini-3.8-live",
      apiVersion: "v1alpha",
      expireTime: "2026-01-01T00:30:00Z",
      newSessionExpireTime: "2026-01-01T00:01:00Z",
    };
    stubFetch(async () => json(200, body));
    await expect(fetchSessionToken()).resolves.toEqual(body);
    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(url).toBe("/api/session-token");
    expect(init?.method).toBe("POST");
  });

  it("reports an unreachable backend", async () => {
    stubFetch(async () => {
      throw new TypeError("Failed to fetch");
    });
    await expect(fetchSessionToken()).rejects.toMatchObject({ code: "backend-unreachable" });
  });

  it("treats a bare proxy 500 as backend unreachable", async () => {
    stubFetch(async () => new Response("Internal Server Error", { status: 500 }));
    await expect(fetchSessionToken()).rejects.toMatchObject({ code: "backend-unreachable" });
  });

  it("surfaces the backend's error detail", async () => {
    stubFetch(async () => json(502, { detail: "Gemini rejected the API key (400): invalid" }));
    await expect(fetchSessionToken()).rejects.toMatchObject({
      code: "token-failed",
      message: "Gemini rejected the API key (400): invalid",
    });
  });

  it("maps 429 to rate-limited", async () => {
    stubFetch(async () => json(429, { detail: "Too many session requests." }));
    await expect(fetchSessionToken()).rejects.toMatchObject({ code: "rate-limited" });
  });

  it("rejects malformed responses", async () => {
    stubFetch(async () => json(200, { model: "x" }));
    await expect(fetchSessionToken()).rejects.toMatchObject({ code: "token-failed" });
  });
});
