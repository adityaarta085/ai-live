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
  const isStoppingRef = useRef(false);
  const connectionStateRef = useRef('idle');
  const conversationStateRef = useRef('disconnected');
  const activeTranscriptIdsRef = useRef({ user: null, model: null });

  const updateConnectionState = (nextState) => {
    connectionStateRef.current = nextState;
    setConnectionState(nextState);
  };

  const updateConversationState = (nextState) => {
    conversationStateRef.current = nextState;
    setConversationState(nextState);
  };

  const statusLabel = useMemo(() => {
    if (error) return 'Perlu perhatian';
    if (conversationState === 'speaking') return 'Gemini sedang menjawab';
    if (connectionState === 'streaming') return 'Mikrofon aktif';
    if (connectionState === 'connecting') return 'Sedang menghubungkan';
    return 'Belum tersambung';
  }, [connectionState, conversationState, error]);

  useEffect(() => () => {
    stopSession();
    // stopSession intentionally uses refs so cleanup should stay mount-only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const appendTranscript = ({ role, text, mode = 'append' }) => {
    const normalizedText = text?.trim();
    if (!normalizedText) return;

    setTranscripts((current) => {
      const next = [...current];
      const activeIds = activeTranscriptIdsRef.current;
      const activeId = activeIds[role];
      const otherRole = role === 'user' ? 'model' : 'user';

      if (activeIds[otherRole]) {
        activeIds[otherRole] = null;
      }

      if (activeId) {
        const index = next.findIndex((item) => item.id === activeId);
        if (index >= 0) {
          next[index] = {
            ...next[index],
            text: mode === 'replace' ? normalizedText : mergeTranscriptText(next[index].text, normalizedText),
          };
          return next;
        }
      }

      const id = crypto.randomUUID();
      activeIds[role] = id;
      next.push({ id, role, text: normalizedText });
      return next;
    });
  };

  const flushPcm = () => {
    const gemini = geminiRef.current;
    const captureContext = captureContextRef.current;

    if (!gemini || !captureContext || pcmQueueRef.current.length === 0) {
      return;
    }

    const merged = mergeFloat32(pcmQueueRef.current);
    pcmQueueRef.current = [];

    if (captureContext.state === 'closed') {
      return;
    }

    const downsampled = downsampleBuffer(merged, captureContext.sampleRate, TARGET_SAMPLE_RATE);
    const pcm16 = floatTo16BitPCM(downsampled);
    gemini.sendAudioChunk(base64FromArrayBuffer(pcm16));
  };

  const stopSession = async ({ preserveError = true } = {}) => {
    if (isStoppingRef.current) {
      return;
    }

    isStoppingRef.current = true;
    isInitializingRef.current = false;

    if (flushTimerRef.current) {
      window.clearInterval(flushTimerRef.current);
      flushTimerRef.current = null;
    }

    flushPcm();

    const gemini = geminiRef.current;
    geminiRef.current = null;
    gemini?.close();

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
        } catch (closeError) {
          console.warn('Gagal menutup AudioContext:', closeError);
        }
      }
    }

    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach((track) => track.stop());
      mediaStreamRef.current = null;
    }

    pcmQueueRef.current = [];
    activeTranscriptIdsRef.current = { user: null, model: null };
    updateConnectionState('idle');
    updateConversationState('disconnected');
    if (!preserveError) {
      setError('');
    }

    isStoppingRef.current = false;
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

      if (!isInitializingRef.current && connectionStateRef.current !== 'streaming') {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }

      stream.getAudioTracks().forEach((track) => {
        track.onended = () => {
          if (connectionStateRef.current === 'streaming') {
            setError('Mikrofon terputus. Silakan sambungkan ulang lalu mulai sesi lagi.');
            stopSession();
          }
        };
      });

      mediaStreamRef.current = stream;

      const captureContext = new AudioContext();
      captureContextRef.current = captureContext;
      await captureContext.resume();
      await captureContext.audioWorklet.addModule('/pcm-recorder-worklet.js');

      if (captureContext.state === 'closed') {
        throw new Error('AudioContext tertutup saat inisialisasi mikrofon.');
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

      if (flushTimerRef.current) {
        clearInterval(flushTimerRef.current);
      }
      flushTimerRef.current = window.setInterval(flushPcm, CHUNK_MS);
    } catch (captureError) {
      console.error('startCapture gagal:', captureError);
      if (captureError?.name === 'NotAllowedError') {
        throw new Error('Izin mikrofon ditolak. Izinkan akses mikrofon di browser terlebih dahulu.');
      }
      if (captureError?.name === 'NotFoundError') {
        throw new Error('Mikrofon tidak ditemukan. Pastikan perangkat input audio tersedia.');
      }
      throw captureError;
    }
  };

  const connectGemini = async () => {
    const apiKey = import.meta.env.VITE_GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error('VITE_GEMINI_API_KEY belum dikonfigurasi.');
    }

    setError('');
    updateConnectionState('connecting');
    updateConversationState('disconnected');

    const gemini = new GeminiLiveBridge({
      apiKey,
      onAudio: async (payload) => {
        updateConversationState('speaking');
        await playerRef.current.enqueueBase64(payload.data);
      },
      onText: (payload) => {
        appendTranscript(payload);
      },
      onInterrupted: () => {
        playerRef.current.clear();
        updateConversationState('listening');
      },
      onTurnComplete: (payload) => {
        activeTranscriptIdsRef.current.model = null;
        activeTranscriptIdsRef.current.user = null;
        updateConversationState('listening');
        if (payload.closed && !isStoppingRef.current) {
          stopSession();
        }
      },
      onError: (sessionError) => {
        setError(sessionError.message || 'Terjadi kesalahan pada sesi Gemini Live.');
        stopSession();
      },
    });

    geminiRef.current = gemini;
    await gemini.connect();
    updateConnectionState('streaming');
    updateConversationState('listening');
  };

  const startSession = async () => {
    if (isInitializingRef.current || connectionStateRef.current !== 'idle') {
      return;
    }

    isInitializingRef.current = true;
    isStoppingRef.current = false;
    setError('');

    try {
      await connectGemini();
      await startCapture();
    } catch (sessionError) {
      if (isInitializingRef.current) {
        setError(`Gagal memulai sesi: ${sessionError.message}`);
        await stopSession();
      }
    } finally {
      isInitializingRef.current = false;
    }
  };

  const handleAction = () => {
    if (connectionStateRef.current === 'streaming') {
      stopSession({ preserveError: false });
    } else if (connectionStateRef.current === 'idle') {
      startSession();
    }
  };

  const isPending = connectionState === 'connecting' || isInitializingRef.current;

  return (
    <main className="app-shell">
      <section className="card">
        <p className="eyebrow">Gemini Live · Native Audio · Bahasa Indonesia</p>
        <h1>Asisten Suara Realtime</h1>
        <p className="lede">
          Aplikasi ini sekarang diprioritaskan untuk percakapan Bahasa Indonesia yang lebih alami,
          dengan status mikrofon yang lebih jelas dan penanganan koneksi yang lebih stabil.
        </p>

        <div className="status-row">
          <span
            className={`status-pill ${
              error
                ? 'error'
                : conversationState === 'speaking'
                  ? 'speaking'
                  : connectionState === 'streaming'
                    ? 'listening'
                    : connectionState === 'connecting'
                      ? 'connecting'
                      : 'idle'
            }`}
          >
            {statusLabel}
          </span>
          <button className="primary-button" onClick={handleAction} disabled={isPending}>
            {connectionState === 'streaming' ? 'Akhiri Sesi' : 'Mulai Bicara'}
          </button>
        </div>

        <div className="info-grid">
          <article className="info-card">
            <strong>Bahasa utama</strong>
            <p>Gemini diarahkan untuk menjawab dalam Bahasa Indonesia yang alami, sopan, dan mudah dipahami.</p>
          </article>
          <article className="info-card">
            <strong>Status mikrofon</strong>
            <p>Koneksi audio sekarang dibersihkan dengan aman agar mikrofon bisa dipakai ulang saat sesi dimulai lagi.</p>
          </article>
          <article className="info-card">
            <strong>Tips penggunaan</strong>
            <p>Jika sempat menolak izin mikrofon, izinkan kembali di browser lalu tekan tombol mulai sekali lagi.</p>
          </article>
        </div>

        {error ? <div className="error-banner">{error}</div> : null}

        <div className="transcript-panel">
          <div className="panel-header">
            <h2>Transkrip Langsung</h2>
            <span>{transcripts.length} pesan</span>
          </div>
          <div className="transcript-list">
            {transcripts.length === 0 ? (
              <p className="placeholder">Mulai sesi lalu bicara dalam Bahasa Indonesia untuk melihat transkrip realtime.</p>
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


function mergeTranscriptText(previousText, incomingText) {
  const previous = previousText?.trim() ?? '';
  const incoming = incomingText?.trim() ?? '';

  if (!previous) return incoming;
  if (!incoming) return previous;
  if (incoming === previous || previous.endsWith(incoming)) return previous;
  if (incoming.startsWith(previous)) return incoming;

  const maxOverlap = Math.min(previous.length, incoming.length);
  for (let size = maxOverlap; size > 0; size -= 1) {
    if (previous.slice(-size) === incoming.slice(0, size)) {
      return `${previous}${incoming.slice(size)}`.trim();
    }
  }

  return `${previous} ${incoming}`.replace(/\s+/g, ' ').trim();
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
