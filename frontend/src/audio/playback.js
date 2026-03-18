import { decodeBase64Pcm } from './pcm';

export class StreamingAudioPlayer {
  constructor(sampleRate = 24000) {
    this.sampleRate = sampleRate;
    this.context = null;
    this.nextTime = 0;
    this.activeSources = new Set();
  }

  async init() {
    if (!this.context) {
      this.context = new AudioContext({ sampleRate: this.sampleRate });
    }

    if (this.context.state === 'suspended') {
      await this.context.resume();
    }
  }

  async enqueueBase64(base64) {
    await this.init();
    const pcm = decodeBase64Pcm(base64);
    const audioBuffer = this.context.createBuffer(1, pcm.length, this.sampleRate);
    audioBuffer.copyToChannel(pcm, 0);

    const source = this.context.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(this.context.destination);

    const startAt = Math.max(this.context.currentTime + 0.02, this.nextTime);
    source.start(startAt);
    this.nextTime = startAt + audioBuffer.duration;
    this.activeSources.add(source);
    source.onended = () => this.activeSources.delete(source);
  }

  clear() {
    for (const source of this.activeSources) {
      try {
        source.stop();
      } catch {
        // no-op
      }
    }

    this.activeSources.clear();
    this.nextTime = this.context ? this.context.currentTime : 0;
  }
}
