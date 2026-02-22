# Voice Email Assistant

A voice-powered email assistant built with Next.js. Speak naturally to search, read, and manage your email — responses are streamed and spoken back sentence-by-sentence for low-latency conversations.

## Architecture

```
Browser (index.tsx)
  │
  ├─ MediaRecorder + VAD ──► /api/transcribe ──► OpenAI Whisper
  │
  ├─ SSE stream ◄────────── /api/chat ────────► OpenAI GPT-4o
  │                                               │
  │                                               ├─ search_emails ──► Nylas
  │                                               ├─ read_email ─────► Nylas
  │                                               ├─ read_attachment ► Nylas + pdf-parse / GPT-4o vision
  │                                               ├─ send_email ─────► Nylas
  │                                               └─ reply_to_email ─► Nylas
  │
  └─ Sentence queue ──────► /api/speak ────────► OpenAI TTS
```

### Voice loop

1. **Listen** — the browser captures microphone audio via `MediaRecorder`. A Voice Activity Detection (VAD) monitor watches the RMS level and transitions from *listening* to *recording* when speech is detected.
2. **Record** — audio chunks are collected. When ~1.5 s of silence follows at least 500 ms of speech, the recorder stops and a confirmation beep plays.
3. **Transcribe** — the audio blob is POSTed to `/api/transcribe`, which sends it to OpenAI Whisper (`whisper-1`) and returns the text.
4. **Chat** — the transcript and conversation history are POSTed to `/api/chat`. The server resolves any tool calls (email search, read, send, etc.) using non-streaming OpenAI requests, then streams the final text response back as **Server-Sent Events** (`data: {"delta":"..."}` per chunk, `data: {"done":true,"reply":"..."}` at the end).
5. **Speak** — as SSE deltas arrive, the frontend splits text on sentence boundaries (`.` `!` `?`) and fires off `/api/speak` requests in parallel. Each sentence is converted to audio by OpenAI TTS (`tts-1`, voice `alloy`) and played back sequentially. The first sentence starts playing while the rest are still generating.
6. **Interrupt** — during playback, the VAD monitor keeps running. If the user speaks above a threshold, playback stops immediately, pending TTS fetches are aborted via `AbortController`, and the loop restarts from step 1.

### API routes

| Route | Method | Description |
|---|---|---|
| `/api/transcribe` | POST | Accepts `multipart/form-data` with an `audio` field. Returns `{ text }`. |
| `/api/chat` | POST | Accepts `{ message, history }`. Returns an SSE stream of text deltas, then a `done` event with the full reply. Tool calls (email operations) are resolved server-side before streaming. |
| `/api/speak` | POST | Accepts `{ text }`. Returns an `audio/mpeg` buffer. |

### Email tools

The chat endpoint exposes five tools to GPT-4o via OpenAI function calling:

- **search_emails** — full-text search via Nylas `searchQueryNative`
- **read_email** — fetch a single message by ID (body, metadata, attachment list)
- **read_attachment** — download and extract content from an attachment (text, CSV, PDF via `pdf-parse`, images via GPT-4o vision)
- **send_email** — compose and send (requires explicit user confirmation)
- **reply_to_email** — reply to an existing thread (requires explicit user confirmation)

Tool calls are handled in a loop (up to 5 iterations) with non-streaming OpenAI requests. Only the final text response is streamed to the client, so intermediate tool-call text never leaks through.

### Key files

```
pages/
  index.tsx            Main UI — recording, streaming, TTS queue, interrupt
  api/
    chat.ts            Chat endpoint — tool loop + SSE streaming
    speak.ts           TTS endpoint — OpenAI tts-1
    transcribe.ts      STT endpoint — OpenAI whisper-1
lib/
  nylas.ts             Nylas SDK client + grant ID
```

## Setup

```bash
cp .env.example .env.local
# Fill in your API keys in .env.local

npm install
npm run dev
```

### Environment variables

| Variable | Description |
|---|---|
| `OPENAI_API_KEY` | OpenAI API key (GPT-4o, Whisper, TTS) |
| `NYLAS_API_KEY` | Nylas API key for email access |
| `NYLAS_GRANT_ID` | Nylas grant ID for the connected email account |

## Tech stack

- **Next.js** (Pages Router) + **React** + **TypeScript**
- **Tailwind CSS v4** — dark theme UI
- **OpenAI** — GPT-4o (chat + vision), Whisper (STT), TTS-1 (speech)
- **Nylas** — email API (search, read, send, reply, attachments)
- **Web Audio API** — VAD, audio level monitoring, confirmation beep
- **Server-Sent Events** — streaming chat responses
