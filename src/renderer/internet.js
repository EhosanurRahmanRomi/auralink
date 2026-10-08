/* Private directory connection. Credentials stay in this device's local storage;
   pairing codes are sent once over TLS and never persisted or placed in URLs. */
export const DEFAULT_PUBLIC_ORIGIN = 'https://auralink-private-coordinator.auralink-internet-service.workers.dev';

function publicAuthenticationFailure(reason) {
  // The coordinator shares one bounded refusal across several allowances. Do
  // not guess its reset time or expose untrusted server text in a public error.
  return new Error(reason === 'Public connection limit reached. Try again later.'
    ? 'The free public service has reached its connection allowance. Try again later or use Nearby mode.'
    : 'The public service refused this connection. Try again later or use Nearby mode.');
}

export function roomInvitation(value) {
  const supplied = String(value);
  if (supplied.length > 2048 || /[\x00-\x1f\x7f]/.test(supplied)) throw new Error('Paste the complete room code or link without extra lines.');
  const raw = supplied.trim();
  if (/^auralink:/i.test(raw)) {
    const url = new URL(raw);
    if (!/^auralink:\/\/join#code=A1\./.test(raw) || url.protocol !== 'auralink:' || url.hostname !== 'join' || url.port || url.pathname || url.username || url.password || url.search) throw new Error('Use the original Auralink invitation from the host.');
    const fields = new URLSearchParams(url.hash.slice(1));
    if ([...fields.keys()].length !== 1 || fields.getAll('code').length !== 1) throw new Error('This Auralink invitation has unexpected fields.');
    if (raw !== `auralink://join#code=${fields.get('code')}`) throw new Error('Use the original Auralink invitation from the host.');
    return roomInvitation(fields.get('code'));
  }
  if (raw.startsWith('A1.')) {
    const match = /^A1\.([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.([A-Za-z0-9_-]{43})$/i.exec(raw);
    if (!match || !/^[AEIMQUYcgkosw048]$/.test(match[2].slice(-1))) throw new Error('This room code is incomplete. Copy the whole code or invitation link.');
    return { ...internetInvitation(`${DEFAULT_PUBLIC_ORIGIN}/#internet=1&room=${match[1]}&key=${match[2]}`), public: true };
  }
  return internetInvitation(raw);
}

export function roomCode(room) {
  if (room?.access !== 'invite' || room?.url !== DEFAULT_PUBLIC_ORIGIN || !/^[0-9a-f-]{36}$/i.test(room.roomId || '') || !/^[A-Za-z0-9_-]{43}$/.test(room.roomKey || '')) return '';
  return `A1.${room.roomId}.${room.roomKey}`;
}

// The native adapters have a 64 KiB signaling ceiling. Only the coordinator's
// narrowly defined encrypted media envelope may use its larger relay ceiling.
export function relayPacketSizeAllowed(raw, direction = 'outgoing') {
  if (typeof raw !== 'string' || new TextEncoder().encode(raw).length > 262144) return false;
  let packet; try { packet = JSON.parse(raw); } catch { return false; }
  const field = direction === 'incoming' ? 'from' : 'to';
  const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
  if (!exact(packet, ['type', field, 'data']) || packet.type !== 'signal' || typeof packet[field] !== 'string' || !packet[field] || packet[field].length > 128 || !exact(packet.data, ['relay'])) return false;
  const relay = packet.data.relay;
  if (!exact(relay, ['version', 'epoch', 'counter', 'nonce', 'ciphertext']) || relay.version !== 1 || !Number.isSafeInteger(relay.counter) || relay.counter < 1 || !/^[A-Za-z0-9_-]{16}$/.test(relay.epoch) || !/^[A-Za-z0-9_-]{16}$/.test(relay.nonce) || typeof relay.ciphertext !== 'string' || !/^[A-Za-z0-9_-]+$/.test(relay.ciphertext) || relay.ciphertext.length > 240000) return false;
  try { const size = atob(relay.ciphertext.replaceAll('-', '+').replaceAll('_', '/')).length; return size >= 16 && size <= 180000; } catch { return false; }
}
export function internetOrigin(value) {
  const raw = String(value);
  if (raw.length > 256 || /[\x00-\x1f\x7f\\]/.test(raw) || !/^https:\/\/[^/?#]+\/?$/i.test(raw.trim())) throw new Error('Enter a clean HTTPS service address.');
  let url;
  try { url = new URL(raw.trim()); } catch { throw new Error('Enter the complete HTTPS service address.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) throw new Error('Use the HTTPS service address without a path, query or invitation.');
  return url.origin;
}

export function internetInvitation(value) {
  const raw = String(value);
  if (raw.length > 2048 || /[\x00-\x1f\x7f]/.test(raw)) throw new Error('Use the complete invitation without extra lines.');
  const url = new URL(raw.trim()); const params = new URLSearchParams(url.hash.slice(1));
  if (params.get('internet') !== '1') return null;
  if (![url.origin, `${url.origin}/`].includes(raw.trim().split('#')[0])) throw new Error('Use the original Internet invitation from the host.');
  for (const key of params.keys()) if (!['internet', 'room', 'key'].includes(key) || params.getAll(key).length !== 1) throw new Error('This Internet invitation has unexpected fields. Ask the host for a new invitation.');
  const origin = internetOrigin(url.origin); const roomId = params.get('room'); const roomKey = params.get('key');
  if (!roomId || !roomKey || roomId.length > 128 || roomKey.length > 256 || url.username || url.password || url.search || url.pathname !== '/') throw new Error('This Internet invitation is incomplete. Ask the host to copy a new invitation.');
  return { internet: true, url: origin, roomId, roomKey, invite: `${origin}/#${new URLSearchParams({ internet: '1', room: roomId, key: roomKey })}` };
}

export class InternetDirectory extends EventTarget {
  constructor({ socketFactory = url => new WebSocket(url), trust = async () => {}, storage, reconnectDelays = [500, 1500, 4000, 8000], timeout = 12000, heartbeatInterval = 30000, pongTimeout = 12000 } = {}) {
    super(); this.socketFactory = socketFactory; this.trust = trust;
    try { this.storage = storage === undefined ? globalThis.localStorage : storage; } catch { this.storage = null; }
    this.reconnectDelays = reconnectDelays; this.timeout = timeout; this.heartbeatInterval = heartbeatInterval; this.pongTimeout = pongTimeout; this.origin = ''; this.socket = null;
    this.deviceId = null; this.devices = []; this.status = 'offline'; this.name = ''; this.attempt = 0; this.mode = 'private';
    this.generation = 0; this.reconnectTimer = null; this.authTimer = null; this.heartbeatTimer = null; this.pongTimer = null; this.authWaiter = null; this.roomWaiter = null; this.leaveWaiter = null; this.forgetWaiter = null;
  }
  emit(type, detail = {}) { this.dispatchEvent(new CustomEvent(type, { detail })); }
  storageKey(origin = this.origin) { return `auralink.internet.identity:${origin}`; }
  identity(origin = this.origin) {
    try {
      const identity = JSON.parse(this.storage?.getItem(this.storageKey(origin)) || 'null');
      if (typeof identity?.deviceId === 'string' && identity.deviceId.length <= 128 && typeof identity.deviceToken === 'string' && identity.deviceToken.length >= 16 && identity.deviceToken.length <= 256) return identity;
    } catch { /* Disabled or corrupt local storage requires pairing again. */ }
    return null;
  }
  setStatus(status) { this.status = status; this.emit('status', { status }); }
  openPublic(value = DEFAULT_PUBLIC_ORIGIN, { name = 'My device' } = {}) { return this.open(value, { name, mode: 'public' }); }
  async open(value, { pairingKey = '', name = 'My device', mode = 'private' } = {}) {
    const origin = internetOrigin(value); const requestedName = String(name).trim().slice(0, 48) || 'My device';
    if (!['private', 'public'].includes(mode)) throw new Error('Unsupported connection mode.');
    if (this.status === 'online' && this.origin === origin && this.name === requestedName && this.mode === mode) return { deviceId: this.deviceId };
    this.name = requestedName;
    const identity = mode === 'public' ? null : this.identity(origin);
    if (mode === 'private' && !identity && !pairingKey.trim()) throw new Error('Enter your private pairing code to connect this device for the first time.');
    if (pairingKey.length > 256) throw new Error('The pairing code is too long.');
    this.close(); this.origin = origin; this.mode = mode; this.deviceId = null; this.attempt = 0;
    const generation = this.generation;
    await this.trust(origin);
    if (generation !== this.generation) throw new Error('The Internet connection was cancelled.');
    return new Promise((resolve, reject) => {
      this.authWaiter = { resolve, reject }; this.startSocket(identity, pairingKey.trim(), generation);
    });
  }
  startSocket(identity, pairingKey = '', generation = this.generation) {
    if (generation !== this.generation) return;
    this.setStatus(this.attempt ? 'retrying' : 'connecting');
    const url = new URL('/internet/ws', this.origin); url.protocol = 'wss:';
    let socket;
    try { socket = this.socketFactory(url.href); } catch (error) { this.failAuthentication(error); this.setStatus('offline'); return; }
    this.socket = socket;
    const current = () => generation === this.generation && this.socket === socket;
    const lost = event => {
      if (!current()) return;
      const policyFailure = this.mode === 'public' && event?.code === 1008 ? publicAuthenticationFailure(event.reason) : null;
      clearTimeout(this.authTimer); clearInterval(this.heartbeatTimer); clearTimeout(this.pongTimer); this.authTimer = null; this.heartbeatTimer = null; this.pongTimer = null; this.socket = null;
      this.devices = this.devices.map(device => ({ ...device, online: false, hosting: false, roomId: null }));
      this.emit('presence', { devices: this.devices }); this.emit('disconnected');
      if (generation !== this.generation) return;
      if (this.roomWaiter) { this.roomWaiter.reject(policyFailure || new Error('The Internet connection ended.')); clearTimeout(this.roomWaiter.timer); this.roomWaiter = null; }
      if (this.leaveWaiter) { this.leaveWaiter.reject(policyFailure || new Error('The Internet connection ended.')); clearTimeout(this.leaveWaiter.timer); this.leaveWaiter = null; }
      this.failForgetting(new Error('The connection ended before removal was confirmed. Your device credential is still saved; reconnect and try Forget again.'));
      if (policyFailure) {
        clearTimeout(this.reconnectTimer); this.reconnectTimer = null; this.deviceId = null;
        const awaitingAuthentication = Boolean(this.authWaiter);
        this.failAuthentication(policyFailure); this.setStatus('offline');
        if (!awaitingAuthentication) this.emit('notice', { message: policyFailure.message });
        return;
      }
      const saved = this.mode === 'public' ? null : this.identity();
      if ((saved || this.mode === 'public') && this.attempt < this.reconnectDelays.length) {
        this.setStatus('retrying'); const delay = this.reconnectDelays[this.attempt++];
        this.reconnectTimer = setTimeout(() => this.startSocket(saved, '', generation), delay);
      } else { this.setStatus('offline'); this.failAuthentication(new Error('The Internet service could not be reached. Try Go online again.')); }
    };
    this.authTimer = setTimeout(() => { if (current() && this.status !== 'online') { this.failAuthentication(new Error('The service did not answer. Check its address and your connection.')); lost(); socket.close(); } }, this.timeout);
    socket.addEventListener('open', () => {
      if (!current()) return;
      const auth = this.mode === 'public' ? { type: 'bootstrap', name: this.name } : identity ? { type: 'register', ...identity, name: this.name } : { type: 'pair', pairingKey, name: this.name };
      pairingKey = '';
      try { socket.send(JSON.stringify(auth)); } catch { this.failAuthentication(new Error('The Internet connection could not authenticate.')); lost(); socket.close(); }
    });
    socket.addEventListener('message', event => {
      if (!current()) return;
      let message; try { message = JSON.parse(event.data); } catch { return; }
      if (!message || typeof message.type !== 'string') return;
      if (message.type === 'paired') {
        if (this.mode !== 'private') return;
        if (typeof message.deviceId !== 'string' || !message.deviceId || message.deviceId.length > 128 || typeof message.deviceToken !== 'string' || message.deviceToken.length < 16 || message.deviceToken.length > 256) return;
        identity = { deviceId: message.deviceId, deviceToken: message.deviceToken };
        try { this.storage?.setItem(this.storageKey(), JSON.stringify(identity)); } catch { this.emit('notice', { message: 'Local storage is unavailable. Pair again next time you open the app.' }); }
        this.deviceId = identity.deviceId;
      } else if (message.type === 'registered') {
        const publicIdentity = this.mode === 'public' && message.mode === 'public' && typeof message.deviceId === 'string' && message.deviceId.length > 0 && message.deviceId.length <= 128;
        if (!publicIdentity && (this.mode !== 'private' || !identity || message.deviceId !== identity.deviceId)) { this.failAuthentication(new Error('The service did not confirm this device identity.')); this.close(); return; }
        clearTimeout(this.authTimer); this.authTimer = null; this.deviceId = message.deviceId; this.attempt = 0;
        clearInterval(this.heartbeatTimer);
        this.heartbeatTimer = setInterval(() => {
          if (!current() || this.pongTimer) return;
          // Mark loss immediately: browser close handshakes can remain pending
          // on a silent network. Late replies from this socket are ignored.
          this.pongTimer = setTimeout(() => { if (current()) { this.emit('notice', { message: 'The Internet service stopped responding. Sharing and control have stopped.' }); lost(); socket.close(); } }, this.pongTimeout);
          try { if (socket.readyState !== 1) throw new Error('Socket is not open.'); socket.send(JSON.stringify({ type: 'ping' })); }
          catch { lost(); socket.close(); }
        }, this.heartbeatInterval);
        this.setStatus('online'); this.authWaiter?.resolve({ deviceId: this.deviceId }); this.authWaiter = null;
      } else if (message.type === 'pong') {
        clearTimeout(this.pongTimer); this.pongTimer = null;
      } else if (message.type === 'room-left' || message.type === 'left') {
        if (this.leaveWaiter) { clearTimeout(this.leaveWaiter.timer); this.leaveWaiter.resolve(); this.leaveWaiter = null; }
      } else if (message.type === 'forgotten') {
        const waiting = this.forgetWaiter;
        if (!waiting || message.deviceId !== this.deviceId) return;
        clearTimeout(waiting.timer); this.forgetWaiter = null;
        try { this.storage?.removeItem(this.storageKey(waiting.origin)); } catch { this.emit('notice', { message: 'The service removed this device, but local storage could not be cleared. Clear this app’s saved data before pairing again.' }); }
        this.deviceId = null; this.devices = []; this.close(); this.emit('presence', { devices: [] }); waiting.resolve();
      } else if (message.type === 'presence') {
        if (this.mode === 'public') return;
        this.devices = Array.isArray(message.devices) ? message.devices.slice(0, 32).map(device => ({ id: String(device.id).slice(0, 128), name: String(device.name || 'Device').slice(0, 48), online: device.online === true, hosting: device.hosting === true, roomId: typeof device.roomId === 'string' ? device.roomId : null })) : [];
        this.emit('presence', { devices: this.devices });
      } else if (message.type === 'room-created') {
        this.roomWaiter?.resolve({ ...message, internet: true, url: this.origin, invite: `${this.origin}/#${new URLSearchParams({ internet: '1', room: message.roomId, key: message.roomKey })}` });
        if (this.roomWaiter) clearTimeout(this.roomWaiter.timer); this.roomWaiter = null;
      } else if (message.type === 'error') {
        if (this.mode === 'public' && this.status !== 'online') {
          const error = publicAuthenticationFailure(message.message), awaitingAuthentication = Boolean(this.authWaiter);
          this.failAuthentication(error); this.close();
          if (!awaitingAuthentication) this.emit('notice', { message: error.message });
          return;
        }
        const error = new Error(String(message.message || 'The Internet service could not complete that request.').slice(0, 260));
        if (this.status !== 'online') { this.failAuthentication(new Error(`${error.message} Your saved credential is preserved. Check your service settings and try Go online again.`)); this.close(); }
        else if (this.forgetWaiter) this.failForgetting(new Error(`${error.message} Your device credential is still saved.`));
        else if (this.roomWaiter) { this.roomWaiter.reject(error); clearTimeout(this.roomWaiter.timer); this.roomWaiter = null; }
        else this.emit('message', message);
      } else this.emit('message', message);
    });
    socket.addEventListener('error', () => { if (current()) this.emit('notice', { message: 'Internet connection interrupted. Check the service address and your network.' }); });
    socket.addEventListener('close', lost);
  }
  failAuthentication(error) { this.authWaiter?.reject(error); this.authWaiter = null; }
  send(message) { if (this.status !== 'online' || this.socket?.readyState !== 1) throw new Error('Go online before starting an Internet room.'); this.socket.send(JSON.stringify(message)); }
  createRoom(name) {
    if (this.forgetWaiter) return Promise.reject(new Error('Wait for device removal to finish.'));
    if (this.leaveWaiter) return Promise.reject(new Error('Wait for your previous room to close.'));
    if (this.roomWaiter) return Promise.reject(new Error('A room request is already in progress.'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.roomWaiter = null; reject(new Error('The room could not be opened. Try again.')); }, this.timeout);
      this.roomWaiter = { resolve, reject, timer };
      try { this.send({ type: 'create-room', name: String(name).trim().slice(0, 60) || 'My workspace' }); }
      catch (error) { clearTimeout(timer); this.roomWaiter = null; reject(error); }
    });
  }
  joinRoom(room, isHost = false) { if (this.forgetWaiter) throw new Error('Wait for device removal to finish.'); if (this.leaveWaiter) throw new Error('Wait for your previous room to close.'); this.send({ type: 'join', roomId: room.roomId, roomKey: room.roomKey, ...(isHost ? { hostToken: room.hostToken } : {}) }); }
  joinDevice(deviceId) { if (this.forgetWaiter) throw new Error('Wait for device removal to finish.'); if (this.leaveWaiter) throw new Error('Wait for your previous room to close.'); this.send({ type: 'join-device', deviceId }); }
  leaveRoom() {
    if (this.leaveWaiter) return this.leaveWaiter.promise;
    if (this.roomWaiter) { this.roomWaiter.reject(new Error('The room request was cancelled.')); clearTimeout(this.roomWaiter.timer); this.roomWaiter = null; }
    if (this.status !== 'online') return Promise.resolve();
    const socket = this.socket;
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { const error = new Error('The service did not confirm room exit. Reconnect before starting another room.'); this.leaveWaiter = null; reject(error); this.close(); }, this.timeout);
      this.leaveWaiter = { resolve, reject, timer };
      try { this.send({ type: 'leave' }); } catch (error) { clearTimeout(timer); this.leaveWaiter = null; reject(error); if (this.socket === socket) this.close(); }
    });
    if (this.leaveWaiter) this.leaveWaiter.promise = promise;
    return promise;
  }
  forget() {
    if (this.mode === 'public') { this.close(); return Promise.resolve(); }
    if (this.forgetWaiter) return this.forgetWaiter.promise;
    if (this.status !== 'online' || this.socket?.readyState !== 1) return Promise.reject(new Error('Go online before forgetting this device so the service can confirm its removal. Your device credential is still saved.'));
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.failForgetting(new Error('The service did not confirm device removal. Your device credential is still saved; reconnect and try Forget again.')); this.close(); }, this.timeout);
      this.forgetWaiter = { resolve, reject, timer, origin: this.origin };
      try { this.send({ type: 'forget' }); } catch { this.failForgetting(new Error('Device removal could not be sent. Your device credential is still saved.')); }
    });
    if (this.forgetWaiter) this.forgetWaiter.promise = promise;
    return promise;
  }
  failForgetting(error) { if (this.forgetWaiter) { clearTimeout(this.forgetWaiter.timer); this.forgetWaiter.reject(error); this.forgetWaiter = null; } }
  close() {
    this.generation++; clearTimeout(this.reconnectTimer); clearTimeout(this.authTimer); clearInterval(this.heartbeatTimer); clearTimeout(this.pongTimer); this.reconnectTimer = null; this.authTimer = null; this.heartbeatTimer = null; this.pongTimer = null;
    this.failAuthentication(new Error('The Internet connection was closed.'));
    this.failForgetting(new Error('The connection closed before device removal was confirmed. Your device credential is still saved.'));
    if (this.roomWaiter) { this.roomWaiter.reject(new Error('The Internet connection was closed.')); clearTimeout(this.roomWaiter.timer); this.roomWaiter = null; }
    if (this.leaveWaiter) { this.leaveWaiter.reject(new Error('The Internet connection was closed.')); clearTimeout(this.leaveWaiter.timer); this.leaveWaiter = null; }
    const socket = this.socket; this.socket = null; socket?.close(); this.setStatus('offline');
    if (this.mode === 'public') this.deviceId = null;
    this.devices = this.devices.map(device => ({ ...device, online: false, hosting: false, roomId: null })); this.emit('presence', { devices: this.devices });
  }
}
