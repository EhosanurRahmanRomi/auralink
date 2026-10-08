/* PCM framing for the bounded encrypted WebSocket fallback. */
class RelayAudioCapture extends AudioWorkletProcessor {
  constructor() {
    super(); this.frame = new Int16Array(Math.round(sampleRate / 5)); this.offset = 0; this.energy = 0;
    this.port.onmessage = event => { if (event.data === 'stop') this.stopped = true; };
  }
  process(inputs, outputs) {
    // The node is connected to the destination to keep processing scheduled,
    // but captured microphone samples are never played on this device.
    for (const output of outputs) for (const channel of output) channel.fill(0);
    if (this.stopped) return false;
    const input = inputs[0]?.[0]; if (!input) return true;
    for (let i = 0; i < input.length; i++) {
      const sample = Number.isFinite(input[i]) ? Math.max(-1, Math.min(1, input[i])) : 0;
      this.energy += sample * sample;
      this.frame[this.offset++] = Math.round(sample * 32767);
      if (this.offset === this.frame.length) {
        const buffer = this.frame.buffer; this.port.postMessage({ buffer, sampleRate, sampleCount: this.frame.length, meanSquareEnergy: this.energy / this.frame.length }, [buffer]);
        this.frame = new Int16Array(Math.round(sampleRate / 5)); this.offset = 0; this.energy = 0;
      }
    }
    return true;
  }
}
class RelayAudioPlayback extends AudioWorkletProcessor {
  constructor() {
    super(); this.queue = []; this.offset = 0; this.stopped = false;
    this.port.onmessage = event => {
      if (event.data === 'stop') { this.stopped = true; this.queue = []; return; }
      const item = event.data;
      if (this.stopped || !(item?.buffer instanceof ArrayBuffer) || item.buffer.byteLength < 2 || item.buffer.byteLength > 24000 || item.buffer.byteLength % 2) return;
      const frame = new Int16Array(item.buffer);
      // Bounded latency: discard stale buffered sound rather than accumulating it.
      if (this.queue.length >= 3) { this.queue.shift(); this.offset = 0; }
      this.queue.push(frame);
    };
  }
  process(inputs, outputs) {
    if (this.stopped) return false;
    const output = outputs[0]?.[0]; if (!output) return true;
    for (let i = 0; i < output.length; i++) {
      if (!this.queue.length) { output[i] = 0; continue; }
      output[i] = this.queue[0][this.offset++] / 32768;
      if (this.offset >= this.queue[0].length) { this.queue.shift(); this.offset = 0; }
    }
    for (let i = 1; i < outputs[0].length; i++) outputs[0][i].set(output);
    return true;
  }
}
registerProcessor('auralink-relay-capture', RelayAudioCapture);
registerProcessor('auralink-relay-playback', RelayAudioPlayback);
