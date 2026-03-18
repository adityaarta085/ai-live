import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import http from 'http';
import { WebSocketServer } from 'ws';
import { GeminiLiveBridge } from './lib/gemini-live-client.js';

const app = express();
const port = Number(process.env.PORT || 3001);

app.use(cors());
app.use(express.json());

app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', async (socket) => {
  if (!process.env.GEMINI_API_KEY) {
    socket.send(JSON.stringify({ type: 'error', message: 'GEMINI_API_KEY is not configured on the server.' }));
    socket.close();
    return;
  }

  const gemini = new GeminiLiveBridge({
    apiKey: process.env.GEMINI_API_KEY,
    onAudio: (payload) => {
      socket.send(JSON.stringify({ type: 'audio', ...payload }));
    },
    onText: (payload) => {
      socket.send(JSON.stringify({ type: 'transcript', ...payload }));
    },
    onInterrupted: () => {
      socket.send(JSON.stringify({ type: 'interrupted' }));
    },
    onTurnComplete: (payload) => {
      socket.send(JSON.stringify({ type: 'turn_complete', ...payload }));
    },
    onError: (error) => {
      socket.send(JSON.stringify({ type: 'error', message: error.message || 'Gemini Live session error.' }));
    },
  });

  try {
    await gemini.connect();
    socket.send(JSON.stringify({ type: 'ready' }));
  } catch (error) {
    socket.send(JSON.stringify({ type: 'error', message: error.message || 'Failed to connect to Gemini Live API.' }));
    socket.close();
    return;
  }

  socket.on('message', (raw) => {
    try {
      const message = JSON.parse(raw.toString());

      if (message.type === 'audio') {
        gemini.sendAudioChunk(message.data);
      }

      if (message.type === 'ping') {
        socket.send(JSON.stringify({ type: 'pong' }));
      }
    } catch (error) {
      socket.send(JSON.stringify({ type: 'error', message: `Malformed client message: ${error.message}` }));
    }
  });

  socket.on('close', () => {
    gemini.close();
  });

  socket.on('error', () => {
    gemini.close();
  });
});

server.listen(port, '0.0.0.0', () => {
  console.log(`Gemini Live backend listening on http://0.0.0.0:${port}`);
});
