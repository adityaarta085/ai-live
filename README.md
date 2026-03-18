# Gemini Live Voice Web App

A production-style realtime voice assistant built with React, Node.js, WebSockets, and the Gemini Live API. The browser captures microphone audio, converts it to 16 kHz PCM, streams it to a backend WebSocket server, and the backend maintains a persistent bidirectional Gemini Live session that returns low-latency audio + transcripts.

## Folder structure

```text
.
├── backend
│   ├── lib/gemini-live-client.js
│   ├── server.js
│   └── utils/audio.js
├── frontend
│   ├── public/pcm-recorder-worklet.js
│   └── src
│       ├── App.jsx
│       ├── audio/playback.js
│       ├── audio/pcm.js
│       ├── main.jsx
│       └── styles.css
├── .env.example
└── package.json
```

## How it works

1. **Frontend microphone capture**
   - `getUserMedia()` opens the microphone.
   - An `AudioWorklet` captures raw float PCM frames from the input stream.
   - Chunks are merged every 200 ms and downsampled to 16 kHz mono PCM16.
   - Audio is base64 encoded and sent to the backend over WebSocket.

2. **Backend WebSocket bridge**
   - Express exposes `/health` and a WebSocket endpoint at `/ws`.
   - Each browser session creates a dedicated Gemini Live connection.
   - Browser PCM frames are forwarded using `session.sendRealtimeInput()`.
   - Gemini audio, transcripts, interruptions, and turn completion events are streamed back to the client.

3. **Realtime playback**
   - Browser audio responses are decoded from PCM16 and scheduled immediately with the Web Audio API.
   - Interruption events clear the playback queue to support barge-in.

## Environment variables

Copy `.env.example` to `.env` in the repo root and set your API key:

```bash
cp .env.example .env
```

```env
GEMINI_API_KEY=your_google_ai_api_key
PORT=3001
GEMINI_LIVE_MODEL=gemini-2.5-flash-native-audio-preview-12-2025
GEMINI_VOICE=Aoede
VITE_WS_URL=ws://localhost:3001/ws
```

## Run locally

### 1) Install dependencies

```bash
npm install
```

### 2) Start backend + frontend together

```bash
npm run dev
```

- Frontend: `http://localhost:5173`
- Backend health check: `http://localhost:3001/health`
- Backend WebSocket: `ws://localhost:3001/ws`

### 3) Start talking

1. Open the frontend in Chrome or Edge.
2. Click **Start session**.
3. Allow microphone access.
4. Speak naturally; Gemini responses stream back as audio and transcript events.

## Notes

- The app uses a WebSocket bridge end-to-end; it does **not** use the REST API.
- For low-latency PCM streaming, the frontend uses `AudioWorklet` rather than `MediaRecorder`, because browsers typically emit compressed Opus/WebM from `MediaRecorder` instead of raw PCM.
- The backend uses the official `@google/genai` Live client to keep a persistent bidirectional session open with Gemini.
- If you want a different synthesized voice, update `GEMINI_VOICE`.

## Production hardening ideas

- Add JWT auth on the browser WebSocket connection.
- Put the backend behind TLS and upgrade to `wss://`.
- Add structured logging / tracing for live session events.
- Persist transcripts for analytics and QA review.
- Add rate limiting and per-user session budgets.
