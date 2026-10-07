/* A small WebRTC mesh. No CDN dependencies and no media capture on construction. */
export class RelayBudget {
  constructor({ seconds = 0, bytes = 0 } = {}) {
    this.secondsLimit = Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds, 3600) : 0;
    this.bytesLimit = Number.isFinite(bytes) && bytes > 0 ? Math.min(bytes, 1024 * 1024 * 1024) : 0;
    this.peers = new Map(); this.bytes = 0; this.seconds = 0; this.exhausted = false;
  }
  observe(id, { relay, bytes, now }) {
    if (this.exhausted || !Number.isFinite(bytes) || bytes < 0 || !Number.isFinite(now)) return this.exhausted;
    const previous = this.peers.get(id);
    if (relay) {
      this.bytes += previous ? Math.max(0, bytes - previous.bytes) : bytes;
      if (previous?.relay) this.seconds += Math.max(0, now - previous.now) / 1000;
    }
    this.peers.set(id, { relay, bytes, now });
    this.exhausted = Boolean((this.secondsLimit && this.seconds >= this.secondsLimit) || (this.bytesLimit && this.bytes >= this.bytesLimit));
    return this.exhausted;
  }
}
export class RoomRTC extends EventTarget {
  constructor({ selfId, signal, iceServers = [], iceTransportPolicy = 'all', relaySecondsLimit = 0, relayBytesLimit = 0 }) {
    super();
    this.selfId = selfId;
    this.signal = signal;
    this.iceServers = iceServers;
    this.peers = new Map();
    this.localTracks = new Map();
    this.previousStats = new Map();
    this.closed = false;
    this.iceTransportPolicy = iceTransportPolicy === 'relay' ? 'relay' : 'all';
    this.relayBudget = new RelayBudget({ seconds: relaySecondsLimit, bytes: relayBytesLimit });
    this.budgetTimer = (relaySecondsLimit > 0 || relayBytesLimit > 0) ? setInterval(() => { if (!this.closed) void this.stats(); }, 1000) : null;
  }

  emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }

  addPeer(peer) {
    if (peer.id === this.selfId || this.peers.has(peer.id) || this.closed) return;
    const pc = new RTCPeerConnection({ iceServers: this.iceServers, iceTransportPolicy: this.iceTransportPolicy, bundlePolicy: 'max-bundle' });
    const entry = {
      info: peer, pc, senders: new Map(), remoteKinds: {}, remoteMids: {}, remoteState: {},
      remoteTracks: new Map(), inactiveRemoteTracks: new Map(), polite: this.selfId.localeCompare(peer.id) > 0,
      makingOffer: false, ignoreOffer: false, settingAnswer: false, queue: Promise.resolve(), channel: null,
    };
    this.peers.set(peer.id, entry);
    pc.onicecandidate = ({ candidate }) => { if (candidate) this.send(peer.id, { candidate: candidate.toJSON() }); };
    pc.onconnectionstatechange = () => this.emit('connection', { peerId: peer.id, state: pc.connectionState });
    pc.oniceconnectionstatechange = () => this.emit('connection', { peerId: peer.id, state: pc.connectionState, iceState: pc.iceConnectionState });
    pc.ontrack = ({ track, streams, transceiver }) => {
      const kind = entry.remoteKinds[track.id] || entry.remoteMids[transceiver.mid] || (track.kind === 'audio' ? 'audio' : 'camera');
      const stream = streams[0] || new MediaStream([track]);
      if (entry.remoteState[kind] === false) entry.inactiveRemoteTracks.set(kind, { track, stream });
      else {
        entry.inactiveRemoteTracks.delete(kind); entry.remoteTracks.set(kind, { track, stream });
        this.emit('track', { peerId: peer.id, kind, track, stream });
      }
      track.onended = () => this.removeRemoteTrack(peer.id, kind, track.id);
    };
    pc.ondatachannel = ({ channel }) => this.setupChannel(peer.id, channel);
    pc.onnegotiationneeded = async () => {
      try {
        entry.makingOffer = true;
        await pc.setLocalDescription();
        this.sendDescription(entry);
      } catch (error) {
        if (!this.closed && pc.signalingState !== 'closed') this.emit('error', { peerId: peer.id, error });
      } finally { entry.makingOffer = false; }
      // Sender tuning can wait on browser negotiation internals. It must not
      // keep the perfect-negotiation offer flag set after SDP has been sent.
      void this.setVideoLimits();
    };
    for (const [kind, item] of this.localTracks) entry.senders.set(kind, pc.addTrack(item.track, item.stream));
    if (this.selfId.localeCompare(peer.id) < 0) this.setupChannel(peer.id, pc.createDataChannel('auralink-input', { ordered: true }));
    this.emit('connection', { peerId: peer.id, state: 'new' });
  }

  setupChannel(peerId, channel) {
    const entry = this.peers.get(peerId);
    if (!entry || channel.label !== 'auralink-input') { channel.close(); return; }
    if (entry.channel && entry.channel !== channel) entry.channel.close();
    entry.channel = channel;
    channel.onopen = () => this.emit('channel', { peerId, open: true });
    channel.onclose = () => this.emit('channel', { peerId, open: false });
    channel.onmessage = ({ data }) => {
      if (typeof data !== 'string' || data.length > 4096) return;
      try { this.emit('data', { peerId, data: JSON.parse(data) }); } catch { /* Invalid peer message. */ }
    };
  }

  send(peerId, data) { if (!this.closed) this.signal(peerId, data); }

  sendDescription(entry) {
    const trackKinds = {}; const midKinds = {};
    for (const [kind, item] of this.localTracks) trackKinds[item.track.id] = kind;
    for (const transceiver of entry.pc.getTransceivers()) {
      const kind = trackKinds[transceiver.sender.track?.id];
      if (kind && transceiver.mid !== null) midKinds[transceiver.mid] = kind;
    }
    this.send(entry.info.id, {
      description: entry.pc.localDescription.toJSON(), trackKinds, midKinds,
      mediaState: this.mediaState(),
    });
  }

  receive(peerId, data) {
    const entry = this.peers.get(peerId);
    if (!entry || !data || this.closed) return;
    entry.queue = entry.queue.then(async () => {
      if (this.closed || this.peers.get(peerId) !== entry) return;
      if (data.mediaState) this.applyMediaState(peerId, data.mediaState);
      if (data.description) {
        const { pc } = entry;
        const description = data.description;
        const readyForOffer = !entry.makingOffer && (pc.signalingState === 'stable' || entry.settingAnswer);
        const collision = description.type === 'offer' && !readyForOffer;
        entry.ignoreOffer = !entry.polite && collision;
        if (entry.ignoreOffer) return;
        entry.remoteKinds = data.trackKinds || {};
        entry.remoteMids = data.midKinds || {};
        entry.settingAnswer = description.type === 'answer';
        try { await pc.setRemoteDescription(description); }
        finally { entry.settingAnswer = false; }
        if (this.closed || this.peers.get(peerId) !== entry) return;
        if (description.type === 'offer') {
          await pc.setLocalDescription();
          if (!this.closed && this.peers.get(peerId) === entry) this.sendDescription(entry);
        }
        // Never block the signaling queue behind setParameters: the awaited
        // answer/candidate may be the next message in this same queue.
        void this.setVideoLimits();
      } else if (data.candidate) {
        try { await entry.pc.addIceCandidate(data.candidate); }
        catch (error) { if (!entry.ignoreOffer) throw error; }
      }
    }).catch((error) => { if (!this.closed) this.emit('error', { peerId, error }); });
  }

  applyMediaState(peerId, state) {
    const entry = this.peers.get(peerId);
    if (!entry) return;
    for (const kind of ['audio', 'camera', 'screen']) if (typeof state[kind] === 'boolean') entry.remoteState[kind] = state[kind];
    for (const kind of ['audio', 'camera', 'screen']) {
      if (state[kind] === false) {
        const item = entry.remoteTracks.get(kind);
        if (item) { entry.inactiveRemoteTracks.set(kind, item); entry.remoteTracks.delete(kind); this.emit('track-removed', { peerId, kind }); }
      } else if (state[kind] === true && !entry.remoteTracks.has(kind)) {
        const item = entry.inactiveRemoteTracks.get(kind);
        if (item && item.track.readyState !== 'ended') {
          entry.inactiveRemoteTracks.delete(kind); entry.remoteTracks.set(kind, item);
          this.emit('track', { peerId, kind, track: item.track, stream: item.stream });
        }
      }
    }
    this.emit('media-state', { peerId, state });
  }

  removeRemoteTrack(peerId, kind, trackId) {
    const entry = this.peers.get(peerId);
    const item = entry?.remoteTracks.get(kind);
    const inactive = entry?.inactiveRemoteTracks.get(kind);
    if (inactive && (!trackId || inactive.track.id === trackId)) entry.inactiveRemoteTracks.delete(kind);
    if (!item || (trackId && item.track.id !== trackId)) return;
    entry.remoteTracks.delete(kind);
    this.emit('track-removed', { peerId, kind });
  }

  mediaState() {
    return Object.fromEntries(['audio', 'camera', 'screen'].map((kind) => [kind, Boolean(this.localTracks.get(kind)?.track.enabled)]));
  }

  async setTrack(kind, track, stream) {
    if (this.closed) { track?.stop(); return; }
    const old = this.localTracks.get(kind);
    if (old?.track === track) return;
    if (track) this.localTracks.set(kind, { track, stream }); else this.localTracks.delete(kind);
    for (const entry of this.peers.values()) {
      const sender = entry.senders.get(kind);
      if (sender) { entry.pc.removeTrack(sender); entry.senders.delete(kind); }
      if (track) entry.senders.set(kind, entry.pc.addTrack(track, stream));
      this.send(entry.info.id, { mediaState: this.mediaState() });
    }
    if (track?.kind === 'video') await this.setVideoLimits();
  }

  async setVideoLimits(quality = this.quality || 'auto') {
    this.quality = quality;
    const caps = { auto: 3500000, '720': 2200000, '1080': 4500000, '1440': 7000000 };
    for (const entry of this.peers.values()) {
      for (const [kind, sender] of entry.senders) {
        if (kind !== 'screen' && kind !== 'camera') continue;
        try {
          const params = sender.getParameters();
          if (!params.encodings?.length) params.encodings = [{}];
          const otherPeers = Math.max(1, this.peers.size);
          params.encodings[0].maxBitrate = Math.round((kind === 'screen' ? caps[quality] : 3000000) / (otherPeers > 2 ? 1.4 : 1));
          params.encodings[0].maxFramerate = 30;
          params.degradationPreference = kind === 'screen' ? 'maintain-resolution' : 'balanced';
          await sender.setParameters(params);
        } catch { /* Some WebRTC builds do not support all sender parameters. */ }
      }
    }
  }

  sendData(peerId, data) {
    const channel = this.peers.get(peerId)?.channel;
    if (channel?.readyState !== 'open' || channel.bufferedAmount > 65536) return false;
    try { channel.send(JSON.stringify(data)); return true; } catch { return false; }
  }

  removePeer(peerId) {
    const entry = this.peers.get(peerId);
    if (!entry) return;
    entry.channel?.close(); entry.pc.close(); this.peers.delete(peerId);
    this.previousStats.delete(peerId);
    this.relayBudget.peers.delete(peerId);
  }

  stats() {
    if (this.closed) return Promise.resolve([]);
    // Diagnostics and the relay guard share one snapshot. Overlapping reads
    // must not apply cumulative counters twice or revive a removed peer.
    if (this.statsPromise) return this.statsPromise;
    this.statsPromise = this.collectStats().finally(() => { this.statsPromise = null; });
    return this.statsPromise;
  }

  async collectStats() {
    const results = [];
    for (const [peerId, entry] of this.peers) {
      try {
        const report = await entry.pc.getStats();
        if (this.closed || this.peers.get(peerId) !== entry) continue;
        let pair = null; let transport = null; let receivedVideo = null; let sentVideo = null; let receivedAudio = null; let sentAudio = null; let audioSource = null;
        let totalReceived = 0; let totalSent = 0; let lost = 0; let packets = 0;
        report.forEach((row) => {
          if (row.type === 'transport' && row.selectedCandidatePairId) transport = row;
          if (row.type === 'candidate-pair' && row.state === 'succeeded' && row.nominated) pair = row;
          if (row.type === 'media-source' && row.kind === 'audio') audioSource = row;
          if (row.type === 'inbound-rtp' && !row.isRemote) {
            totalReceived += row.bytesReceived || 0; lost += row.packetsLost || 0; packets += row.packetsReceived || 0;
            if (row.kind === 'video' && (!receivedVideo || (row.frameWidth || 0) > (receivedVideo.frameWidth || 0))) receivedVideo = row;
            if (row.kind === 'audio' && (!receivedAudio || (row.bytesReceived || 0) > (receivedAudio.bytesReceived || 0))) receivedAudio = row;
          }
          if (row.type === 'outbound-rtp' && !row.isRemote) {
            totalSent += row.bytesSent || 0;
            if (row.kind === 'video' && (!sentVideo || (row.frameWidth || 0) > (sentVideo.frameWidth || 0))) sentVideo = row;
            if (row.kind === 'audio' && (!sentAudio || (row.bytesSent || 0) > (sentAudio.bytesSent || 0))) sentAudio = row;
          }
        });
        if (transport) pair = report.get(transport.selectedCandidatePairId) || pair;
        const candidate = pair && report.get(pair.localCandidateId);
        const remoteCandidate = pair && report.get(pair.remoteCandidateId);
        const relayed = candidate?.candidateType === 'relay' || remoteCandidate?.candidateType === 'relay';
        const now = performance.now(); const prev = this.previousStats.get(peerId); const seconds = prev ? (now - prev.now) / 1000 : 0;
        const measurement = {
          peerId, name: entry.info.name, state: entry.pc.connectionState,
          route: candidate ? (relayed ? 'Relay' : 'Direct') : null,
          protocol: candidate?.protocol || null,
          roundTripMs: pair?.currentRoundTripTime !== undefined ? Math.round(pair.currentRoundTripTime * 1000) : null,
          downloadMbps: seconds > 0 ? Math.max(0, (totalReceived - prev.received) * 8 / seconds / 1e6) : null,
          uploadMbps: seconds > 0 ? Math.max(0, (totalSent - prev.sent) * 8 / seconds / 1e6) : null,
          packetLoss: packets + lost > 0 ? 100 * Math.max(0, lost) / (packets + Math.max(0, lost)) : null,
          incoming: receivedVideo?.frameWidth ? `${receivedVideo.frameWidth} × ${receivedVideo.frameHeight}` : null,
          incomingCodec: receivedVideo?.codecId ? report.get(receivedVideo.codecId)?.mimeType || null : null,
          fps: receivedVideo?.framesPerSecond ?? null,
          outgoing: sentVideo?.frameWidth ? `${sentVideo.frameWidth} × ${sentVideo.frameHeight}` : null,
          outgoingCodec: sentVideo?.codecId ? report.get(sentVideo.codecId)?.mimeType || null : null,
          availableMbps: pair?.availableOutgoingBitrate ? pair.availableOutgoingBitrate / 1e6 : null,
          receivedAudioPackets: receivedAudio?.packetsReceived ?? null,
          sentAudioPackets: sentAudio?.packetsSent ?? null,
          receivedAudioEnergy: receivedAudio?.totalAudioEnergy ?? null,
          microphoneLevel: audioSource?.audioLevel ?? null,
          audioCodec: receivedAudio?.codecId ? report.get(receivedAudio.codecId)?.mimeType || null : sentAudio?.codecId ? report.get(sentAudio.codecId)?.mimeType || null : null,
        };
        this.previousStats.set(peerId, { now, received: totalReceived, sent: totalSent }); results.push(measurement);
        const bytes = (pair?.bytesReceived ?? totalReceived) + (pair?.bytesSent ?? totalSent);
        if (this.relayBudget.observe(peerId, { relay: relayed, bytes, now })) {
          // Closing transport and tracks happens before notifying the UI. This
          // local guard limits a session; provider quotas remain authoritative.
          this.close();
          this.emit('relay-budget', { reason: 'This room reached its free relay session allowance. Start a direct connection or try again later.', usedBytes: this.relayBudget.bytes, limitBytes: this.relayBudget.bytesLimit });
          break;
        }
      } catch { /* Closed or not yet negotiated peer. */ }
    }
    return results;
  }

  close() {
    this.closed = true;
    clearInterval(this.budgetTimer); this.budgetTimer = null;
    for (const peerId of [...this.peers.keys()]) this.removePeer(peerId);
    for (const { track } of this.localTracks.values()) track.stop();
    this.localTracks.clear();
  }
}
