class PcmRecorderProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0];
    if (!input?.length) {
      return true;
    }

    const channel = input[0];
    this.port.postMessage(channel.slice(0));
    return true;
  }
}

registerProcessor('pcm-recorder-processor', PcmRecorderProcessor);
