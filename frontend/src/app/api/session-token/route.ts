import { NextResponse } from "next/server";

const BACKEND_URL = process.env.BACKEND_URL ?? "http://127.0.0.1:8000";
const AUTH_TOKEN = process.env.BACKEND_AUTH_TOKEN ?? "";

// Same-origin proxy to the FastAPI backend. Any shared secret is injected
// server-side here, so it never reaches the browser.
export async function POST() {
  try {
    const res = await fetch(`${BACKEND_URL}/api/session-token`, {
      method: "POST",
      cache: "no-store",
      headers: AUTH_TOKEN ? { Authorization: `Bearer ${AUTH_TOKEN}` } : undefined,
      signal: AbortSignal.timeout(10_000),
    });
    const body = await res.text();
    return new NextResponse(body, {
      status: res.status,
      headers: { "Content-Type": "application/json" },
    });
  } catch {
    return new NextResponse(JSON.stringify({ detail: "Could not reach the backend." }), {
      status: 502,
      headers: { "Content-Type": "application/json" },
    });
  }
}
