import { useEffect, useMemo, useRef, useState } from 'react';
import { StreamingAudioPlayer } from './audio/playback';
import { base64FromArrayBuffer, downsampleBuffer, floatTo16BitPCM } from './audio/pcm';
import { GeminiLiveBridge } from './lib/gemini-live-client';

const TARGET_SAMPLE_RATE = 16000;
const CHUNK_MS = 200;

function App() {
  const [connectionState, setConnectionState] = useState('idle');
  const [conversationState, setConversationState] = useState('disconnected');
  const [error, setError] = useState('');
  const [transcripts, setTranscripts] = useState([]);

  const mediaStreamRef = useRef(null);
  const captureContextRef = useRef(null);
  const sourceNodeRef = useRef(null);
  const workletNodeRef = useRef(null);
  const geminiRef = useRef(null);
  const flushTimerRef = useRef(null);
  const pcmQueueRef = useRef([]);
  const playerRef = useRef(new StreamingAudioPlayer(24000));
  const isInitializingRef = useRef(false);

  const statusLabel = useMemo(() => {
    if (error) return 'Error';
    if (conversationState === 'speaking') return 'Berbicara';
    if (connectionState === 'streaming') return 'Mendengarkan';
    if (connectionState === 'connecting') return 'Menghubungkan';
    return 'Terputus';
  }, [connectionState, conversationState, error]);

  useEffect(() => () => stopSession(), []);

  const appendTranscript = (role, text) => {
    if (!text?.trim()) return;

    setTranscripts((current) => {
      const next = [...current];
      const last = next[next.length - 1];

      if (last && last.role === role) {
        next[next.length - 1] = { ...last, text };
        return next;
      }

      next.push({ id: crypto.randomUUID(), role, text });
      return next;
    });
  };

  const flushPcm = () => {
    const gemini = geminiRef.current;
    if (!gemini || pcmQueueRef.current.length === 0) {
      return;
    }

    const merged = mergeFloat32(pcmQueueRef.current);
    pcmQueueRef.current = [];
    if (captureContextRef.current && captureContextRef.current.state !== 'closed') {
        const downsampled = downsampleBuffer(merged, captureContextRef.current.sampleRate, TARGET_SAMPLE_RATE);
        const pcm16 = floatTo16BitPCM(downsampled);
        gemini.sendAudioChunk(base64FromArrayBuffer(pcm16));
    }
  };

  const startCapture = async () => {
    try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            channelCount: 1,
            noiseSuppression: true,
            echoCancellation: true,
            autoGainControl: true,
          },
        });

        // Final safety check before proceeding
        if (connectionState === 'idle' || !isInitializingRef.current) {
            stream.getTracks().forEach(t => t.stop());
            return;
        }

        mediaStreamRef.current = stream;

        const captureContext = new AudioContext();
        captureContextRef.current = captureContext;

        await captureContext.audioWorklet.addModule('/pcm-recorder-worklet.js');

        if (captureContext.state === 'closed') {
            throw new Error('AudioContext was closed during initialization.');
        }

        const sourceNode = captureContext.createMediaStreamSource(stream);
        sourceNodeRef.current = sourceNode;

        const workletNode = new AudioWorkletNode(captureContext, 'pcm-recorder-processor');
        const silentGain = captureContext.createGain();
        silentGain.gain.value = 0;
        workletNode.port.onmessage = (event) => {
          pcmQueueRef.current.push(new Float32Array(event.data));
        };

        sourceNode.connect(workletNode);
        workletNode.connect(silentGain).connect(captureContext.destination);
        workletNodeRef.current = workletNode;

        if (flushTimerRef.current) clearInterval(flushTimerRef.current);
        flushTimerRef.current = window.setInterval(flushPcm, CHUNK_MS);
    } catch (err) {
        console.error('startCapture failed:', err);
        throw err;
    }
  };

  const stopSession = async () => {
    isInitializingRef.current = false;

    if (flushTimerRef.current) {
      window.clearInterval(flushTimerRef.current);
      flushTimerRef.current = null;
    }

    flushPcm();
    geminiRef.current?.close();
    geminiRef.current = null;
    playerRef.current.clear();

    workletNodeRef.current?.disconnect();
    sourceNodeRef.current?.disconnect();
    workletNodeRef.current = null;
    sourceNodeRef.current = null;

    if (captureContextRef.current) {
      const ctx = captureContextRef.current;
      captureContextRef.current = null;
      if (ctx.state !== 'closed') {
        try {
            await ctx.close();
        } catch (e) {
            console.warn('Failed to close AudioContext:', e);
        }
      }
    }

    if (mediaStreamRef.current) {
        mediaStreamRef.current.getTracks().forEach((track) => track.stop());
        mediaStreamRef.current = null;
    }

    pcmQueueRef.current = [];
    setConnectionState('idle');
    setConversationState('disconnected');
  };

  const connectGemini = async () => {
    const apiKey = import.meta.env.VITE_GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error('VITE_GEMINI_API_KEY belum dikonfigurasi.');
    }

    setError('');
    setConnectionState('connecting');
    setConversationState('disconnected');

    const gemini = new GeminiLiveBridge({
      apiKey,
      onAudio: async (payload) => {
        setConversationState('speaking');
        await playerRef.current.enqueueBase64(payload.data);
      },
      onText: (payload) => {
        appendTranscript(payload.role, payload.text);
      },
      onInterrupted: () => {
        playerRef.current.clear();
        setConversationState('listening');
      },
      onTurnComplete: (payload) => {
        setConversationState('listening');
        if (payload.closed) {
           stopSession();
        }
      },
      onError: (error) => {
        setError(error.message || 'Kesalahan sesi Gemini Live.');
        stopSession();
      },
    });

    geminiRef.current = gemini;
    await gemini.connect();
    setConnectionState('streaming');
    setConversationState('listening');
  };

  const startSession = async () => {
    if (isInitializingRef.current || connectionState !== 'idle') return;

    isInitializingRef.current = true;
    setError('');

    try {
      await connectGemini();
      await startCapture();
    } catch (sessionError) {
      if (isInitializingRef.current) {
          setError('Gagal memulai sesi: ' + sessionError.message);
          await stopSession();
      }
    } finally {
      isInitializingRef.current = false;
    }
  };

  const handleAction = () => {
      if (connectionState === 'streaming') {
          stopSession();
      } else if (connectionState === 'idle') {
          startSession();
      }
  };

  const isPending = connectionState === 'connecting' || isInitializingRef.current;

  return (
    <main className="app-shell">
      <section className="card">
        <p className="eyebrow">Gemini 2.0 Flash Audio Dialog</p>
        <h1>Realtime Voice Console</h1>
        <p className="lede">
          Mikrofon browser dialirkan langsung ke Gemini Live API,
          dan diputar kembali sebagai audio latensi rendah di browser.
        </p>

        <div className="status-row">
          <span className={`status-pill ${statusLabel === 'Berbicara' ? 'speaking' : statusLabel === 'Mendengarkan' ? 'streaming' : statusLabel === 'Menghubungkan' ? 'connecting' : 'idle'}`}>{statusLabel}</span>
          <button
            className="primary-button"
            onClick={handleAction}
            disabled={isPending}
          >
            {connectionState === 'streaming' ? 'Berhenti' : 'Mulai Sesi'}
          </button>
        </div>

        {error ? <div className="error-banner">{error}</div> : null}

        <div className="transcript-panel">
          <div className="panel-header">
            <h2>Transkrip Langsung</h2>
            <span>{transcripts.length} pesan</span>
          </div>
          <div className="transcript-list">
            {transcripts.length === 0 ? (
              <p className="placeholder">Mulai sesi dan bicaralah untuk melihat transkrip.</p>
            ) : (
              transcripts.map((item) => (
                <article key={item.id} className={`transcript-item ${item.role}`}>
                  <strong>{item.role === 'user' ? 'Anda' : 'Gemini'}</strong>
                  <p>{item.text}</p>
                </article>
              ))
            )}
          </div>
        </div>
      </section>
    </main>
  );
}

function mergeFloat32(chunks) {
  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const merged = new Float32Array(totalLength);
  let offset = 0;

  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }

  return merged;
}

export default App;
