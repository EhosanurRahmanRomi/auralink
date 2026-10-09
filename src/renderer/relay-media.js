/* Bounded TCP fallback when direct WebRTC cannot connect. WebCodecs compresses
 * desktop screen frames; JPEG remains an explicit compatibility fallback.
 * The coordinator supplies the room key; it is not a trustless key exchange.
 */
const text = new TextEncoder();
export const MAX_RELAY_PLAIN_BYTES = 179984;
const validId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const FRAME_FRAGMENT_BYTES = 160000, MAX_ENCODED_FRAME_BYTES = 768000;
const MAX_VIDEO_PIXELS = 2560 * 1440;
const CODECS = ['avc1.420033', 'vp8'];
const base64Alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
function canonicalBase64(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value) || value.length % 4 === 1) return false;
  const remainder = value.length % 4, last = base64Alphabet.indexOf(value.at(-1));
  return remainder !== 2 && remainder !== 3 || (remainder === 2 ? (last & 15) === 0 : (last & 3) === 0);
}
function base64(bytes) {
  let result = ''; for (let offset = 0; offset < bytes.length; offset += 8192) result += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  return btoa(result).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function unbase64(value) {
  const raw = atob(value.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, char => char.charCodeAt(0));
}
export function validRelayEnvelope(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== 'ciphertext,counter,epoch,nonce,version') return false;
  if (value.version !== 1 || !Number.isSafeInteger(value.counter) || value.counter < 1 ||
      !/^[A-Za-z0-9_-]{16}$/.test(value.epoch) || !/^[A-Za-z0-9_-]{16}$/.test(value.nonce) ||
      typeof value.ciphertext !== 'string' || value.ciphertext.length < 22 || value.ciphertext.length > 240000 || !canonicalBase64(value.ciphertext)) return false;
  const bytes = Math.floor(value.ciphertext.length * 3 / 4); return bytes >= 16 && bytes <= 180000;
}
function nonce(epoch, counter) {
  const result = new Uint8Array(12); result.set(unbase64(epoch).subarray(0, 4));
  new DataView(result.buffer).setBigUint64(4, BigInt(counter)); return result;
}
function context(from, to, epoch, counter) { return text.encode(JSON.stringify(['auralink-relay-v1', from, to, epoch, counter])); }
export class RelayCipher {
  constructor(roomKey, selfId, peerId) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(roomKey) || !canonicalBase64(roomKey) || !validId(selfId) || !validId(peerId) || selfId === peerId) throw new Error('Invalid relay membership.');
    this.selfId = selfId; this.peerId = peerId; this.closed = false; this.counter = 0;
    this.epoch = base64(crypto.getRandomValues(new Uint8Array(12)));
    this.secret = crypto.subtle.importKey('raw', unbase64(roomKey), 'HKDF', false, ['deriveKey']);
    this.receiveEpoch = null; this.receiveCounter = 0; this.retiredEpochs = new Set(); this.keys = new Map();
  }
  key(from, to, epoch) {
    const id = `${from}/${to}/${epoch}`;
    if (!this.keys.has(id)) {
      this.keys.set(id, this.secret.then(secret => crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256',
        salt: text.encode('auralink-relay-v1'), info: text.encode(id) }, secret, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])));
    }
    return this.keys.get(id);
  }
  async seal(bytes) {
    if (this.closed || !(bytes instanceof Uint8Array) || bytes.length > MAX_RELAY_PLAIN_BYTES || this.counter >= Number.MAX_SAFE_INTEGER) return null;
    const counter = ++this.counter; const iv = nonce(this.epoch, counter);
    const key = await this.key(this.selfId, this.peerId, this.epoch);
    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: context(this.selfId, this.peerId, this.epoch, counter) }, key, bytes);
    if (this.closed) return null;
    return { version: 1, epoch: this.epoch, counter, nonce: base64(iv), ciphertext: base64(new Uint8Array(ciphertext)) };
  }
  async open(envelope) {
    if (this.closed || !validRelayEnvelope(envelope) || this.retiredEpochs.has(envelope.epoch) ||
        (this.receiveEpoch === envelope.epoch && envelope.counter <= this.receiveCounter) || base64(nonce(envelope.epoch, envelope.counter)) !== envelope.nonce) return null;
    // Bound key derivations before authentication, including adversarial epochs.
    if (this.keys.size >= 12 && !this.keys.has(`${this.peerId}/${this.selfId}/${envelope.epoch}`)) return null;
    let bytes;
    try {
      const key = await this.key(this.peerId, this.selfId, envelope.epoch);
      bytes = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unbase64(envelope.nonce),
        additionalData: context(this.peerId, this.selfId, envelope.epoch, envelope.counter) }, key, unbase64(envelope.ciphertext));
    } catch { return null; }
    if (this.closed || (this.receiveEpoch === envelope.epoch && envelope.counter <= this.receiveCounter)) return null;
    if (this.receiveEpoch && this.receiveEpoch !== envelope.epoch) {
      if (this.retiredEpochs.size >= 8) return null;
      this.retiredEpochs.add(this.receiveEpoch);
    }
    this.receiveEpoch = envelope.epoch; this.receiveCounter = envelope.counter;
    return new Uint8Array(bytes);
  }
  close() { this.closed = true; this.keys.clear(); this.secret = null; }
}
function pack(header, payload = new Uint8Array()) {
  const metadata = text.encode(JSON.stringify(header)); if (metadata.length > 2048) throw new Error('Relay metadata is too large.');
  const result = new Uint8Array(2 + metadata.length + payload.length); new DataView(result.buffer).setUint16(0, metadata.length);
  result.set(metadata, 2); result.set(payload, 2 + metadata.length); return result;
}
function unpack(bytes) {
  if (bytes.length < 2 || bytes.length > MAX_RELAY_PLAIN_BYTES) return null;
  const length = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint16(0);
  if (length > 2048 || length + 2 > bytes.length) return null;
  try { return { header: JSON.parse(new TextDecoder().decode(bytes.subarray(2, length + 2))), payload: bytes.slice(length + 2) }; } catch { return null; }
}
function h264Dimensions(nal) {
  // We negotiate baseline AVC only. Read the SPS dimensions before handing an
  // admitted peer's bitstream to a decoder that can allocate native surfaces.
  if (nal.length < 5 || nal.length > 512) return null;
  const rbsp = []; let zeros = 0;
  for (const byte of nal.subarray(1)) { if (zeros >= 2 && byte === 3) { zeros = 0; continue; } rbsp.push(byte); zeros = byte === 0 ? zeros + 1 : 0; }
  let bit = 0;
  const read = count => { if (count > 31 || bit + count > rbsp.length * 8) throw new Error(); let value = 0;
    while (count--) { value = value * 2 + ((rbsp[bit >> 3] >> (7 - (bit & 7))) & 1); bit++; } return value; };
  const ue = () => { let leading = 0; while (read(1) === 0) if (++leading > 20) throw new Error(); return 2 ** leading - 1 + read(leading); };
  try {
    if (read(8) !== 66) return null; read(8); read(8); ue(); ue();
    const order = ue(); if (order === 0) ue();
    else if (order === 1) { read(1); ue(); ue(); const cycle = ue(); if (cycle > 16) return null; for (let i = 0; i < cycle; i++) ue(); }
    else if (order !== 2) return null;
    ue(); read(1); const widthMB = ue() + 1, heightMap = ue() + 1; const frameOnly = read(1); if (!frameOnly) read(1); read(1);
    let left = 0, right = 0, top = 0, bottom = 0; if (read(1)) { left = ue(); right = ue(); top = ue(); bottom = ue(); }
    return { width: widthMB * 16 - 2 * (left + right), height: heightMap * 16 * (2 - frameOnly) - 2 * (2 - frameOnly) * (top + bottom) };
  } catch { return null; }
}
export function validEncodedVideo(codec, bytes, width, height, keyFrame) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 3 || bytes.length > MAX_ENCODED_FRAME_BYTES) return false;
  if (codec === 'vp8') {
    const key = (bytes[0] & 1) === 0; if (key !== keyFrame) return false;
    return !key || (bytes.length >= 10 && bytes[3] === 0x9d && bytes[4] === 1 && bytes[5] === 0x2a &&
      ((bytes[6] | bytes[7] << 8) & 16383) === width && ((bytes[8] | bytes[9] << 8) & 16383) === height);
  }
  if (!codec.startsWith('avc1')) return false;
  let start = -1, sawNAL = false, sawSPS = false;
  const check = end => {
    if (start < 0 || start >= end) return true; sawNAL = true;
    if ((bytes[start] & 31) !== 7) return true;
    sawSPS = true; const size = h264Dimensions(bytes.subarray(start, end));
    return size?.width === width && size?.height === height;
  };
  for (let index = 0; index < bytes.length - 2; index++) {
    if (bytes[index] === 0 && bytes[index + 1] === 0 && (bytes[index + 2] === 1 || (bytes[index + 2] === 0 && bytes[index + 3] === 1))) {
      if (!check(index)) return false; const prefix = bytes[index + 2] === 1 ? 3 : 4; start = index + prefix; index += prefix - 1;
    }
  }
  return check(bytes.length) && sawNAL && (!keyFrame || sawSPS);
}
function validJPEGDimensions(bytes, width, height) {
  if (bytes.length < 14 || bytes[0] !== 255 || bytes[1] !== 216) return false;
  let offset = 2, found = false;
  while (offset < bytes.length - 1) {
    if (bytes[offset++] !== 255) return false;
    while (bytes[offset] === 255) offset++;
    const marker = bytes[offset++]; if (marker === 218 || marker === 217) return found;
    if (marker === 1 || marker >= 208 && marker <= 216) continue;
    if (offset + 2 > bytes.length) return false;
    const length = bytes[offset] * 256 + bytes[offset + 1]; if (length < 2 || offset + length > bytes.length) return false;
    if (marker === 192 || marker === 194) {
      if (length < 8 || bytes[offset + 3] * 256 + bytes[offset + 4] !== height || bytes[offset + 5] * 256 + bytes[offset + 6] !== width) return false;
      found = true;
    } else if (marker >= 192 && marker <= 207 && ![196, 200, 204].includes(marker)) return false;
    offset += length;
  }
  return false;
}
export class RelayMedia {
  constructor(rtc, key) {
    this.rtc = rtc; this.key = key; this.peers = new Map(); this.sources = new Map(); this.closed = false;
    this.audioContexts = new Set(); this.audioModules = new WeakMap(); this.audioContextRoles = new WeakMap();
    this.hardwarePreferences = new Map();
    this.capabilities = this.codecCapabilities();
    this.audioCapabilities = this.audioCodecCapabilities();
  }
  async audioCodecCapabilities() {
    if (typeof AudioEncoder !== 'function' || typeof AudioDecoder !== 'function' || typeof AudioData !== 'function' || typeof EncodedAudioChunk !== 'function') return [];
    try {
      const encoder = await AudioEncoder.isConfigSupported({codec:'opus', sampleRate:48000, numberOfChannels:2, bitrate:192000});
      const decoder = await AudioDecoder.isConfigSupported({codec:'opus', sampleRate:48000, numberOfChannels:2});
      return encoder.supported && decoder.supported ? ['opus'] : [];
    } catch { return []; }
  }
  async codecCapabilities() {
    if (typeof VideoEncoder !== 'function' || typeof VideoDecoder !== 'function' || typeof VideoFrame !== 'function') return [];
    const supported = [];
    for (const codec of CODECS) {
      try {
        const decoder = await VideoDecoder.isConfigSupported({ codec, optimizeForLatency: true });
        if (!decoder.supported) continue;
        for (const hardwareAcceleration of ['prefer-hardware', 'no-preference']) {
          let encoder; try { encoder = await VideoEncoder.isConfigSupported({ codec, width: 1920, height: 1080, bitrate: 3500000,
            framerate: 30, latencyMode: 'realtime', bitrateMode: 'variable', hardwareAcceleration,
            ...(codec.startsWith('avc1') ? { avc: { format: 'annexb' } } : {}) }); } catch { continue; }
          if (encoder.supported) { this.hardwarePreferences.set(codec, hardwareAcceleration); supported.push(codec); break; }
        }
      } catch { /* Try the next codec; support is engine specific. */ }
    }
    return supported;
  }
  addPeer(id) {
    if (!this.peers.has(id)) this.peers.set(id, { cipher: new RelayCipher(this.key, this.rtc.selfId, id), active: false,
      sendQueue: Promise.resolve(), receiveQueue: Promise.resolve(), pending: 0, pendingAudio:0, pendingMetadata: 0, pendingData: 0, pendingVideo: 0, outputs: new Map(), sent: 0, received: 0, frames: 0, audioPackets: 0, sentAudioPackets: 0, needsKey: true, videoCodecs: null, audioCodecs:[] });
    return this.peers.get(id);
  }
  activate(id) {
    const peer = this.addPeer(id); if (peer.active || this.closed) return;
    peer.active = true; peer.startedAt = performance.now();
    void Promise.all([this.capabilities, this.audioCapabilities]).then(([videoCodecs, audioCodecs]) => {
      if (this.closed || this.peers.get(id) !== peer || !peer.active) return;
      this.send(id, { type: 'hello', videoCodecs, audioCodecs });
      const source = this.sources.get('screen'); if (source) source.forceKey = true;
    });
    this.send(id, { type: 'state', mediaState: this.rtc.mediaState() });
    for (const kind of this.rtc.localTracks.keys()) void this.syncSource(kind);
    this.rtc.emit('connection', { peerId: id, state: 'connected', route: 'Secure relay' });
    this.rtc.emit('channel', { peerId: id, open: true });
  }
  send(id, header, bytes) {
    const peer = this.peers.get(id);
    const data = header?.type === 'data', metadata = ['hello', 'state', 'keyframe', 'codec-reject', 'audio-codec-reject'].includes(header?.type);
    const queue = data ? 'pendingData' : metadata ? 'pendingMetadata' : header?.type === 'audio' ? 'pendingAudio' : 'pending';
    if (this.closed || !peer?.active || (data && peer.dataFailed) || this.rtc.closed || !this.rtc.peers.has(id)) return false;
    if (header?.type === 'state') peer.deferredState = null;
    if (peer[queue] >= (data ? 16 : metadata ? 8 : 3)) {
      // A mute/start snapshot must survive a full media queue: losing it can
      // leave the receiver rejecting every subsequent screen/audio packet.
      // Keep only the newest snapshot if even the metadata queue is full.
      if (header?.type === 'state') { peer.deferredState = { ...header, mediaState: { ...header.mediaState } }; return true; }
      return false;
    }
    if (data) {
      try { const serialized = JSON.stringify(header.data); if (typeof serialized !== 'string' || serialized.length > 4096 || bytes?.length) return false; }
      catch { return false; }
    }
    let packet; try { packet = pack(header, bytes); } catch { return false; }
    if (packet.length > MAX_RELAY_PLAIN_BYTES) return false;
    peer[queue]++;
    peer.sendQueue = peer.sendQueue.catch(() => {}).then(async () => {
      if (this.closed || !peer.active || (data && peer.dataFailed) || this.peers.get(id) !== peer || !this.rtc.peers.has(id)) return;
      const envelope = await peer.cipher.seal(packet);
      if (envelope && !this.closed && peer.active && this.peers.get(id) === peer && this.rtc.peers.has(id)) {
        const result = this.rtc.signal(id, { relay: envelope });
        if (result !== false) { peer.sent += packet.length; if (header?.type === 'audio') peer.sentAudioPackets++; }
        else if (data) this.failData(id, peer);
      } else if (data) this.failData(id, peer);
    }).catch(() => {
      if (data) this.failData(id, peer);
      else if (!this.closed && this.peers.get(id) === peer && this.rtc.peers.has(id)) this.rtc.emit('error', { peerId: id, error: new Error('The secure relay could not send media. Rejoin the room to retry.') });
    })
      .finally(() => {
        peer[queue]--;
        if (peer.deferredState && peer.pendingMetadata < 8 && !this.closed && peer.active && this.peers.get(id) === peer) {
          const state = peer.deferredState; peer.deferredState = null; this.send(id, state);
        }
      });
    return true;
  }
  failData(id, peer) {
    if (this.closed || this.rtc.closed || !peer.active || peer.dataFailed || peer.cipher.closed || this.peers.get(id) !== peer || !this.rtc.peers.has(id)) return;
    peer.dataFailed = true; this.rtc.emit('channel', { peerId: id, open: false });
  }
  sendVideo(id, header, bytes) {
    const peer = this.peers.get(id);
    if (this.closed || !peer?.active || !this.rtc.peers.has(id) || peer.pendingVideo >= 2 || !(bytes instanceof Uint8Array) || bytes.length < 1 || bytes.length > MAX_ENCODED_FRAME_BYTES ||
        (peer.needsKey && header.chunkType !== 'key')) return false;
    const count = Math.ceil(bytes.length / FRAME_FRAGMENT_BYTES);
    const packets = Array.from({ length: count }, (_, index) => pack({ ...header, index, count, total: bytes.length }, bytes.subarray(index * FRAME_FRAGMENT_BYTES, (index + 1) * FRAME_FRAGMENT_BYTES)));
    peer.pendingVideo++;
    if (header.chunkType === 'key') peer.needsKey = false;
    peer.sendQueue = peer.sendQueue.catch(() => {}).then(async () => {
      for (const packet of packets) {
        if (this.closed || !peer.active || this.peers.get(id) !== peer || !this.rtc.peers.has(id)) return;
        const envelope = await peer.cipher.seal(packet);
        if (!envelope || this.closed || !peer.active || this.peers.get(id) !== peer || !this.rtc.peers.has(id)) return;
        if (this.rtc.signal(id, { relay: envelope }) === false) { peer.needsKey = true; this.requestSourceKey(); return; }
        peer.sent += packet.length;
      }
    }).catch(() => { peer.needsKey = true; this.requestSourceKey(); }).finally(() => { peer.pendingVideo--; });
    return true;
  }
  requestSourceKey() { const source = this.sources.get('screen'); if (source) source.forceKey = true; }
  retireStream(peer, stream) {
    if (!stream) return; if (!peer.retiredStreams) peer.retiredStreams = new Set();
    peer.retiredStreams.add(stream); if (peer.retiredStreams.size > 16) peer.retiredStreams.delete(peer.retiredStreams.values().next().value);
  }
  requestPeerKey(id, peer) {
    if (performance.now() - (peer.lastKeyRequest || -1000) < 500) return;
    peer.lastKeyRequest = performance.now(); this.send(id, { type: 'keyframe' });
  }
  receive(id, envelope) {
    if (this.closed || !this.rtc.peers.has(id) || !validRelayEnvelope(envelope)) return;
    const peer = this.addPeer(id);
    if ((peer.receiving || 0) >= 32) { this.failData(id, peer); peer.decoderNeedsKey = true; this.requestPeerKey(id, peer); return; }
    peer.receiving = (peer.receiving || 0) + 1;
    peer.receiveQueue = peer.receiveQueue.catch(() => {}).then(async () => {
      const bytes = await peer.cipher.open(envelope);
      if (!bytes || this.closed || this.peers.get(id) !== peer || !this.rtc.peers.has(id)) return;
      const item = unpack(bytes); if (!item) return;
      const { header, payload } = item;
      if (!['hello', 'state', 'video', 'video-chunk', 'keyframe', 'codec-reject', 'audio-codec-reject', 'audio', 'data'].includes(header?.type)) return;
      peer.received += bytes.length;
      if (!peer.active) await this.rtc.activateRelay(this.rtc.peers.get(id));
      if (!peer.active || this.closed || this.peers.get(id) !== peer) return;
      if (header.type === 'hello') {
        peer.videoCodecs = Array.isArray(header.videoCodecs) ? header.videoCodecs.filter(codec => CODECS.includes(codec)) : [];
        peer.audioCodecs = Array.isArray(header.audioCodecs) && header.audioCodecs.includes('opus') ? ['opus'] : [];
        this.requestSourceKey();
      } else if (header.type === 'keyframe') this.requestSourceKey();
      else if (header.type === 'codec-reject' && CODECS.includes(header.codec)) { peer.videoCodecs = (peer.videoCodecs || []).filter(codec => codec !== header.codec); this.requestSourceKey(); }
      else if (header.type === 'audio-codec-reject' && header.codec === 'opus') peer.audioCodecs = [];
      else if (header.type === 'state') {
        if (!header.mediaState || typeof header.mediaState !== 'object') return;
        this.rtc.applyMediaState(id, header.mediaState);
        for (const kind of ['audio', 'screen']) if (header.mediaState[kind] === false) this.removeOutput(id, kind);
      } else if (header.type === 'video') await this.video(id, peer, header, payload);
      else if (header.type === 'video-chunk') await this.videoChunk(id, peer, header, payload);
      else if (header.type === 'audio') await this.audio(id, peer, header, payload);
      else if (header.type === 'data' && !peer.dataFailed && payload.length === 0 && JSON.stringify(header.data).length <= 4096) this.rtc.emit('data', { peerId: id, data: header.data });
    }).catch(() => { /* A malformed or interrupted media frame is discarded. */ }).finally(() => { peer.receiving--; });
  }
  async resumePlayback() { await Promise.all([...this.audioContexts].map(context => context.resume().catch(() => {}))); this.playbackState(); }
  playbackState() {
    if (this.closed) return;
    const blocked = [...this.audioContexts].some(context => this.audioContextRoles.get(context) !== 'capture' && ['suspended', 'interrupted'].includes(context.state));
    this.rtc.emit('playback-blocked', { blocked });
    this.rtc.emit('relay-audio-state', { captureContextState: this.sources.get('audio')?.context?.state || 'off', playbackBlocked: blocked });
  }
  watchAudioContext(context, role = 'playback') {
    this.audioContextRoles.set(context, role);
    this.audioContexts.add(context); context.onstatechange = () => this.playbackState(); this.playbackState();
  }
  audioDiagnostics(id) {
    const source = this.sources.get('audio'), peer = this.peers.get(id);
    return { captureContextState: source?.context?.state || 'off', playbackContextState: peer?.outputs.get('audio')?.context?.state || 'off',
      sentAudioPackets: peer?.sentAudioPackets || 0, capturedAudioPackets: source?.audioPackets || 0, capturedAudioSamples: source?.audioSamples || 0,
      audioCodec:peer?.outputs.get('audio')?.codec === 'opus' ? 'Opus · 48 kHz stereo' : peer?.outputs.get('audio') ? `${peer.outputs.get('audio').sampleRate / 1000} kHz PCM ${peer.outputs.get('audio').channels === 2 ? 'stereo' : 'mono'}` : null,
      capturedAudioEnergy: source?.audioMeanSquareEnergy ?? null, microphoneLevel: Number.isFinite(source?.audioMeanSquareEnergy) ? Math.sqrt(source.audioMeanSquareEnergy) : null };
  }
  async audioModule(context) {
    if (!this.audioModules.has(context)) this.audioModules.set(context, context.audioWorklet.addModule(new URL('./audio-worklet.js', import.meta.url)));
    return this.audioModules.get(context);
  }
  output(id, kind, track, stream, resources) {
    const peer = this.peers.get(id); if (!peer || this.closed || !this.rtc.peers.has(id)) { track.stop(); return; }
    this.removeOutput(id, kind, true);
    peer.outputs.set(kind, { track, stream, ...resources });
    const entry = this.rtc.peers.get(id); entry.remoteTracks.set(kind, { track, stream }); entry.inactiveRemoteTracks.delete(kind);
    this.rtc.emit('track', { peerId: id, kind, track, stream });
  }
  async video(id, peer, header, payload) {
    if (header.kind !== 'screen' || payload.length < 4 || payload.length > 110000 ||
        !Number.isInteger(header.width) || !Number.isInteger(header.height) || header.width < 1 || header.height < 1 || header.width > 1920 || header.height > 1920 || header.width * header.height > 2200000 ||
        (header.stream !== undefined && (!/^[A-Za-z0-9_-]{16}$/.test(header.stream) || peer.retiredStreams?.has(header.stream)))) return;
    if (this.rtc.peers.get(id)?.remoteState[header.kind] === false) return;
    if (!validJPEGDimensions(payload, header.width, header.height)) return;
    const bitmap = await createImageBitmap(new Blob([payload], { type: 'image/jpeg' }));
    try {
      if (this.closed || this.peers.get(id) !== peer || !peer.active || this.rtc.peers.get(id)?.remoteState.screen === false || bitmap.width !== header.width || bitmap.height !== header.height) return;
      if (peer.decoder) { try { peer.decoder.close(); } catch {} this.retireStream(peer, peer.decoderStream); peer.decoder = null; peer.decoderNeedsKey = true; }
      let output = peer.outputs.get(header.kind);
      if (!output) {
        const canvas = document.createElement('canvas'); canvas.width = header.width; canvas.height = header.height;
        let track, writer;
        if (typeof MediaStreamTrackGenerator === 'function') { track = new MediaStreamTrackGenerator({ kind: 'video' }); writer = track.writable.getWriter(); }
        else track = canvas.captureStream(0).getVideoTracks()[0];
        this.output(id, header.kind, track, new MediaStream([track]), { canvas, writer, count: 0 }); output = peer.outputs.get(header.kind);
      }
      if (!output) return;
      if (peer.jpegStream !== header.stream) { this.retireStream(peer, peer.jpegStream); peer.jpegStream = header.stream; }
      output.canvas.width = header.width; output.canvas.height = header.height; output.canvas.getContext('2d').drawImage(bitmap, 0, 0);
      if (output.writer) {
        const frame = new VideoFrame(bitmap, { timestamp: Math.round(performance.now() * 1000) });
        try { await output.writer.write(frame); } finally { frame.close(); }
      } else output.track.requestFrame?.();
      if (this.closed || this.peers.get(id) !== peer || peer.outputs.get(header.kind) !== output || this.rtc.peers.get(id)?.remoteState.screen === false) return;
      output.count++; peer.frames++; peer.width = header.width; peer.height = header.height; peer.codec = 'JPEG · compatibility';
    } finally { bitmap.close(); }
  }
  async videoChunk(id, peer, header, payload) {
    const integer = (value, low, high) => Number.isSafeInteger(value) && value >= low && value <= high;
    if (header.kind !== 'screen' || !CODECS.includes(header.codec) || !/^[A-Za-z0-9_-]{16}$/.test(header.stream) ||
        peer.retiredStreams?.has(header.stream) ||
        !integer(header.sequence, 1, Number.MAX_SAFE_INTEGER) || !integer(header.index, 0, 4) || !integer(header.count, 1, 5) || header.index >= header.count ||
        !integer(header.total, 1, MAX_ENCODED_FRAME_BYTES) || header.count !== Math.ceil(header.total / FRAME_FRAGMENT_BYTES) ||
        payload.length !== Math.min(FRAME_FRAGMENT_BYTES, header.total - header.index * FRAME_FRAGMENT_BYTES) ||
        !integer(header.width, 2, 2560) || !integer(header.height, 2, 2560) || header.width * header.height > MAX_VIDEO_PIXELS ||
        !['key', 'delta'].includes(header.chunkType) || !integer(header.timestamp, 0, Number.MAX_SAFE_INTEGER) ||
        (header.description !== undefined && (typeof header.description !== 'string' || header.description.length > 1400 || !canonicalBase64(header.description))) ||
        typeof VideoDecoder !== 'function' || this.rtc.peers.get(id)?.remoteState.screen === false) return;
    const signature = JSON.stringify([header.stream, header.sequence, header.codec, header.width, header.height, header.chunkType, header.timestamp, header.description || '', header.total, header.count]);
    let assembly = peer.assembly;
    if (!assembly || assembly.signature !== signature) {
      if (assembly) { clearTimeout(assembly.timer); peer.decoderNeedsKey = true; this.requestPeerKey(id, peer); }
      if (header.index !== 0) { peer.assembly = null; peer.decoderNeedsKey = true; this.requestPeerKey(id, peer); return; }
      assembly = { signature, header, bytes: new Uint8Array(header.total), next: 0 };
      assembly.timer = setTimeout(() => { if (peer.assembly === assembly) { peer.assembly = null; peer.decoderNeedsKey = true; this.requestPeerKey(id, peer); } }, 2000);
      peer.assembly = assembly;
    }
    if (header.index !== assembly.next) { clearTimeout(assembly.timer); peer.assembly = null; peer.decoderNeedsKey = true; this.requestPeerKey(id, peer); return; }
    assembly.bytes.set(payload, header.index * FRAME_FRAGMENT_BYTES); assembly.next++;
    if (assembly.next !== header.count) return;
    clearTimeout(assembly.timer); peer.assembly = null;
    if (!validEncodedVideo(header.codec, assembly.bytes, header.width, header.height, header.chunkType === 'key')) { peer.decoderNeedsKey = true; this.requestPeerKey(id, peer); return; }
    const changed = peer.decoderStream !== header.stream || peer.decoderCodec !== header.codec || peer.decoderWidth !== header.width || peer.decoderHeight !== header.height;
    if (!changed && peer.videoSequence && header.sequence <= peer.videoSequence) return;
    const gap = !changed && peer.videoSequence && header.sequence !== peer.videoSequence + 1;
    peer.videoSequence = header.sequence;
    if (changed || gap || peer.decoderNeedsKey || !peer.decoder || peer.decoder.state === 'closed') {
      if (header.chunkType !== 'key') { peer.decoderNeedsKey = true; this.requestPeerKey(id, peer); return; }
      // An admitted sender still cannot churn hardware codec allocations.
      if (performance.now() - (peer.lastDecoderConfig || -1000) < 250) { peer.decoderNeedsKey = true; this.requestPeerKey(id, peer); return; }
      peer.lastDecoderConfig = performance.now();
      try { peer.decoder?.close(); } catch {} peer.decoder = null; peer.decoderNeedsKey = true;
      const config = { codec: header.codec, codedWidth: header.width, codedHeight: header.height, optimizeForLatency: true,
        ...(header.description ? { description: unbase64(header.description) } : {}) };
      let supported; try { supported = await VideoDecoder.isConfigSupported(config); } catch { return; }
      if (!supported.supported) { this.send(id, { type: 'codec-reject', codec: header.codec }); return; }
      if (this.closed || this.peers.get(id) !== peer || !peer.active || this.rtc.peers.get(id)?.remoteState.screen === false) return;
      const decoder = new VideoDecoder({ output: frame => {
        if (this.closed || this.peers.get(id) !== peer || peer.decoder !== decoder || !peer.active || this.rtc.peers.get(id)?.remoteState.screen === false) { frame.close(); return; }
        if ((peer.outputPending || 0) >= 2) { frame.close(); return; }
        peer.outputPending = (peer.outputPending || 0) + 1;
        peer.outputQueue = (peer.outputQueue || Promise.resolve()).catch(() => {}).then(async () => {
          if (!this.closed && this.peers.get(id) === peer && peer.decoder === decoder && peer.active && this.rtc.peers.get(id)?.remoteState.screen !== false) await this.decodedVideo(id, peer, frame, header.codec);
        }).catch(() => {}).finally(() => { frame.close(); peer.outputPending--; });
      }, error: () => { if (!this.closed && this.peers.get(id) === peer && peer.decoder === decoder) {
        peer.decoderNeedsKey = true; peer.decodeFailures = (peer.decodeFailures || 0) + 1;
        if (peer.decodeFailures >= 3) this.send(id, { type: 'codec-reject', codec: header.codec }); else this.requestPeerKey(id, peer);
      } } });
      try { decoder.configure(supported.config); } catch { decoder.close(); this.send(id, { type: 'codec-reject', codec: header.codec }); return; }
      if (peer.decoderStream !== header.stream) this.retireStream(peer, peer.decoderStream);
      this.retireStream(peer, peer.jpegStream); peer.jpegStream = undefined;
      peer.decoder = decoder; peer.decoderStream = header.stream; peer.decoderCodec = header.codec; peer.decoderWidth = header.width; peer.decoderHeight = header.height; peer.decoderNeedsKey = false;
    }
    if (peer.decoder.decodeQueueSize >= 2) { peer.decoderNeedsKey = true; this.requestPeerKey(id, peer); return; }
    try { peer.decoder.decode(new EncodedVideoChunk({ type: header.chunkType, timestamp: header.timestamp, data: assembly.bytes })); }
    catch { peer.decoderNeedsKey = true; this.requestPeerKey(id, peer); }
  }
  async decodedVideo(id, peer, frame, codec) {
    const width = frame.displayWidth, height = frame.displayHeight;
    if (!width || !height || width * height > MAX_VIDEO_PIXELS || width > 2560 || height > 2560) return;
    let output = peer.outputs.get('screen');
    if (!output) {
      const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
      let track, writer;
      if (typeof MediaStreamTrackGenerator === 'function') { track = new MediaStreamTrackGenerator({ kind: 'video' }); writer = track.writable.getWriter(); }
      else track = canvas.captureStream(0).getVideoTracks()[0];
      this.output(id, 'screen', track, new MediaStream([track]), { canvas, writer, count: 0 }); output = peer.outputs.get('screen');
    }
    if (!output) return;
    if (output.writer) await output.writer.write(frame);
    else { output.canvas.width = width; output.canvas.height = height; output.canvas.getContext('2d').drawImage(frame, 0, 0); output.track.requestFrame?.(); }
    if (this.closed || this.peers.get(id) !== peer || peer.outputs.get('screen') !== output) return;
    output.count++; peer.frames++; peer.width = width; peer.height = height; peer.codec = codec.startsWith('avc1') ? 'H.264' : 'VP8'; peer.decodeFailures = 0;
  }
  async audio(id, peer, header, payload) {
    const channels = header.channels === undefined ? 1 : header.channels;
    const codec = header.codec === undefined || header.codec === 'pcm' ? 'pcm' : header.codec;
    if (![1,2].includes(channels) || ![24000, 48000, 44100].includes(header.sampleRate) || !['pcm','opus'].includes(codec)) return;
    if (codec === 'pcm' && (payload.length < 2 || payload.length > 24000 || payload.length % (channels * 2))) return;
    if (codec === 'opus' && (header.sampleRate !== 48000 || channels !== 2 || payload.length < 1 || payload.length > 4096 || !Number.isSafeInteger(header.timestamp) || header.timestamp < 0 || !/^[A-Za-z0-9_-]{16}$/.test(header.stream || '') || (header.description !== undefined && (typeof header.description !== 'string' || header.description.length > 172 || !canonicalBase64(header.description))))) return;
    if (this.rtc.peers.get(id)?.remoteState.audio === false) return;
    let output = peer.outputs.get('audio');
    if (!output) {
      let context;
      try {
        context = new AudioContext({ sampleRate: header.sampleRate, latencyHint: 'interactive' }); this.watchAudioContext(context, 'playback');
        await this.audioModule(context);
        if (this.closed || this.peers.get(id) !== peer || !peer.active || !this.rtc.peers.has(id) || this.rtc.peers.get(id)?.remoteState.audio === false) { this.audioContexts.delete(context); await context.close(); return; }
        const node = new AudioWorkletNode(context, 'auralink-relay-playback', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [channels] });
        const destination = context.createMediaStreamDestination(); node.connect(destination);
        destination.channelCount = channels; destination.channelCountMode = 'explicit';
        const track = destination.stream.getAudioTracks()[0];
        this.output(id, 'audio', track, destination.stream, { context, node, sampleRate: header.sampleRate, channels }); output = peer.outputs.get('audio');
        void context.resume().catch(() => {}); this.playbackState();
      } catch (error) {
        this.audioContexts.delete(context); await context?.close().catch(() => {});
        if (!peer.audioErrorNotified && !this.closed && this.peers.get(id) === peer) {
          peer.audioErrorNotified = true; this.rtc.emit('error', { peerId: id, error: new Error('Incoming relay audio could not start. Open Check sound and enable sound, or rejoin the room.') });
        }
        throw error;
      }
    }
    if (!output || output.sampleRate !== header.sampleRate || output.channels !== channels) {
      if (output) this.removeOutput(id, 'audio'); return;
    }
    if (codec === 'opus') {
      if (output.opusRejected) return;
      if (typeof AudioDecoder !== 'function' || typeof EncodedAudioChunk !== 'function') { output.opusRejected = true; this.send(id,{type:'audio-codec-reject',codec:'opus'}); return; }
      if (!output.audioDecoder || output.audioStream !== header.stream) {
        try { output.audioDecoder?.close(); } catch {}
        const stream = header.stream;
        let decoder;
        try {
          decoder = new AudioDecoder({output:data => {
            try {
              if (this.closed || this.peers.get(id) !== peer || peer.outputs.get('audio') !== output || output.audioDecoder !== decoder || output.audioStream !== stream || this.rtc.peers.get(id)?.remoteState.audio === false || data.numberOfChannels !== 2 || data.sampleRate !== 48000 || data.numberOfFrames < 1 || data.numberOfFrames > 5760) return;
              const pcm = new Int16Array(data.numberOfFrames * 2);
              for (let channel=0; channel<2; channel++) {
                const plane = new Float32Array(data.numberOfFrames); data.copyTo(plane,{planeIndex:channel,format:'f32-planar'});
                for (let frame=0;frame<plane.length;frame++) pcm[frame*2+channel] = Math.round(Math.max(-1,Math.min(1,Number.isFinite(plane[frame]) ? plane[frame] : 0))*32767);
              }
              output.node.port.postMessage({buffer:pcm.buffer,channels:2},[pcm.buffer]); peer.audioPackets++;
            } finally { data.close(); }
          }, error:() => {
            if (this.closed || peer.outputs.get('audio') !== output || output.audioDecoder !== decoder) return;
            output.opusRejected = true; this.send(id,{type:'audio-codec-reject',codec:'opus'});
            try { decoder.close(); } catch {} output.audioDecoder = null;
          }});
          decoder.configure({codec:'opus',sampleRate:48000,numberOfChannels:2,...(header.description ? {description:unbase64(header.description)} : {})});
          output.audioDecoder = decoder; output.audioStream = stream;
        } catch { try { decoder?.close(); } catch {} output.opusRejected = true; this.send(id,{type:'audio-codec-reject',codec:'opus'}); return; }
      }
      if (output.audioDecoder.decodeQueueSize >= 4) return;
      try { output.audioDecoder.decode(new EncodedAudioChunk({type:'key', timestamp:header.timestamp, data:payload})); output.codec = 'opus'; }
      catch { output.opusRejected = true; this.send(id,{type:'audio-codec-reject',codec:'opus'}); }
      return;
    }
    try { output.audioDecoder?.close(); } catch {} output.audioDecoder = null; output.audioStream = null; output.codec = 'pcm';
    const buffer = payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength);
    output.node.port.postMessage({ buffer, channels }, [buffer]); peer.audioPackets++;
  }
  async syncSource(kind) {
    const current = this.rtc.localTracks.get(kind); const old = this.sources.get(kind);
    if (old?.track === current?.track) return;
    this.stopSource(kind);
    if (!current || this.closed || ![...this.peers.values()].some(peer => peer.active)) return;
    const source = { track: current.track, active: true, pending: false, instance: base64(crypto.getRandomValues(new Uint8Array(12))) }; this.sources.set(kind, source);
    const valid = () => !this.closed && source.active && this.sources.get(kind) === source && this.rtc.localTracks.get(kind)?.track === source.track;
    if (kind === 'audio') {
      let context;
      try {
        context = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' }); source.context = context; this.watchAudioContext(context, 'capture');
        await this.audioModule(context); if (!valid()) { await context.close(); return; }
        if ((await this.audioCapabilities).includes('opus') && valid()) {
          try {
            source.audioEncoder = new AudioEncoder({output:(chunk, metadata) => {
              if (!valid() || !source.opusReady || !current.track.enabled || chunk.byteLength > 4096) return;
              const description = metadata?.decoderConfig?.description;
              if (description && description.byteLength <= 128) source.audioDescription = base64(new Uint8Array(description));
              const bytes = new Uint8Array(chunk.byteLength); chunk.copyTo(bytes);
              for (const [id, peer] of this.peers) if (peer.active && peer.audioCodecs.includes('opus')) this.send(id,{type:'audio',codec:'opus',sampleRate:48000,channels:2,timestamp:chunk.timestamp,stream:source.instance,...(source.audioDescription ? {description:source.audioDescription} : {})},bytes);
            }, error:() => { source.opusReady = false; }});
            source.audioEncoder.configure({codec:'opus',sampleRate:48000,numberOfChannels:2,bitrate:192000}); source.opusReady = true;
          } catch { source.opusReady = false; }
        }
        if (!valid()) { try { source.audioEncoder?.close(); } catch {} await context.close(); return; }
        source.input = context.createMediaStreamSource(new MediaStream([current.track]));
        source.node = new AudioWorkletNode(context, 'auralink-relay-capture', {channelCount:2,channelCountMode:'explicit',processorOptions:{channels:2,frameMillis:40,float32:true}}); source.input.connect(source.node); source.node.connect(context.destination);
        source.node.port.onmessage = event => {
          if (!valid() || !current.track.enabled || !(event.data?.buffer instanceof ArrayBuffer)) return;
          const bytes = new Uint8Array(event.data.buffer);
          if (!bytes.length || bytes.length > 24000 || bytes.length % 4 || event.data.channels !== 2 || event.data.sampleRate !== 48000) return;
          source.audioPackets = (source.audioPackets || 0) + 1; source.audioSamples = (source.audioSamples || 0) + bytes.length / 2;
          if (Number.isFinite(event.data.meanSquareEnergy) && event.data.meanSquareEnergy >= 0 && event.data.meanSquareEnergy <= 1) source.audioMeanSquareEnergy = event.data.meanSquareEnergy;
          const opusPeers = [...this.peers.values()].some(peer => peer.active && peer.audioCodecs.includes('opus'));
          if (source.opusReady && opusPeers && event.data.floats instanceof ArrayBuffer && source.audioEncoder.encodeQueueSize < 4) {
            let frame;
            try {
              source.audioTimestamp = (source.audioTimestamp || 0) + Math.round(event.data.frames * 1000000 / 48000);
              frame = new AudioData({format:'f32',sampleRate:48000,numberOfFrames:event.data.frames,numberOfChannels:2,timestamp:source.audioTimestamp,data:event.data.floats});
              source.audioEncoder.encode(frame);
            } catch { source.opusReady = false; } finally { frame?.close(); }
          }
          for (const [id, peer] of this.peers) if (peer.active && (!source.opusReady || !peer.audioCodecs.includes('opus'))) this.send(id, { type: 'audio', codec:'pcm', sampleRate:48000,channels:2 }, bytes);
        };
        void context.resume().catch(() => {}); this.playbackState();
      } catch (error) {
        const wasActive = valid(); this.audioContexts.delete(context); void context?.close().catch(() => {});
        if (this.sources.get(kind) === source) this.stopSource(kind);
        if (wasActive) this.rtc.emit('error', { error: new Error('Relay audio processing could not start. Check sound, then retry your microphone or device audio.') });
      }
      return;
    }
    if (kind !== 'screen') return;
    source.startedAt = performance.now(); source.forceKey = true; source.sequence = 0; source.targetFPS = 30; source.lastKey = 0; source.lastAdapt = 0;
    this.startScreenCapture(source, valid);
  }
  stopScreenCapture(source) {
    source.captureVersion = (source.captureVersion || 0) + 1;
    // Encoder callbacks belong to the reader generation that created them.
    // A recovered reader at the same resolution must get a fresh encoder;
    // otherwise its output would retain the retired generation's validity gate.
    try { source.encoder?.close(); } catch {}
    try { source.audioEncoder?.close(); } catch {} source.audioEncoder = null;
    source.encoder = null; source.codec = null; source.forceKey = true;
    clearInterval(source.timer); clearInterval(source.captureWatchdog); source.timer = null; source.captureWatchdog = null;
    source.clone?.stop(); source.clone = null; void source.reader?.cancel().catch(() => {}); source.reader = null; source.capture = null;
    if (source.video) { source.video.pause(); source.video.srcObject = null; source.video.remove(); source.video = null; }
  }
  startScreenCapture(source, valid, first = 0, reason) {
    if (!valid()) return;
    this.stopScreenCapture(source);
    const methods = ['Track processor', 'Image capture', 'Video element'];
    for (let index = first; index < methods.length; index++) {
      if (index === 0 && typeof MediaStreamTrackProcessor !== 'function' || index === 1 && typeof ImageCapture !== 'function' || index === 2 && typeof globalThis.document?.createElement !== 'function') continue;
      try {
        // Some native capture backends fail after accepting a cloned track.
        // Each retry gets a fresh clone and never stops the original RTC source.
        source.clone = source.track.clone(); source.captureBackend = methods[index]; source.captureFailures = 0; source.captureError = null;
        source.captureStartedAt = performance.now(); source.lastCaptureAt = null; source.capturePending = false;
        source.captureLast = -Infinity; source.captureDeadline = -Infinity; source.captureInterval = null;
        const version = source.captureVersion, current = () => valid() && source.captureVersion === version;
        const retry = failure => { if (current()) this.startScreenCapture(source, valid, index + 1, failure); };
        const accept = async frame => {
          if (!current()) return;
          const now = performance.now(), interval = source.jpeg ? 250 : 1000 / source.targetFPS;
          source.lastCaptureAt = now; source.capturedFrames = (source.capturedFrames || 0) + 1; source.captureError = null;
          if (interval !== source.captureInterval) { source.captureDeadline = source.captureLast + interval; source.captureInterval = interval; }
          if (now + (source.jpeg ? 0 : 2) < source.captureDeadline || source.pending || !source.track.enabled) return;
          source.captureDeadline = !Number.isFinite(source.captureDeadline) || now - source.captureDeadline > interval ? now + interval : source.captureDeadline + interval;
          source.captureLast = now; await this.encodeVideo('screen', source, frame, current);
        };
        if (index === 0) {
          source.reader = new MediaStreamTrackProcessor({ track: source.clone }).readable.getReader(); const reader = source.reader;
          void (async () => {
            try {
              while (current()) {
                const { done, value } = await reader.read();
                if (done) { retry('The native screen frame reader ended.'); break; }
                try { await accept(value); } finally { value?.close(); }
              }
            } catch { retry('The native screen frame reader failed.'); }
          })();
        } else if (index === 1) {
          source.capture = new ImageCapture(source.clone); const capture = source.capture;
          source.timer = setInterval(async () => {
            if (!current() || source.capturePending || !source.track.enabled) return;
            source.capturePending = true; let bitmap;
            try { bitmap = await capture.grabFrame(); source.captureFailures = 0; await accept(bitmap); }
            catch { if (current() && ++source.captureFailures >= 3) retry('The native image capture backend failed.'); }
            finally { bitmap?.close(); if (current()) source.capturePending = false; }
          }, 33);
        } else {
          const video = document.createElement('video'); source.video = video;
          video.muted = true; video.autoplay = true; video.playsInline = true; video.srcObject = new MediaStream([source.clone]);
          Object.assign(video.style, { position: 'fixed', width: '1px', height: '1px', opacity: '0', pointerEvents: 'none' }); document.body.append(video);
          void video.play().catch(() => retry('The screen capture preview could not start.'));
          source.timer = setInterval(async () => {
            if (!current() || source.capturePending || !source.track.enabled || video.readyState < 2) return;
            source.capturePending = true;
            try { await accept(video); } catch { if (current() && ++source.captureFailures >= 3) retry('The screen capture preview failed.'); }
            finally { if (current()) source.capturePending = false; }
          }, 33);
        }
        source.captureWatchdog = setInterval(() => {
          if (current() && source.track.enabled && performance.now() - (source.lastCaptureAt ?? source.captureStartedAt) > 6000) retry('No native screen frames arrived.');
        }, 1000);
        this.rtc.emit('relay-capture', { kind: 'screen', backend: source.captureBackend, recovered: Boolean(reason), reason });
        return;
      } catch { this.stopScreenCapture(source); reason = 'The native screen capture backend could not start.'; }
    }
    this.stopScreenCapture(source); source.captureBackend = 'Unavailable';
    source.captureError = 'Screen capture stopped producing frames. Check Screen Recording permission, then stop sharing and choose your display again.';
    this.rtc.emit('error', { error: new Error(source.captureError) });
  }
  async encodeVideo(kind, source, frame, valid) {
    if (source.jpeg && performance.now() - (source.lastJPEG || 0) < 250) return;
    source.pending = true;
    try {
      const width = frame.displayWidth || frame.videoWidth || frame.width, height = frame.displayHeight || frame.videoHeight || frame.height;
      if (!width || !height) return;
      const codecs = await this.capabilities; if (!valid()) return;
      const peers = [...this.peers.values()].filter(peer => peer.active);
      if (peers.some(peer => peer.videoCodecs === null) && performance.now() - source.startedAt < 2000) return;
      const codec = codecs.find(codec => peers.every(peer => peer.videoCodecs?.includes(codec)));
      if (codec) {
        source.jpeg = false;
        await this.encodeCompressed(source, frame, width, height, codec, valid); return;
      }
      source.jpeg = true; source.lastJPEG = performance.now();
      try { source.encoder?.close(); } catch {} source.encoder = null; source.codec = null;
      if (!source.compatibilityNotified) {
        source.compatibilityNotified = true; this.rtc.emit('relay-codec', { codec: 'JPEG', compatibility: true, reason: 'This media engine does not support a common real-time video codec. Screen relay is limited to 4 fps and 1280 pixels.' });
      }
      // Preserve presentation detail within a bounded 1280-pixel long edge.
      let scale = Math.min(1, 1280 / Math.max(width, height)); let blob, canvas;
      for (let attempt = 0; attempt < 3; attempt++) {
        canvas = new OffscreenCanvas(Math.max(1, Math.round(width * scale)), Math.max(1, Math.round(height * scale)));
        canvas.getContext('2d').drawImage(frame, 0, 0, canvas.width, canvas.height);
        blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.68 - attempt * 0.1 });
        if (blob.size <= 65000) break; scale *= 0.75;
      }
      if (!valid() || !source.track.enabled || blob.size > 110000) return;
      source.width = canvas.width; source.height = canvas.height;
      const bytes = new Uint8Array(await blob.arrayBuffer()); if (!valid()) return;
      for (const [id, peer] of this.peers) if (peer.active) this.send(id, { type: 'video', kind, stream: source.instance, width: canvas.width, height: canvas.height }, bytes);
    } finally { source.pending = false; }
  }
  async encodeCompressed(source, frame, width, height, codec, valid) {
    if (!valid()) return;
    const now = performance.now(), quality = this.rtc.quality || 'auto';
    const ceiling = { auto: 1920, '720': 1280, '1080': 1920, '1440': 2560 }[quality] || 1920;
    const totalCap = { auto: 3000000, '720': 1800000, '1080': 3500000, '1440': 4500000 }[quality] || 3000000;
    const relayRecipients = Math.max(1, [...this.peers.values()].filter(peer => peer.active).length);
    const cap = Math.round(totalCap / relayRecipients);
    if (source.cap !== cap) { source.bitrate = Math.min(source.bitrate || cap, cap); source.cap = cap; source.forceKey = true; }
    const scale = Math.min(1, ceiling / Math.max(width, height), Math.sqrt(MAX_VIDEO_PIXELS / (width * height)));
    const targetWidth = Math.max(2, Math.floor(width * scale / 2) * 2), targetHeight = Math.max(2, Math.floor(height * scale / 2) * 2);
    const encoder = source.encoder, lastCheck = source.lastEncoderCheck;
    source.lastEncoderCheck = now;
    if (encoder?.state === 'configured' && encoder.encodeQueueSize >= 2) {
      if (!Number.isFinite(lastCheck) || now - lastCheck > 500 || !Number.isFinite(source.encoderBlockedSince)) source.encoderBlockedSince = now;
      if (valid() && now - source.encoderBlockedSince >= 1500 && now - (source.lastEncoderOutput ?? source.encoderStartedAt ?? now) >= 1500) {
        this.encoderFailed(source, source.codec, source.config?.hardwareAcceleration); try { encoder.close(); } catch {} source.encoderBlockedSince = null; return;
      }
    } else source.encoderBlockedSince = null;
    const congested = [...this.peers.values()].some(peer => peer.active && peer.pendingVideo >= 2) || source.encoder?.state === 'configured' && source.encoder.encodeQueueSize >= 2;
    if (congested) {
      // Drop this frame immediately to keep the native/encrypted queues at
      // two. A single keyframe or compositor pause is not evidence that the
      // connection needs a lower permanent rate: reconfiguration itself asks
      // for another expensive keyframe. Adapt only after sustained pressure.
      if (!Number.isFinite(source.congestedSince) || !Number.isFinite(lastCheck) || now - lastCheck > 500) source.congestedSince = now;
      if (now - source.congestedSince >= 300 && now - source.lastAdapt > 1000) {
        source.bitrate = Math.max(700000, Math.round((source.bitrate || cap) * .8)); source.targetFPS = Math.max(12, source.targetFPS - 3); source.lastAdapt = now;
      }
      return;
    }
    source.congestedSince = null;
    if (now - source.lastAdapt > 3000) { source.bitrate = Math.min(cap, Math.round((source.bitrate || cap) * 1.1)); source.targetFPS = Math.min(30, source.targetFPS + 3); source.lastAdapt = now; }
    if (source.quality !== quality) { source.bitrate = cap; source.quality = quality; source.forceKey = true; }
    const changed = !source.encoder || source.encoder.state === 'closed' || source.codec !== codec || source.width !== targetWidth || source.height !== targetHeight;
    if (changed) {
      try { source.encoder?.close(); } catch {}
      source.encoder = null; source.stream = base64(crypto.getRandomValues(new Uint8Array(12))); source.sequence = 0; source.description = undefined;
      let config = { codec, width: targetWidth, height: targetHeight, bitrate: source.bitrate || cap, framerate: source.targetFPS,
        latencyMode: 'realtime', bitrateMode: 'variable', ...(codec.startsWith('avc1') ? { avc: { format: 'annexb' } } : {}) };
      let supported; const preferred = this.hardwarePreferences.get(codec) || 'no-preference';
      const accelerations = preferred === 'prefer-hardware' ? ['prefer-hardware', 'prefer-software', 'no-preference'] : ['no-preference'];
      for (const hardwareAcceleration of accelerations) {
        if (hardwareAcceleration === 'prefer-hardware' && source.failedHardware?.has(codec) || hardwareAcceleration === 'prefer-software' && source.failedSoftware?.has(codec)) continue;
        config = { ...config, hardwareAcceleration };
        try { supported = await VideoEncoder.isConfigSupported(config); } catch { supported = null; }
        if (supported?.supported) break;
      }
      if (!valid()) return;
      if (!supported?.supported) {
        const supportedCodecs = await this.capabilities; this.capabilities = Promise.resolve(supportedCodecs.filter(item => item !== codec)); return;
      }
      let encoder;
      try { encoder = new VideoEncoder({ output: (chunk, metadata) => {
        if (!valid() || source.encoder !== encoder || !source.track.enabled) return;
        source.lastEncoderOutput = performance.now(); source.encoderBlockedSince = null;
        if (metadata?.decoderConfig?.description) source.description = base64(new Uint8Array(metadata.decoderConfig.description));
        const sequence = ++source.sequence;
        if (chunk.byteLength > MAX_ENCODED_FRAME_BYTES || (source.description?.length || 0) > 1400) { source.forceKey = true; source.bitrate = Math.max(700000, Math.round(source.bitrate * .7)); return; }
        const bytes = new Uint8Array(chunk.byteLength); chunk.copyTo(bytes);
        const header = { type: 'video-chunk', kind: 'screen', stream: source.stream, sequence, codec: source.codec,
          width: source.width, height: source.height, chunkType: chunk.type, timestamp: chunk.timestamp,
          ...(chunk.type === 'key' && source.description ? { description: source.description } : {}) };
        for (const [id, peer] of this.peers) if (peer.active) {
          if (!this.sendVideo(id, header, bytes)) { peer.needsKey = true; source.forceKey = true; }
        }
      }, error: () => { if (valid() && source.encoder === encoder) {
        this.encoderFailed(source, codec, config.hardwareAcceleration); try { encoder.close(); } catch {}
      } } }); } catch { this.encoderFailed(source, codec, config.hardwareAcceleration); return; }
      source.encoder = encoder; source.codec = codec; source.width = targetWidth; source.height = targetHeight;
      source.encoderStartedAt = now; source.lastEncoderOutput = now; source.encoderBlockedSince = null;
      source.config = config; source.forceKey = true;
      try { encoder.configure(supported.config); } catch { try { encoder.close(); } catch {} this.encoderFailed(source, codec, config.hardwareAcceleration); return; }
      this.rtc.emit('relay-codec', { codec: codec.startsWith('avc1') ? 'H.264' : 'VP8', width: targetWidth, height: targetHeight, framerate: source.targetFPS, compatibility: false });
    } else if (Math.abs(source.config.bitrate - source.bitrate) > 250000 || source.config.framerate !== source.targetFPS) {
      source.config = { ...source.config, bitrate: source.bitrate, framerate: source.targetFPS };
      try { source.encoder.configure(source.config); source.forceKey = true; }
      catch { this.encoderFailed(source, codec, source.config.hardwareAcceleration); try { source.encoder.close(); } catch {} return; }
    }
    if (!valid() || source.encoder.encodeQueueSize >= 2) return;
    let encodedFrame;
    if (frame instanceof VideoFrame && frame.displayWidth === targetWidth && frame.displayHeight === targetHeight) encodedFrame = new VideoFrame(frame, { timestamp: Math.round(now * 1000) });
    else {
      if (!source.canvas || source.canvas.width !== targetWidth || source.canvas.height !== targetHeight) source.canvas = new OffscreenCanvas(targetWidth, targetHeight);
      source.canvas.getContext('2d', { alpha: false }).drawImage(frame, 0, 0, targetWidth, targetHeight);
      encodedFrame = new VideoFrame(source.canvas, { timestamp: Math.round(now * 1000) });
    }
    const keyFrame = source.forceKey || now - source.lastKey > 2000;
    if (keyFrame) { source.forceKey = false; source.lastKey = now; }
    try { source.encoder.encode(encodedFrame, { keyFrame }); } catch { source.forceKey = true; }
    finally { encodedFrame.close(); }
  }
  encoderFailed(source, codec, hardwareAcceleration) {
    source.forceKey = true;
    if (hardwareAcceleration === 'prefer-hardware') {
      if (!source.failedHardware) source.failedHardware = new Set(); source.failedHardware.add(codec);
    } else if (hardwareAcceleration === 'prefer-software') {
      if (!source.failedSoftware) source.failedSoftware = new Set(); source.failedSoftware.add(codec);
    } else this.capabilities = this.capabilities.then(codecs => codecs.filter(item => item !== codec));
  }
  state() {
    for (const [id, peer] of this.peers) if (peer.active) this.send(id, { type: 'state', mediaState: this.rtc.mediaState() });
    for (const kind of ['audio', 'screen']) void this.syncSource(kind);
  }
  stopSource(kind) {
    const source = this.sources.get(kind); if (!source) return;
    this.sources.delete(kind); source.active = false; this.stopScreenCapture(source);
    try { source.encoder?.close(); } catch {}
    if (source.node) { source.node.port.postMessage('stop'); source.node.disconnect(); source.node.port.onmessage = null; }
    source.input?.disconnect(); if (source.context) { this.audioContexts.delete(source.context); void source.context.close().catch(() => {}); this.playbackState(); }
  }
  removeOutput(id, kind, preserveDecoder = false) {
    const peer = this.peers.get(id);
    if (kind === 'screen' && peer && !preserveDecoder) {
      this.retireStream(peer, peer.decoderStream); this.retireStream(peer, peer.jpegStream); this.retireStream(peer, peer.assembly?.header.stream);
      try { peer.decoder?.close(); } catch {} peer.decoder = null; peer.decoderNeedsKey = true;
      clearTimeout(peer.assembly?.timer); peer.assembly = null;
    }
    const output = peer?.outputs.get(kind); if (!output) return;
    peer.outputs.delete(kind); output.track.stop(); void output.writer?.abort().catch(() => {});
    try { output.audioDecoder?.close(); } catch {} output.audioDecoder = null;
    if (output.node) { output.node.port.postMessage('stop'); output.node.disconnect(); }
    if (output.context) { this.audioContexts.delete(output.context); void output.context.close().catch(() => {}); this.playbackState(); }
    const entry = this.rtc.peers.get(id); if (entry?.remoteTracks.get(kind)?.track === output.track) { entry.remoteTracks.delete(kind); this.rtc.emit('track-removed', { peerId: id, kind }); }
  }
  removePeer(id) {
    const peer = this.peers.get(id); if (!peer) return;
    peer.active = false; peer.cipher.close(); this.removeOutput(id, 'screen'); for (const kind of [...peer.outputs.keys()]) this.removeOutput(id, kind); this.peers.delete(id);
    if (![...this.peers.values()].some(item => item.active)) for (const kind of [...this.sources.keys()]) this.stopSource(kind);
  }
  close() { this.closed = true; for (const id of [...this.peers.keys()]) this.removePeer(id); for (const kind of [...this.sources.keys()]) this.stopSource(kind); this.key = null; }
}
