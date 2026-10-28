// Browser smoke tests against a running frontend (see README "Browser smoke tests").
//
// Scenario 1 (opt-in, E2E_INVALID_KEY=1) hits the REAL backend and the REAL
// Gemini token endpoint while the backend runs with an invalid key.
// Scenarios 2-4 mock pieces explicitly (labelled [mocked]); scenario 4 replaces
// the Gemini WebSocket with an in-browser fake, so it is NOT a live API test.
//
// Env: E2E_BASE_URL (default http://localhost:3000), E2E_BROWSER (Chrome/Edge exe).
import { chromium } from "playwright-core";

const BASE = process.env.E2E_BASE_URL ?? "http://localhost:3000";
const EDGE =
  process.env.E2E_BROWSER ??
  (process.platform === "win32"
    ? "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"
    : process.platform === "darwin"
      ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
      : "/usr/bin/google-chrome");
const results = [];
const check = (name, ok, extra = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${extra ? " - " + extra : ""}`);
};

const browser = await chromium.launch({
  executablePath: EDGE,
  headless: true,
  args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--autoplay-policy=no-user-gesture-required"],
});

async function newPage({ grantMic = true } = {}) {
  const ctx = await browser.newContext();
  if (grantMic) await ctx.grantPermissions(["microphone"], { origin: BASE });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log("  [pageerror]", e.message));
  return { ctx, page };
}
const phase = (page) => page.getByTestId("phase-label").innerText();

// 1. Real backend, real Gemini auth_tokens call with an invalid key.
if (process.env.E2E_INVALID_KEY === "1") {
  const { ctx, page } = await newPage();
  await page.goto(BASE);
  await page.getByRole("button", { name: "Start Conversation" }).click();
  const alert = page.getByTestId("error-banner");
  await alert.waitFor({ timeout: 20000 });
  const text = await alert.innerText();
  check("invalid key surfaces Gemini's rejection [real backend + real Gemini]", /API key not valid/.test(text), text);
  check("never showed Listening without a session", (await phase(page)) === "Error");
  check("Reconnect control offered", await page.getByRole("button", { name: "Reconnect" }).isVisible());
  await ctx.close();
}

// 0. Page renders and ships no key material.
{
  const { ctx, page } = await newPage();
  await page.goto(BASE);
  check("page renders Start button", await page.getByRole("button", { name: "Start Conversation" }).isVisible());
  const scripts = await page.evaluate(async () => {
    const srcs = [...document.scripts].map((s) => s.src).filter(Boolean);
    return (await Promise.all(srcs.map((u) => fetch(u).then((r) => r.text())))).join("\n");
  });
  check("no Gemini API key pattern in JS bundles", !/AIza[0-9A-Za-z_-]{35}/.test(scripts));
  await ctx.close();
}

// 2. Microphone permission denied (no permission granted, prompts auto-denied).
{
  const b2 = await chromium.launch({
    executablePath: EDGE,
    headless: true,
    args: ["--use-fake-device-for-media-stream", "--deny-permission-prompts"],
  });
  const ctx = await b2.newContext();
  const page = await ctx.newPage();
  let tokenRequested = false;
  page.on("request", (r) => r.url().includes("/api/session-token") && (tokenRequested = true));
  await page.goto(BASE);
  await page.getByRole("button", { name: "Start Conversation" }).click();
  const text = await page.getByTestId("error-banner").innerText({ timeout: 10000 });
  check("mic permission denied message", /Microphone access was blocked/.test(text), text);
  check("no token requested when mic denied", !tokenRequested);
  await b2.close();
}

// 3. Backend unreachable [mocked: request aborted].
{
  const { ctx, page } = await newPage();
  await page.route("**/api/session-token", (r) => r.abort("connectionrefused"));
  await page.goto(BASE);
  await page.getByRole("button", { name: "Start Conversation" }).click();
  const text = await page.getByTestId("error-banner").innerText({ timeout: 10000 });
  check("backend unreachable message [mocked]", /Could not reach the backend/.test(text), text);
  await ctx.close();
}

// 4. Full audio loop against a MOCKED Gemini WebSocket (real SDK, real worklet, real playback).
{
  const { ctx, page } = await newPage();
  await page.route("**/api/session-token", (r) =>
    r.fulfill({
      json: { token: "auth_tokens/fake", model: "gemini-3.8-live", apiVersion: "v1alpha", expireTime: "", newSessionExpireTime: "" },
    }),
  );
  const ws = { setup: null, audioChunks: 0, mime: null, url: null, connections: 0, server: null };
  // 0.5 s of a 440 Hz tone at 24 kHz, base64 PCM16.
  const tone = (() => {
    const n = 12000, buf = Buffer.alloc(n * 2);
    for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / 24000) * 8000), i * 2);
    return buf.toString("base64");
  })();
  await page.routeWebSocket(/generativelanguage\.googleapis\.com/, (server) => {
    ws.connections++;
    ws.url = server.url();
    ws.server = server;
    server.onMessage((raw) => {
      const msg = JSON.parse(typeof raw === "string" ? raw : raw.toString());
      if (msg.setup) {
        ws.setup = msg.setup;
        server.send(JSON.stringify({ setupComplete: {} }));
      } else if (msg.realtimeInput?.audio) {
        ws.audioChunks++;
        ws.mime = msg.realtimeInput.audio.mimeType;
      }
    });
  });

  await page.goto(BASE);
  await page.getByRole("button", { name: "Start Conversation" }).click();
  await page.getByText("Listening", { exact: false }).first().waitFor({ timeout: 10000 });
  check("Listening shown after setupComplete [mocked WS]", /Listening|Hearing you/.test(await phase(page)));
  check("SDK used ephemeral-token endpoint", /BidiGenerateContentConstrained\?access_token=auth_tokens\/fake/.test(ws.url), ws.url);
  check("setup asks for audio + transcription + resumption",
    ws.setup?.generationConfig?.responseModalities?.includes("AUDIO") && !!ws.setup.inputAudioTranscription && !!ws.setup.sessionResumption,
    JSON.stringify(ws.setup));
  await page.waitForTimeout(1000);
  check("mic audio streamed as 16 kHz PCM [fake mic]", ws.audioChunks > 10 && ws.mime === "audio/pcm;rate=16000", `${ws.audioChunks} chunks, ${ws.mime}`);

  ws.server.send(JSON.stringify({ serverContent: { inputTranscription: { text: "Hello there" } } }));
  ws.server.send(JSON.stringify({
    serverContent: {
      modelTurn: { parts: [{ inlineData: { mimeType: "audio/pcm;rate=24000", data: tone }}, { inlineData: { mimeType: "audio/pcm;rate=24000", data: tone }}] },
      outputTranscription: { text: "Hi! How can I help?" },
    },
  }));
  await page.getByText("Speaking").waitFor({ timeout: 5000 });
  check("Speaking shown while audio plays", (await phase(page)) === "Speaking");
  check("user transcript shown", await page.getByText("Hello there").isVisible());
  check("assistant transcript shown", await page.getByText("Hi! How can I help?").isVisible());

  ws.server.send(JSON.stringify({ serverContent: { interrupted: true } }));
  await page.waitForTimeout(300);
  check("interruption stops playback", (await phase(page)) !== "Speaking", await phase(page));
  check("interrupted turn marked", await page.getByText("(interrupted)").isVisible());

  // Resumption: server hands out a handle, then drops the socket.
  ws.server.send(JSON.stringify({ sessionResumptionUpdate: { newHandle: "resume-123", resumable: true } }));
  await page.waitForTimeout(100);
  ws.server.close({ code: 1011, reason: "server restart" });
  await page.waitForFunction(() => /Listening|Hearing you/.test(document.querySelector('[data-testid="phase-label"]').innerText), null, { timeout: 10000 });
  check("auto-reconnected with resumption handle", ws.connections === 2 && ws.setup?.sessionResumption?.handle === "resume-123", JSON.stringify(ws.setup?.sessionResumption));
  check("transcript kept across reconnect", await page.getByText("Hello there").isVisible());

  if (process.env.E2E_SCREENSHOT) await page.screenshot({ path: process.env.E2E_SCREENSHOT, fullPage: true });
  await page.getByRole("button", { name: "End Conversation" }).click();
  check("End returns to ended state", (await phase(page)) === "Conversation ended");
  const before = ws.audioChunks;
  await page.waitForTimeout(500);
  check("no audio sent after End", ws.audioChunks === before);
  await ctx.close();
}

await browser.close();
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
