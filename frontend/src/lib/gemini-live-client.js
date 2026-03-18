import { GoogleGenAI } from '@google/genai';

const DEFAULT_MODEL =
  import.meta.env.VITE_GEMINI_MODEL || 'gemini-2.5-flash-native-audio-preview-12-2025';
const DEFAULT_VOICE = import.meta.env.VITE_GEMINI_VOICE || 'Aoede';
const DEFAULT_LANGUAGE = 'id-ID';

const INDONESIAN_SYSTEM_PROMPT = `Anda adalah asisten suara AI untuk penutur Bahasa Indonesia.
Jawab selalu dalam Bahasa Indonesia yang alami, hangat, jelas, dan tidak kaku.
Utamakan pilihan kata yang umum dipakai di Indonesia.
Bila pengguna mencampur bahasa, tetap balas dalam Bahasa Indonesia kecuali pengguna meminta bahasa lain.
Saat menjelaskan langkah teknis, buat ringkas, runtut, dan mudah diikuti.`;

export class GeminiLiveBridge {
  constructor({ apiKey, onAudio, onText, onInterrupted, onTurnComplete, onError }) {
    this.ai = new GoogleGenAI({
      apiKey,
      httpOptions: {
        apiVersion: 'v1alpha',
      },
    });
    this.session = null;
    this.handlers = { onAudio, onText, onInterrupted, onTurnComplete, onError };
  }

  async connect() {
    this.session = await this.ai.live.connect({
      model: DEFAULT_MODEL,
      config: {
        systemInstruction: {
          parts: [
            {
              text: INDONESIAN_SYSTEM_PROMPT,
            },
          ],
        },
        responseModalities: ['AUDIO'],
        speechConfig: {
          languageCode: DEFAULT_LANGUAGE,
          voiceConfig: {
            prebuiltVoiceConfig: {
              voiceName: DEFAULT_VOICE,
            },
          },
        },
        inputAudioTranscription: {
          languageCode: DEFAULT_LANGUAGE,
        },
        outputAudioTranscription: {
          languageCode: DEFAULT_LANGUAGE,
        },
        enableAffectiveDialog: true,
        realtimeInputConfig: {
          automaticActivityDetection: {
            disabled: false,
          },
        },
      },
      callbacks: {
        onmessage: (message) => this.handleMessage(message),
        onerror: (error) => this.handlers.onError?.(error),
        onclose: () => this.handlers.onTurnComplete?.({ closed: true }),
      },
    });
  }

  handleMessage(message) {
    if (!message.serverContent) {
      return;
    }

    const { serverContent } = message;

    if (serverContent.interrupted) {
      this.handlers.onInterrupted?.();
    }

    if (serverContent.inputTranscription?.text) {
      this.handlers.onText?.({
        role: 'user',
        text: serverContent.inputTranscription.text,
        mode: 'replace',
      });
    }

    if (serverContent.outputTranscription?.text) {
      this.handlers.onText?.({
        role: 'model',
        text: serverContent.outputTranscription.text,
        mode: 'replace',
      });
    }

    if (serverContent.modelTurn?.parts?.length) {
      for (const part of serverContent.modelTurn.parts) {
        if (part.thought || part.inlineData?.mimeType?.includes('thought')) {
          continue;
        }

        if (part.inlineData?.mimeType?.startsWith('audio/pcm')) {
          this.handlers.onAudio?.({
            mimeType: part.inlineData.mimeType,
            data: part.inlineData.data,
          });
        }
      }
    }

    if (serverContent.turnComplete) {
      this.handlers.onTurnComplete?.({ closed: false });
    }
  }

  sendAudioChunk(base64Pcm) {
    this.session?.sendRealtimeInput({
      media: {
        mimeType: 'audio/pcm;rate=16000',
        data: base64Pcm,
      },
    });
  }

  close() {
    this.session?.close();
    this.session = null;
  }
}
