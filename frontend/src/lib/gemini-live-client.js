import { GoogleGenAI } from '@google/genai';

const DEFAULT_MODEL = 'gemini-2.0-flash-exp';
const DEFAULT_VOICE = 'Aoede';

export class GeminiLiveBridge {
  constructor({ apiKey, onAudio, onText, onInterrupted, onTurnComplete, onError }) {
    this.ai = new GoogleGenAI({ apiKey });
    this.session = null;
    this.handlers = { onAudio, onText, onInterrupted, onTurnComplete, onError };
  }

  async connect() {
    this.session = await this.ai.live.connect({
      model: DEFAULT_MODEL,
      config: {
        systemInstruction: {
            parts: [{
                text: "Anda adalah asisten AI yang ramah dan membantu. Tolong bicara dan merespons dalam Bahasa Indonesia yang alami dan sopan. Gunakan nada bicara yang hangat."
            }]
        },
        responseModalities: ['AUDIO'],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: {
              voiceName: DEFAULT_VOICE,
            },
          },
        },
        inputAudioTranscription: {
            languageCode: "id-ID"
        },
        outputAudioTranscription: {},
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
    if (message.serverContent) {
      const { serverContent } = message;

      if (serverContent.interrupted) {
        this.handlers.onInterrupted?.();
      }

      if (serverContent.inputTranscription?.text) {
        this.handlers.onText?.({ role: 'user', text: serverContent.inputTranscription.text });
      }

      if (serverContent.outputTranscription?.text) {
        this.handlers.onText?.({ role: 'model', text: serverContent.outputTranscription.text });
      }

      if (serverContent.modelTurn?.parts?.length) {
        for (const part of serverContent.modelTurn.parts) {
          if (part.inlineData?.mimeType?.startsWith('audio/pcm')) {
            this.handlers.onAudio?.({
              mimeType: part.inlineData.mimeType,
              data: part.inlineData.data,
            });
          }

          if (part.text) {
            this.handlers.onText?.({ role: 'model', text: part.text });
          }
        }
      }

      if (serverContent.turnComplete) {
        this.handlers.onTurnComplete?.({ closed: false });
      }
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
