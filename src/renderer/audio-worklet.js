/* PCM framing for the bounded encrypted WebSocket fallback. */
class RelayAudioCapture extends AudioWorkletProcessor {
  constructor(options) {
    super(); const config = options?.processorOptions || {};
    this.channels = config.channels === 2 ? 2 : 1;
    this.frames = Math.round(sampleRate * (config.frameMillis === 40 ? .04 : .2));
    this.float32 = config.float32 === true;
    this.frame = new Int16Array(this.frames * this.channels); this.offset = 0; this.energy = 0;
    this.floats = this.float32 ? new Float32Array(this.frame.length) : null;
    this.port.onmessage = event => { if (event.data === 'stop') this.stopped = true; };
  }
  process(inputs, outputs) {
    // The node is connected to the destination to keep processing scheduled,
    // but captured microphone samples are never played on this device.
    for (const output of outputs) for (const channel of output) channel.fill(0);
    if (this.stopped) return false;
    const input = inputs[0]?.[0]; if (!input) return true;
    for (let i = 0; i < input.length; i++) {
      for (let channel = 0; channel < this.channels; channel++) {
        const value = (inputs[0][channel] || input)[i];
        const sample = Number.isFinite(value) ? Math.max(-1, Math.min(1, value)) : 0;
        this.energy += sample * sample;
        if (this.floats) this.floats[this.offset] = sample;
        this.frame[this.offset++] = Math.round(sample * 32767);
      }
      if (this.offset === this.frame.length) {
        const buffer = this.frame.buffer, floats = this.floats?.buffer;
        this.port.postMessage({ buffer, ...(floats ? { floats } : {}), sampleRate, channels:this.channels, frames:this.frames, sampleCount: this.frame.length, meanSquareEnergy: this.energy / this.frame.length }, floats ? [buffer, floats] : [buffer]);
        this.frame = new Int16Array(this.frames * this.channels); this.floats = this.float32 ? new Float32Array(this.frame.length) : null; this.offset = 0; this.energy = 0;
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
      const channels = item.channels === 2 ? 2 : 1;
      if (item.buffer.byteLength % (channels * 2)) return;
      const frame = {samples:new Int16Array(item.buffer), channels};
      // Bounded latency: discard stale buffered sound rather than accumulating it.
      if (this.queue.length >= 3) { this.queue.shift(); this.offset = 0; }
      this.queue.push(frame);
    };
  }
  process(inputs, outputs) {
    if (this.stopped) return false;
    const output = outputs[0]?.[0]; if (!output) return true;
    for (const channel of outputs[0]) channel.fill(0);
    for (let i = 0; i < output.length; i++) {
      if (!this.queue.length) continue;
      const frame = this.queue[0];
      for (let channel = 0; channel < outputs[0].length; channel++) outputs[0][channel][i] = frame.samples[this.offset + Math.min(channel, frame.channels - 1)] / 32768;
      this.offset += frame.channels;
      if (this.offset >= frame.samples.length) { this.queue.shift(); this.offset = 0; }
    }
    return true;
  }
}
registerProcessor('auralink-relay-capture', RelayAudioCapture);
registerProcessor('auralink-relay-playback', RelayAudioPlayback);
// Native Android playback capture enters an outgoing graph, never speakers.
registerProcessor('auralink-device-audio', RelayAudioPlayback);
