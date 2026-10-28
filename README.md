# Gemini Live Voice Agent

A real-time, speech-to-speech voice assistant built on the **Google Gemini Live API**.
Talk to it through your microphone and it answers out loud. You can interrupt it mid-sentence,
and you get a live transcript of both sides of the conversation.

- **Frontend:** Next.js 16 (App Router), React 19, TypeScript, Tailwind CSS 4
- **Backend:** FastAPI (Python 3.11+), which only mints short-lived Gemini tokens
- **AI:** Gemini Live API, model `gemini-3.8-live`, native audio in and out over WebSocket, via the official
  [`@google/genai`](https://www.npmjs.com/package/@google/genai) (JS) and
  [`google-genai`](https://pypi.org/project/google-genai/) (Python) SDKs

## Features

- Start and end a conversation; live microphone capture through an `AudioWorklet`
- Mic audio streamed to Gemini as 16 kHz PCM16; Gemini's 24 kHz PCM16 replies played back gaplessly
- Multi-turn conversation with Gemini's built-in voice activity detection (no push-to-talk)
- **Barge-in:** start speaking while Gemini talks and playback stops right away
- Live transcript of both speakers (Gemini input/output audio transcription); interrupted replies are marked
- Status that follows the real session: *Requesting microphone → Connecting → Listening /
  Hearing you → Thinking → Speaking*, plus *Reconnecting*, *Error* and *Ended*. "Listening" only
  appears after Gemini confirms the session (`setupComplete`).
- Automatic reconnection with **session resumption** when the server sends `goAway` (the
  ~10-minute connection limit) or the socket drops. Up to 3 retries with backoff, then a manual **Reconnect** button.
- Mute toggle (sends `audioStreamEnd`)
- Clear errors for: microphone blocked, missing or busy mic, mic unplugged, backend unreachable,
  invalid API key or quota, connection timeout, and connection lost
- Nothing is left running: mic tracks, AudioContexts and the WebSocket are released on End, on error,
  on unmount and on page hide

## Architecture

```
┌────────────────────────── Browser (Next.js client) ──────────────────────────┐
│                                                                               │
│  Microphone ─► AudioWorklet ─► resample ─► PCM16 16 kHz ─► base64 ──┐         │
│  (getUserMedia, echo cancel)   (pcm.ts)                             │         │
│                                                                     ▼         │
│  VoiceAgentSession (live-session.ts) ◄──── WebSocket (wss) ────► Gemini Live  │
│   • state machine / transcript                  ▲                API          │
│   • reconnect + resumption handle               │ ephemeral token             │
│                                                 │ (single use, 30 min,        │
│  Speaker ◄─ AudioBufferSource queue ◄─ PCM16 24 kHz                           │
│            (player.ts, clear() on interrupt)    │  locked config)             │
└──────────────────────────┬──────────────────────┼─────────────────────────────┘
                           │ POST /api/session-token
                           ▼ (same origin; Next.js rewrite proxies to FastAPI)
                ┌─────────────────────────────┐
                │ FastAPI backend             │  GEMINI_API_KEY lives only here
                │  auth_tokens.create(...)    │──► Gemini REST (v1alpha/auth_tokens)
                └─────────────────────────────┘
```

**Why ephemeral tokens?** Google recommends a direct client-to-Gemini WebSocket for the lowest audio
latency, together with ephemeral tokens in place of API keys
([docs](https://ai.google.dev/gemini-api/docs/ephemeral-tokens)). The backend holds the permanent key
and issues a token that:

- can open **one** session (`uses: 1`; resuming a session does not count as a use),
- must be used within **1 minute** and expires after **30 minutes**,
- is **locked** to the configured model, voice, system instruction, audio response modality,
  transcription and context-window compression (`lock_additional_fields=[]`). A tampered client
  cannot change them. Only the session-resumption handle is left for the client to set.

### Audio data flow

1. The **Start** click creates the playback `AudioContext` inside the user gesture, so autoplay is allowed,
   then requests the mic with echo cancellation, noise suppression and AGC.
2. `public/audio-capture-worklet.js` batches mic samples into ~40 ms chunks at the device rate.
3. `lib/audio/pcm.ts` resamples each chunk to 16 kHz, converts it to PCM16 LE and base64-encodes it.
   `session.sendRealtimeInput({ audio: { mimeType: "audio/pcm;rate=16000" } })` sends it once
   `setupComplete` has arrived.
4. Gemini replies with `serverContent.modelTurn.parts[].inlineData` (`audio/pcm;rate=24000`).
   `lib/audio/player.ts` schedules the chunks back to back on the AudioContext clock.
5. `serverContent.interrupted` triggers `player.clear()`, which stops all queued sources at once.
6. `inputTranscription` and `outputTranscription` fragments are merged into the transcript
   (`lib/session/transcript.ts`); `turnComplete` closes the turn.
7. `sessionResumptionUpdate.newHandle` is stored. On `goAway` or an unexpected close, a fresh token is
   fetched and the conversation resumes on a new socket with that handle.

### Project layout

```
backend/
  app/config.py        env loading + validation (fails fast with an actionable message)
  app/tokens.py        ephemeral token creation with locked Live config
  app/rate_limit.py    in-memory per-IP limit for the token endpoint
  app/main.py          FastAPI app: GET /api/health, POST /api/session-token
  app/__main__.py      `python -m app` entry point
  app/asgi.py          `uvicorn app.asgi:app` entry point (for --reload)
  tests/               pytest suite (Gemini mocked)
frontend/
  src/lib/audio/       microphone.ts, player.ts, pcm.ts
  src/lib/gemini/      token.ts (backend client), live-session.ts (session controller)
  src/lib/session/     transcript reducer, error model
  src/hooks/           useVoiceAgent (useSyncExternalStore binding)
  src/components/      VoiceAgent, StatusIndicator, Transcript
  public/audio-capture-worklet.js
  e2e/browser-smoke.mjs  optional browser smoke tests (Playwright + local Chrome/Edge)
```

## Prerequisites

- Node.js 20.9+ (tested on 25.2) and npm
- Python 3.11+ (tested on 3.13)
- A Gemini API key
- A browser with AudioWorklet support (current Chrome, Edge, Firefox or Safari). The page must be served from
  `http://localhost` or over HTTPS, or the browser won't expose the microphone.

### Getting a Gemini API key

1. Go to [Google AI Studio → API keys](https://aistudio.google.com/apikey) and sign in.
2. Click **Create API key** and choose or create a Google Cloud project.
3. Copy the key into `backend/.env` (see below). Never put it in frontend files or commit it.

The Live API is available on the free tier with lower rate limits. Check
[rate limits](https://ai.google.dev/gemini-api/docs/rate-limits) for your project.

## Installation

```bash
# Backend
cd backend
python -m venv .venv
# Windows: .venv\Scripts\activate    macOS/Linux: source .venv/bin/activate
pip install -r requirements-dev.txt     # or requirements.txt for runtime only
cp .env.example .env                    # then edit .env and set GEMINI_API_KEY

# Frontend
cd ../frontend
npm install
cp .env.example .env.local              # optional; defaults work for local dev
```

## Environment variables

**`backend/.env`**

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `GEMINI_API_KEY` | **yes** | — | Gemini API key (server only) |
| `GEMINI_MODEL` | no | `gemini-3.8-live` | Live model id |
| `GEMINI_VOICE` | no | `Kore` | Prebuilt voice name |
| `GEMINI_SYSTEM_INSTRUCTION` | no | short "concise voice assistant" prompt | System prompt locked into the token |
| `GEMINI_API_VERSION` | no | `v1alpha` | API version for token creation and the Live socket. The SDKs currently support ephemeral tokens on `v1alpha`. |
| `ALLOWED_ORIGINS` | no | `http://localhost:3000` | CORS origins, comma-separated; `*` is rejected |
| `TOKEN_RATE_LIMIT_PER_MINUTE` | no | `10` | Token requests per client IP per minute |
| `TOKEN_TTL_MINUTES` | no | `30` | Token lifetime (2–60) |
| `HOST` / `PORT` | no | `127.0.0.1` / `8000` | Bind address for `python -m app` |

The backend refuses to start if `GEMINI_API_KEY` is missing or still the placeholder:

```
Configuration error: GEMINI_API_KEY is not set. Create an API key at https://aistudio.google.com/apikey, then copy backend/.env.example to backend/.env and set GEMINI_API_KEY there.
```

**`frontend/.env.local`** (no secrets)

| Variable | Default | Purpose |
|---|---|---|
| `BACKEND_URL` | `http://127.0.0.1:8000` | Where Next.js proxies `/api/*`. It is read when `next dev` starts and **baked in at `next build`**, so set it before building. |
| `NEXT_PUBLIC_BACKEND_URL` | *(empty = same origin)* | Optional: call a backend on another origin directly. Add that origin to `ALLOWED_ORIGINS`. |

## Running

Run each in its own terminal:

```bash
# 1. Backend  (http://127.0.0.1:8000)
cd backend
.venv/Scripts/python -m app          # Windows (or activate the venv and run: python -m app)
# macOS/Linux: .venv/bin/python -m app
# Auto-reload during development: uvicorn app.asgi:app --reload --port 8000

# 2. Frontend (http://localhost:3000)
cd frontend
npm run dev
# Production: npm run build && npm start
```

Check the backend with `curl http://127.0.0.1:8000/api/health`, which should return `{"status":"ok","model":"gemini-3.8-live"}`.

If port 8000 is taken, start the backend with `PORT=8010` and the frontend with `BACKEND_URL=http://127.0.0.1:8010`.

## Using the assistant

1. Open <http://localhost:3000> and click **Start Conversation**.
2. Allow microphone access when the browser asks.
3. When the status shows **Listening**, just talk. Gemini detects when you stop speaking and replies.
4. Speak while it is **Speaking** to interrupt it. Playback stops and it listens to you.
5. Use **Mute** to pause your mic, and **End Conversation** to hang up. If the connection fails,
   click **Reconnect** to resume, or **Start New Conversation** to begin again.

Use headphones for the best experience. Echo cancellation helps, but on speakers Gemini can
sometimes hear itself and interrupt its own reply.

## Testing

```bash
# Backend: unit + API tests (Gemini is mocked, no network), lint, format check, types
cd backend
.venv/Scripts/python -m pytest
.venv/Scripts/ruff check . && .venv/Scripts/ruff format --check .
.venv/Scripts/mypy app tests

# Frontend: unit tests (Gemini, mic and audio output are mocked), types, lint, production build
cd frontend
npm test
npm run typecheck
npm run lint
npm run build
```

### Browser smoke tests (optional)

`frontend/e2e/browser-smoke.mjs` drives a locally installed Chrome or Edge, using Chromium's fake
microphone device, against a running frontend:

```bash
cd frontend
npm run dev                                         # in another terminal (backend too)
E2E_BASE_URL=http://localhost:3000 npm run test:e2e
# E2E_BROWSER=/path/to/chrome   if Chrome/Edge is not in the default location
# E2E_INVALID_KEY=1              when the backend runs with an INVALID key: checks the real
#                                Gemini rejection is shown to the user
```

The checks are:

- the page renders and the JS bundles contain no API-key pattern
- mic permission denied
- backend unreachable *(mocked)*
- a full audio loop against a **mocked Gemini WebSocket**: real SDK, real AudioWorklet capture and
  real playback. It covers setup, 16 kHz streaming, Speaking state, transcripts, interruption,
  resumption-based auto-reconnect and End cleanup.

The mocked scenarios do **not** test the live Gemini service.

**Live test:** with a real key in `backend/.env`, run both servers and hold a conversation.
There is no automated live test, because it needs a real microphone and costs quota.

## Troubleshooting

| Symptom | Fix |
|---|---|
| Backend exits with `Configuration error: GEMINI_API_KEY is not set` | Create `backend/.env` from `.env.example` and set the key. |
| "Could not reach the backend" | Start the backend, and check that `BACKEND_URL` matches its port. Rebuild after changing it in production. |
| "Gemini rejected the API key or request (400)" | The key is wrong, revoked, or from a project without Gemini API access. |
| "Gemini quota exceeded (429)" / "Too many session requests" | Wait a minute. The second message comes from the backend's own rate limit (`TOKEN_RATE_LIMIT_PER_MINUTE`). |
| "Microphone access was blocked" | Allow the mic via the browser's site settings (lock icon), then click Start again. |
| No mic prompt or "cannot capture audio here" | Use `http://localhost` or HTTPS. A LAN IP over plain HTTP is not a secure context. |
| "Gemini closed the connection (code 1008)" | Policy or auth problem: the model id is unavailable to your key, or the token expired. Check `GEMINI_MODEL`. |
| Gemini keeps interrupting itself | Use headphones, or lower the speaker volume. |
| No sound | Check the output device and the tab's mute state. Audio starts only after you click Start. |

## Limitations and known issues

- **Ephemeral tokens are a preview, `v1alpha` feature** in the SDKs. The SDKs log
  "experimental" warnings. If Google moves the feature to another version, set `GEMINI_API_VERSION`.
- **Session limits:** audio sessions last up to ~15 minutes without context compression. Context-window
  compression is enabled, and each WebSocket lives ~10 minutes; the app reconnects with session
  resumption when `goAway` arrives. Audio spoken during the brief reconnect gap is dropped.
- Resumption handles expire. If resuming fails, the app starts a fresh Gemini session, so the model loses
  the earlier context but the on-screen transcript is kept.
- Transcripts are produced by Gemini and can lag behind the audio or differ slightly from what was said.
- The "Thinking" state is derived from transcription and VAD signals and is a best-effort indicator.
- The backend rate limiter is in-memory and per-process. Use a shared store (e.g. Redis) behind a
  load balancer.
- There is no user authentication: anyone who can reach the token endpoint can mint tokens on your quota.
  Put the app behind your own auth before exposing it publicly.

## Security considerations

- `GEMINI_API_KEY` is read only by the backend. It is never sent to the browser, never logged
  (`Settings.__repr__` omits it), and it is scrubbed from error messages.
- The browser receives only single-use, short-lived tokens locked to the server-side configuration.
- `.env` files are git-ignored (`.env.example` contains placeholders only). The frontend has no secrets.
- CORS is restricted to `ALLOWED_ORIGINS` (wildcards rejected). By default the browser talks
  same-origin through the Next.js proxy and the backend binds to `127.0.0.1`.
- The token endpoint is POST-only and rate-limited per IP.
