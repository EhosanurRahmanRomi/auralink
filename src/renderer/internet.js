/* Private directory connection. Credentials stay in this device's local storage;
   pairing codes are sent once over TLS and never persisted or placed in URLs. */
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
    this.deviceId = null; this.devices = []; this.status = 'offline'; this.name = ''; this.attempt = 0;
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
  async open(value, { pairingKey = '', name = 'My device' } = {}) {
    const origin = internetOrigin(value); const requestedName = String(name).trim().slice(0, 48) || 'My device';
    if (this.status === 'online' && this.origin === origin && this.name === requestedName) return { deviceId: this.deviceId };
    this.name = requestedName;
    const identity = this.identity(origin);
    if (!identity && !pairingKey.trim()) throw new Error('Enter your private pairing code to connect this device for the first time.');
    if (pairingKey.length > 256) throw new Error('The pairing code is too long.');
    this.close(); this.origin = origin; this.attempt = 0;
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
    const lost = () => {
      if (!current()) return;
      clearTimeout(this.authTimer); clearInterval(this.heartbeatTimer); clearTimeout(this.pongTimer); this.authTimer = null; this.heartbeatTimer = null; this.pongTimer = null; this.socket = null;
      this.devices = this.devices.map(device => ({ ...device, online: false, hosting: false, roomId: null }));
      this.emit('presence', { devices: this.devices }); this.emit('disconnected');
      if (generation !== this.generation) return;
      if (this.roomWaiter) { this.roomWaiter.reject(new Error('The Internet connection ended.')); clearTimeout(this.roomWaiter.timer); this.roomWaiter = null; }
      if (this.leaveWaiter) { this.leaveWaiter.reject(new Error('The Internet connection ended.')); clearTimeout(this.leaveWaiter.timer); this.leaveWaiter = null; }
      this.failForgetting(new Error('The connection ended before removal was confirmed. Your device credential is still saved; reconnect and try Forget again.'));
      const saved = this.identity();
      if (saved && this.attempt < this.reconnectDelays.length) {
        this.setStatus('retrying'); const delay = this.reconnectDelays[this.attempt++];
        this.reconnectTimer = setTimeout(() => this.startSocket(saved, '', generation), delay);
      } else { this.setStatus('offline'); this.failAuthentication(new Error('The Internet service could not be reached. Try Go online again.')); }
    };
    this.authTimer = setTimeout(() => { if (current() && this.status !== 'online') { this.failAuthentication(new Error('The service did not answer. Check its address and your connection.')); lost(); socket.close(); } }, this.timeout);
    socket.addEventListener('open', () => {
      if (!current()) return;
      const auth = identity ? { type: 'register', ...identity, name: this.name } : { type: 'pair', pairingKey, name: this.name };
      pairingKey = '';
      try { socket.send(JSON.stringify(auth)); } catch { this.failAuthentication(new Error('The Internet connection could not authenticate.')); lost(); socket.close(); }
    });
    socket.addEventListener('message', event => {
      if (!current()) return;
      let message; try { message = JSON.parse(event.data); } catch { return; }
      if (!message || typeof message.type !== 'string') return;
      if (message.type === 'paired') {
        if (typeof message.deviceId !== 'string' || !message.deviceId || message.deviceId.length > 128 || typeof message.deviceToken !== 'string' || message.deviceToken.length < 16 || message.deviceToken.length > 256) return;
        identity = { deviceId: message.deviceId, deviceToken: message.deviceToken };
        try { this.storage?.setItem(this.storageKey(), JSON.stringify(identity)); } catch { this.emit('notice', { message: 'Local storage is unavailable. Pair again next time you open the app.' }); }
        this.deviceId = identity.deviceId;
      } else if (message.type === 'registered') {
        if (!identity || message.deviceId !== identity.deviceId) { this.failAuthentication(new Error('The service did not confirm this device identity.')); this.close(); return; }
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
        this.devices = Array.isArray(message.devices) ? message.devices.slice(0, 32).map(device => ({ id: String(device.id).slice(0, 128), name: String(device.name || 'Device').slice(0, 48), online: device.online === true, hosting: device.hosting === true, roomId: typeof device.roomId === 'string' ? device.roomId : null })) : [];
        this.emit('presence', { devices: this.devices });
      } else if (message.type === 'room-created') {
        this.roomWaiter?.resolve({ ...message, internet: true, url: this.origin, invite: `${this.origin}/#${new URLSearchParams({ internet: '1', room: message.roomId, key: message.roomKey })}` });
        if (this.roomWaiter) clearTimeout(this.roomWaiter.timer); this.roomWaiter = null;
      } else if (message.type === 'error') {
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
    this.devices = this.devices.map(device => ({ ...device, online: false, hosting: false, roomId: null })); this.emit('presence', { devices: this.devices });
  }
}
