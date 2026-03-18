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
  const reconnectTimerRef = useRef(null);
  const manualStopRef = useRef(false);

  const statusLabel = useMemo(() => {
    if (error) return 'Error';
    if (conversationState === 'speaking') return 'Speaking';
    if (connectionState === 'streaming') return 'Listening';
    if (connectionState === 'connecting') return 'Connecting';
    return 'Disconnected';
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
    const downsampled = downsampleBuffer(merged, captureContextRef.current.sampleRate, TARGET_SAMPLE_RATE);
    const pcm16 = floatTo16BitPCM(downsampled);
    gemini.sendAudioChunk(base64FromArrayBuffer(pcm16));
  };

  const startCapture = async () => {
    mediaStreamRef.current = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        noiseSuppression: true,
        echoCancellation: true,
        autoGainControl: true,
      },
    });

    const captureContext = new AudioContext();
    captureContextRef.current = captureContext;
    await captureContext.audioWorklet.addModule('/pcm-recorder-worklet.js');

    const sourceNode = captureContext.createMediaStreamSource(mediaStreamRef.current);
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
    flushTimerRef.current = window.setInterval(flushPcm, CHUNK_MS);
  };

  const stopSession = async () => {
    manualStopRef.current = true;

    if (reconnectTimerRef.current) {
      window.clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }

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
      await captureContextRef.current.close();
      captureContextRef.current = null;
    }

    mediaStreamRef.current?.getTracks().forEach((track) => track.stop());
    mediaStreamRef.current = null;
    pcmQueueRef.current = [];
    setConnectionState('idle');
    setConversationState('disconnected');
  };

  const connectGemini = async () => {
    const apiKey = import.meta.env.VITE_GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error('VITE_GEMINI_API_KEY is not configured in environment variables.');
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
        if (payload.closed && !manualStopRef.current) {
           stopSession();
        }
      },
      onError: (error) => {
        setError(error.message || 'Gemini Live session error.');
        stopSession();
      },
    });

    geminiRef.current = gemini;
    await gemini.connect();
    setConnectionState('streaming');
    setConversationState('listening');
  };

  const startSession = async (isReconnect = false) => {
    manualStopRef.current = false;
    try {
      await connectGemini();
      await startCapture();
      if (isReconnect) {
        setError('');
      }
    } catch (sessionError) {
      setError(sessionError.message);
      await stopSession();
    }
  };

  return (
    <main className="app-shell">
      <section className="card">
        <p className="eyebrow">Gemini 2.5 Flash Native Audio Dialog</p>
        <h1>Realtime Voice Console</h1>
        <p className="lede">
          Browser microphone PCM is streamed directly to Gemini Live API,
          and played back as low-latency audio in the browser.
        </p>

        <div className="status-row">
          <span className={`status-pill ${statusLabel.toLowerCase()}`}>{statusLabel}</span>
          <button className="primary-button" onClick={connectionState === 'streaming' ? stopSession : startSession}>
            {connectionState === 'streaming' ? 'Stop session' : 'Start session'}
          </button>
        </div>

        {error ? <div className="error-banner">{error}</div> : null}

        <div className="transcript-panel">
          <div className="panel-header">
            <h2>Live transcript</h2>
            <span>{transcripts.length} messages</span>
          </div>
          <div className="transcript-list">
            {transcripts.length === 0 ? (
              <p className="placeholder">Start a session and speak to see user + model transcripts.</p>
            ) : (
              transcripts.map((item) => (
                <article key={item.id} className={`transcript-item ${item.role}`}>
                  <strong>{item.role === 'user' ? 'You' : 'Gemini'}</strong>
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
