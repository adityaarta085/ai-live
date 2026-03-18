# Gemini Live Voice Console (Frontend Only)

This is a simplified Gemini Live voice console that runs entirely in the browser and is ready to deploy to Vercel. It connects directly to the Google Gemini Live API using a native-audio model configured for Indonesian conversations.

## Setup

1. Copy `.env.example` to `.env`.
2. Fill in your `VITE_GEMINI_API_KEY`.
3. Optional: adjust the model or voice with `VITE_GEMINI_MODEL` and `VITE_GEMINI_VOICE`.
4. Install dependencies and start the development server.

## Environment Variables

- `VITE_GEMINI_API_KEY`: Your Google Gemini API key.
- `VITE_GEMINI_MODEL`: Optional override for the Live API model. Defaults to `gemini-2.5-flash-native-audio-preview-12-2025`.
- `VITE_GEMINI_VOICE`: Optional override for the default voice. Defaults to `Aoede`.

## Indonesian Support

The app is configured to:

- send Indonesian speech transcription hints with `id-ID`
- ask Gemini to answer naturally in Bahasa Indonesia
- use the Live API `v1alpha` endpoint required for native-audio dialog features

## Deployment

This repository is ready to deploy to Vercel:

- Root `vercel.json` builds the frontend with `npm run build --prefix frontend`
- Output directory is `frontend/dist`
- Add `VITE_GEMINI_API_KEY` in your Vercel project environment variables
- Optionally add `VITE_GEMINI_MODEL` and `VITE_GEMINI_VOICE` if you want to override the defaults per environment
