/* Only owner-enabled capture sources enter this graph. Incoming room audio is
 * never connected: local sound stays local and remote speech is not re-sent. */
export class CaptureAudioMixer {
  constructor() {
    this.context = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
    this.destination = this.context.createMediaStreamDestination();
    this.destination.channelCount = 2; this.destination.channelCountMode = 'explicit';
    this.inputs = new Map(); this.closed = false;
    this.track = this.destination.stream.getAudioTracks()[0];
    this.track.contentHint = 'music';
  }
  async setSources(microphone, device) {
    if (this.closed) throw new Error('Audio sharing has ended.');
    const desired = new Map([['microphone', microphone], ['device', device]].filter(([, track]) => track?.readyState === 'live'));
    for (const [kind, input] of this.inputs) if (desired.get(kind) !== input.track) {
      input.source.disconnect(); input.gain.disconnect(); this.inputs.delete(kind);
    }
    for (const [kind, track] of desired) if (!this.inputs.has(kind)) {
      const source = this.context.createMediaStreamSource(new MediaStream([track]));
      const gain = this.context.createGain(); source.connect(gain); gain.connect(this.destination);
      this.inputs.set(kind, { source, gain, track });
    }
    // Mixing two full-scale sources requires headroom without a compressor
    // altering music dynamics. A single source keeps its original level.
    for (const input of this.inputs.values()) input.gain.gain.value = this.inputs.size > 1 ? .5 : 1;
    await this.context.resume();
  }
  close() {
    if (this.closed) return; this.closed = true;
    for (const input of this.inputs.values()) { input.source.disconnect(); input.gain.disconnect(); }
    this.inputs.clear(); this.track.stop(); void this.context.close().catch(() => {});
    // Input tracks belong to their separate microphone/device consent toggles.
  }
}
