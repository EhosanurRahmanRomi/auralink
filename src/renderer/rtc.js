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
  constructor({ selfId, signal, iceServers = [], iceTransportPolicy = 'all', relaySecondsLimit = 0, relayBytesLimit = 0, websocketRelayEnabled = false, relayKey, relayLimits = {} }) {
    super();
    this.selfId = selfId;
    this.signal = signal;
    this.iceServers = iceServers;
    this.peers = new Map();
    this.localTracks = new Map();
    this.previousStats = new Map();
    this.closed = false;
    this.websocketRelayEnabled = websocketRelayEnabled === true && typeof relayKey === 'string' && /^[A-Za-z0-9_-]{43}$/.test(relayKey);
    this.relayLimits = relayLimits; this.relayMedia = null;
    this.relayReady = this.websocketRelayEnabled ? import('./relay-media.js').then(({ RelayMedia }) => {
      if (!this.closed) this.relayMedia = new RelayMedia(this, relayKey);
      return this.relayMedia;
    }).catch(() => { if (!this.closed) this.emit('error', { error: new Error('Secure relay support could not load. Reinstall the current app.') }); return null; }) : Promise.resolve(null);
    this.networkOnline = () => { for (const entry of this.peers.values()) if (entry.pc.connectionState !== 'connected') this.recoverPeer(entry, 'network-change'); };
    globalThis.addEventListener?.('online', this.networkOnline);
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
      makingOffer: false, ignoreOffer: false, settingAnswer: false, queue: Promise.resolve(), mediaQueue: Promise.resolve(), channel: null,
      recoveryAttempts: 0, recoveryTimer: null, relayActive: false,
    };
    this.peers.set(peer.id, entry);
    pc.onicecandidate = ({ candidate }) => { if (candidate) this.send(peer.id, { candidate: candidate.toJSON() }); };
    pc.onconnectionstatechange = () => this.connectionChanged(entry);
    pc.oniceconnectionstatechange = () => this.connectionChanged(entry);
    pc.ontrack = ({ track, streams, transceiver }) => {
      if (this.closed || entry.relayActive || this.peers.get(peer.id) !== entry) return;
      const kind = entry.remoteKinds[track.id] || entry.remoteMids[transceiver.mid] || (track.kind === 'audio' ? 'audio' : 'screen');
      if (!['audio', 'screen'].includes(kind)) { track.stop(); return; }
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
    // One deterministic offerer establishes two permanent media slots. The
    // answerer reuses those offered transceivers instead of creating duplicate
    // m-lines. Toggling/restarting capture replaces a source without SDP glare.
    if (!entry.polite) {
      for (const kind of ['audio', 'screen']) {
        const transceiver = pc.addTransceiver(kind === 'audio' ? 'audio' : 'video', { direction: 'sendrecv' });
        entry.senders.set(kind, transceiver.sender);
      }
      void this.syncSenders(entry).catch(error => this.emit('error', { peerId: peer.id, error }));
      this.setupChannel(peer.id, pc.createDataChannel('auralink-input', { ordered: true }));
    }
    this.emit('connection', { peerId: peer.id, state: 'new' });
    this.scheduleRecovery(entry, 12000);
  }

  connectionChanged(entry) {
    if (this.closed || this.peers.get(entry.info.id) !== entry || entry.relayActive) return;
    const { pc } = entry;
    this.emit('connection', { peerId: entry.info.id, state: pc.connectionState, iceState: pc.iceConnectionState });
    if (pc.connectionState === 'connected') { clearTimeout(entry.recoveryTimer); entry.recoveryTimer = null; entry.recoveryAttempts = 0; }
    else if (pc.connectionState === 'failed' || pc.iceConnectionState === 'failed') this.scheduleRecovery(entry, 300);
    else if (pc.connectionState === 'disconnected' || pc.iceConnectionState === 'disconnected') this.scheduleRecovery(entry, 3000);
  }

  scheduleRecovery(entry, milliseconds) {
    if (entry.recoveryTimer || entry.relayActive || this.closed) return;
    entry.recoveryTimer = setTimeout(() => { entry.recoveryTimer = null; this.recoverPeer(entry, 'connection-timeout'); }, milliseconds);
  }

  async recoverPeer(entry, reason) {
    if (this.closed || entry.relayActive || this.peers.get(entry.info.id) !== entry || entry.pc.connectionState === 'connected') return;
    clearTimeout(entry.recoveryTimer); entry.recoveryTimer = null;
    if (this.websocketRelayEnabled) { await this.activateRelay(entry); return; }
    if (entry.recoveryAttempts >= 3) { this.emit('connection', { peerId: entry.info.id, state: 'failed', reason: 'This network needs a relay connection. Rejoin or use a different network.' }); return; }
    entry.recoveryAttempts++;
    try { entry.pc.restartIce(); } catch { /* The peer may have closed during recovery. */ }
    this.emit('connection', { peerId: entry.info.id, state: 'connecting', recovering: true, reason });
    this.scheduleRecovery(entry, 8000 * entry.recoveryAttempts);
  }

  async activateRelay(entry) {
    if (!entry || this.closed || !this.websocketRelayEnabled || entry.relayActive || this.peers.get(entry.info.id) !== entry) return false;
    const media = await this.relayReady;
    if (!media || this.closed || !this.websocketRelayEnabled || entry.relayActive || this.peers.get(entry.info.id) !== entry) return false;
    entry.relayActive = true; clearTimeout(entry.recoveryTimer); entry.recoveryTimer = null;
    // A fallback has one route. Closing the failed RTC path prevents duplicate
    // audio or later transport callbacks from replacing the relayed tracks.
    entry.channel?.close(); entry.channel = null;
    for (const kind of [...entry.remoteTracks.keys()]) this.removeRemoteTrack(entry.info.id, kind);
    entry.inactiveRemoteTracks.clear(); entry.pc.close(); media.activate(entry.info.id);
    return true;
  }

  async useSecureRelay(peerId) {
    if (this.closed) throw new Error('This room has closed. Open or join a room again.');
    if (!this.websocketRelayEnabled) throw new Error('Secure relay is unavailable in this room. Use an internet invitation room to retry.');
    const media = await this.relayReady;
    if (!media || this.closed || !this.websocketRelayEnabled) throw new Error('Secure relay is unavailable. Rejoin the room to retry.');
    const entries = peerId === undefined ? [...this.peers.values()] : [this.peers.get(peerId)].filter(Boolean);
    let activated = 0;
    for (const entry of entries) {
      if (entry.relayActive || this.peers.get(entry.info.id) !== entry) continue;
      const changed = await this.activateRelay(entry);
      if (changed && entry.relayActive && this.peers.get(entry.info.id) === entry) activated++;
    }
    return activated;
  }

  resumePlayback() { return this.relayMedia ? this.relayMedia.resumePlayback() : this.relayReady.then(media => media?.resumePlayback()); }

  stopWebsocketRelay(reason = 'The secure relay allowance has been reached. Try later or use Nearby.') {
    this.websocketRelayEnabled = false; this.relayMedia?.close();
    for (const entry of this.peers.values()) if (entry.relayActive) {
      entry.relayActive = false; this.emit('channel', { peerId: entry.info.id, open: false });
      this.emit('connection', { peerId: entry.info.id, state: 'failed', reason });
    }
    this.emit('error', { error: new Error(reason) });
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
    if (this.closed || this.peers.get(entry.info.id) !== entry) return;
    const trackKinds = {}; const midKinds = {};
    for (const [kind, item] of this.localTracks) trackKinds[item.track.id] = kind;
    for (const transceiver of entry.pc.getTransceivers()) {
      const kind = [...entry.senders].find(([, sender]) => sender === transceiver.sender)?.[0];
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
    if (data.relay) {
      if (Object.keys(data).length !== 1 || !this.websocketRelayEnabled) return;
      void this.relayReady.then(async media => {
        if (!media || this.closed || !this.websocketRelayEnabled || this.peers.get(peerId) !== entry) return;
        // Authentication happens before a packet can activate this transport.
        // RelayMedia validates/decrypts and then activates after a valid hello.
        media.receive(peerId, data.relay);
      });
      return;
    }
    if (entry.relayActive) return;
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
          if (!entry.senders?.size && entry.pc.getTransceivers) {
            for (const transceiver of pc.getTransceivers()) {
              const kind = entry.remoteMids[transceiver.mid];
              if (!['audio', 'screen'].includes(kind) || entry.senders.has(kind)) continue;
              transceiver.direction = 'sendrecv'; entry.senders.set(kind, transceiver.sender);
            }
            if (entry.senders.size !== 2) throw new Error('Use matching Glance-Port versions for this media connection.');
            await this.syncSenders(entry);
            if (this.closed || this.peers.get(peerId) !== entry) return;
          }
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
    for (const kind of ['audio', 'screen']) if (typeof state[kind] === 'boolean') entry.remoteState[kind] = state[kind];
    for (const kind of ['audio', 'screen']) {
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
    return Object.fromEntries(['audio', 'screen'].map((kind) => {
      const track = this.localTracks.get(kind)?.track;
      return [kind, Boolean(track?.enabled && track.readyState !== 'ended')];
    }));
  }

  captureState(kind) {
    const track = this.localTracks.get(kind)?.track;
    if (!track) return 'off';
    if (track.readyState === 'ended') return 'ended';
    if (!track.enabled) return 'off';
    return track.muted ? 'paused' : 'live';
  }

  watchLocalTrack(kind, item) {
    const { track } = item;
    if (!track.addEventListener) return;
    const changed = () => {
      if (this.closed || this.localTracks.get(kind) !== item) return;
      this.emit('capture-state', { kind, track, state: this.captureState(kind) });
    };
    const ended = () => {
      if (this.closed || this.localTracks.get(kind) !== item) return;
      // Device removal/privacy revocation can end a source while the renderer
      // is awaiting another operation. Stop transport without that UI wait.
      void this.setTrack(kind, null).catch(error => { if (!this.closed) this.emit('error', { error }); });
      this.emit('capture-state', { kind, track, state: 'ended' });
    };
    track.addEventListener('mute', changed); track.addEventListener('unmute', changed); track.addEventListener('ended', ended);
    item.unwatch = () => { track.removeEventListener('mute', changed); track.removeEventListener('unmute', changed); track.removeEventListener('ended', ended); };
  }

  async setTrack(kind, track, stream) {
    if (this.closed) { track?.stop(); return; }
    if (!['audio', 'screen'].includes(kind)) { track?.stop(); throw new Error('Choose microphone audio or screen sharing.'); }
    if (track && (track.kind !== (kind === 'audio' ? 'audio' : 'video') || track.readyState === 'ended')) throw new Error('The selected capture has ended or is unavailable. Start it again.');
    const old = this.localTracks.get(kind);
    if (old?.track === track) return;
    old?.unwatch?.();
    if (track) { const item = { track, stream }; this.localTracks.set(kind, item); this.watchLocalTrack(kind, item); }
    else this.localTracks.delete(kind);
    // The relay source must not wait on another peer's browser sender or
    // negotiation. Otherwise one stalled/rejected replaceTrack mutes everyone
    // already using the relay, even though capture itself remains live.
    this.relayMedia?.state();
    const replacements = [];
    for (const entry of this.peers.values()) {
      replacements.push(this.syncSenders(entry).catch(async error => {
        if (this.closed || entry.relayActive || this.peers.get(entry.info.id) !== entry) return;
        this.emit('error', { peerId: entry.info.id, error });
        if (this.websocketRelayEnabled) await this.activateRelay(entry);
      }));
      this.send(entry.info.id, { mediaState: this.mediaState() });
    }
    await Promise.all(replacements);
    if (track?.kind === 'video') await this.setVideoLimits();
  }

  syncSenders(entry) {
    entry.mediaQueue = (entry.mediaQueue || Promise.resolve()).catch(() => {}).then(async () => {
      if (this.closed || entry.relayActive || this.peers.get(entry.info.id) !== entry) return;
      for (const [kind, sender] of entry.senders) {
        const desired = this.localTracks.get(kind)?.track || null;
        if (sender.track !== desired) await sender.replaceTrack(desired);
        if (this.closed || entry.relayActive || this.peers.get(entry.info.id) !== entry) return;
      }
    });
    return entry.mediaQueue;
  }

  async setVideoLimits(quality = this.quality || 'auto') {
    this.quality = quality;
    const caps = { auto: 3500000, '720': 2200000, '1080': 4500000, '1440': 7000000 };
    for (const entry of this.peers.values()) {
      for (const [kind, sender] of entry.senders) {
        if (kind !== 'screen') continue;
        if (!sender.track) continue;
        try {
          const params = sender.getParameters();
          if (!params.encodings?.length) params.encodings = [{}];
          const otherPeers = Math.max(1, this.peers.size);
          params.encodings[0].maxBitrate = Math.round(caps[quality] / (otherPeers > 2 ? 1.4 : 1));
          params.encodings[0].maxFramerate = 30;
          params.degradationPreference = 'maintain-resolution';
          await sender.setParameters(params);
        } catch { /* Some WebRTC builds do not support all sender parameters. */ }
      }
    }
  }

  sendData(peerId, data) {
    if (this.peers.get(peerId)?.relayActive) return this.relayMedia?.send(peerId, { type: 'data', data }) || false;
    const channel = this.peers.get(peerId)?.channel;
    if (channel?.readyState !== 'open' || channel.bufferedAmount > 65536) return false;
    try { channel.send(JSON.stringify(data)); return true; } catch { return false; }
  }

  removePeer(peerId) {
    const entry = this.peers.get(peerId);
    if (!entry) return;
    clearTimeout(entry.recoveryTimer); this.relayMedia?.removePeer(peerId);
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
        if (entry.relayActive) {
          const peer = this.relayMedia?.peers.get(peerId); if (!peer) continue;
          const screen = this.relayMedia.sources.get('screen');
          const now = performance.now(); const prev = this.previousStats.get(peerId); const seconds = prev ? (now - prev.now) / 1000 : 0;
          results.push({ peerId, name: entry.info.name, state: 'connected', route: 'Secure relay', protocol: 'TLS / WebSocket',
            incoming: peer.width ? `${peer.width} × ${peer.height}` : null, incomingCodec: peer.width ? peer.codec || 'JPEG · compatibility' : null,
            outgoing: this.relayMedia.sources.get('screen')?.width ? `${this.relayMedia.sources.get('screen').width} × ${this.relayMedia.sources.get('screen').height}` : null,
            outgoingCodec: this.relayMedia.sources.get('screen')?.codec?.startsWith('avc1') ? 'H.264' : this.relayMedia.sources.get('screen')?.codec === 'vp8' ? 'VP8' : null,
            fps: seconds > 0 ? Math.round((peer.frames - (prev.frames || 0)) / seconds) : null,
            downloadMbps: seconds > 0 ? Math.max(0, (peer.received - prev.received) * 8 / seconds / 1e6) : null,
            uploadMbps: seconds > 0 ? Math.max(0, (peer.sent - prev.sent) * 8 / seconds / 1e6) : null,
            receivedAudioPackets: peer.audioPackets, audioCodec: 'PCM mono', roundTripMs: null, packetLoss: null,
            captureBackend: screen?.captureBackend || null, capturedFrames: screen?.capturedFrames ?? null, captureError: screen?.captureError || null,
            microphoneState: this.captureState('audio'), ...this.relayMedia.audioDiagnostics?.(peerId) });
          this.previousStats.set(peerId, { now, received: peer.received, sent: peer.sent, frames: peer.frames }); continue;
        }
        const report = await entry.pc.getStats();
        if (this.closed || this.peers.get(peerId) !== entry) continue;
        let pair = null; let transport = null; let receivedVideo = null; let sentVideo = null; let receivedAudio = null; let sentAudio = null;
        const audioSources = [];
        let totalReceived = 0; let totalSent = 0; let lost = 0; let packets = 0;
        report.forEach((row) => {
          if (row.type === 'transport' && row.selectedCandidatePairId) transport = row;
          if (row.type === 'candidate-pair' && row.state === 'succeeded' && row.nominated) pair = row;
          if (row.type === 'media-source' && row.kind === 'audio') audioSources.push(row);
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
        // Chromium can retain a retired source row after replaceTrack. A
        // zero level from that row must not report a live new input as silent.
        const microphone = this.localTracks.get('audio')?.track;
        const linkedAudioSource = sentAudio?.mediaSourceId ? report.get(sentAudio.mediaSourceId) : null;
        const audioSource = microphone && microphone.readyState !== 'ended' ?
          audioSources.find(row => row.trackIdentifier === microphone.id) ||
          (linkedAudioSource && (!linkedAudioSource.trackIdentifier || linkedAudioSource.trackIdentifier === microphone.id) ? linkedAudioSource : null) ||
          audioSources.find(row => !row.trackIdentifier) || null : null;
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
          microphoneState: this.captureState('audio'),
          sentAudioBytes: sentAudio?.bytesSent ?? null,
          receivedAudioBytes: receivedAudio?.bytesReceived ?? null,
          capturedAudioDuration: audioSource?.totalSamplesDuration ?? null,
          capturedAudioEnergy: audioSource?.totalAudioEnergy ?? null,
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
    globalThis.removeEventListener?.('online', this.networkOnline); this.relayMedia?.close();
    clearInterval(this.budgetTimer); this.budgetTimer = null;
    for (const peerId of [...this.peers.keys()]) this.removePeer(peerId);
    for (const item of this.localTracks.values()) { item.unwatch?.(); item.track.stop(); }
    this.localTracks.clear();
  }
}
