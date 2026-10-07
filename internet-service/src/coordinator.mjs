// Platform-independent room policy. Transport adapters never supply peer identity.
export const LIMITS = Object.freeze({ devices: 32, sockets: 64, unauthenticated: 8,
  participants: 4, pending: 8, messageBytes: 65536, authMs: 10000,
  admissionMs: 60000, idleMs: 120000, roomStartMs: 30000, controlMs: 15 * 60000 });
export const DIRECT_ICE = Object.freeze([{ urls: 'stun:stun.cloudflare.com:3478' }]);
const encoder = new TextEncoder();
const SECRET = /^[A-Za-z0-9_-]{32,128}$/;
function validSecret(value) { return typeof value === 'string' && SECRET.test(value); }
export function cleanName(value) {
  if (typeof value !== 'string') return null;
  return value.normalize('NFKC').replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069<>]/g, '')
    .replace(/\s+/g, ' ').trim().slice(0, 48) || null;
}
export async function digest(value) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value)))]
    .map(byte => byte.toString(16).padStart(2, '0')).join('');
}
function equal(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  let mismatch = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) mismatch |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return mismatch === 0;
}
function secret() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return encodeBytes(bytes);
}
function encodeBytes(bytes) {
  let binary = ''; for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}
function decodeBytes(value, maximum) {
  if (typeof value !== 'string' || value.length > maximum * 2 || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('Invalid encoded cache.');
  const binary = atob(value.replaceAll('-', '+').replaceAll('_', '/'));
  if (binary.length > maximum) throw new Error('Invalid encoded cache.');
  return Uint8Array.from(binary, character => character.charCodeAt(0));
}
function positive(value, fallback, maximum) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= maximum ? parsed : fallback;
}
function peerInfo(peer) { return { id: peer.id, name: peer.name, role: peer.role }; }
function roomInfo(room) { return { id: room.id, name: room.name, maxParticipants: LIMITS.participants }; }
function validSession(value) { return typeof value === 'string' && /^[A-Za-z0-9_-]{16,128}$/.test(value); }
function validatedIce(supplied) {
  if (!Array.isArray(supplied) || supplied.length > 12) return null;
  const iceServers = [];
  for (const entry of supplied) {
    const urls = Array.isArray(entry?.urls) ? entry.urls : [entry?.urls];
    if (!urls.length || urls.length > 4 || !urls.every(url => typeof url === 'string' &&
        /^(?:stun|stuns|turn|turns):[a-z0-9.-]+\.(?:metered\.ca|metered\.live):\d{1,5}(?:\?transport=(?:udp|tcp))?$/i.test(url))) continue;
    const relay = urls.some(url => /^turns?:/i.test(url));
    if (relay && (typeof entry.username !== 'string' || typeof entry.credential !== 'string' ||
        entry.username.length > 256 || entry.credential.length > 256 || !entry.username || !entry.credential)) continue;
    iceServers.push(relay ? { urls, username: entry.username, credential: entry.credential } : { urls });
  }
  return iceServers.some(entry => entry.urls.some(url => /^turns?:/i.test(url))) ? iceServers : null;
}

export class Coordinator {
  constructor({ store, env = {}, now = () => Date.now(), fetcher = (input, init) => fetch(input, init), restored = [] }) {
    this.store = store; this.env = env; this.now = now; this.fetcher = fetcher;
    this.devices = new Map(store.loadDevices().map(device => [device.id, device]));
    this.rooms = new Map(store.loadRooms().map(room => [room.id, room]));
    this.sockets = new Map(); this.requests = new Map(); this.grants = new Map(); this.iceCache = new Map(); this.icePending = new Map();
    for (const { transport, attachment } of restored) {
      if (!attachment || attachment.version !== 1 || !attachment.connectionId) {
        transport.close(1008, 'Connection state unavailable.'); continue;
      }
      const client = { ...attachment, transport };
      if (client.deviceId && !this.devices.has(client.deviceId)) {
        transport.close(1008, 'Device registration unavailable.'); continue;
      }
      this.sockets.set(client.connectionId, client);
    }
    // Restore only the same authenticated sockets under an unexpired owner consent lease.
    for (const client of this.sockets.values()) {
      if (client.grant) {
        const grant = client.grant, controller = this.peer(grant.controllerId);
        const room = this.rooms.get(client.roomId);
        const valid = client.accepted === true && client.admissionReady === true &&
          controller?.accepted === true && controller.admissionReady === true && room &&
          grant.roomId === room.id && controller.roomId === room.id &&
          grant.ownerId === client.id && grant.ownerDeviceId === client.deviceId &&
          grant.controllerDeviceId === controller.deviceId &&
          grant.ownerConnectionId === client.connectionId && grant.controllerConnectionId === controller.connectionId &&
          validSession(grant.sessionId) && Number.isFinite(grant.createdAt) && Number.isFinite(grant.expiresAt) &&
          grant.createdAt <= this.now() && grant.expiresAt > this.now() &&
          grant.expiresAt - grant.createdAt <= LIMITS.controlMs && grant.expiresAt > grant.createdAt;
        if (valid) { this.grants.set(client.id, grant); continue; }
        this.send(controller, { type: 'control-revoke', from: client.id,
          sessionId: grant.sessionId, reason: 'Previous control permission expired or its connection changed.' });
        this.send(client, { type: 'control-revoked', peerId: client.grant.controllerId,
          sessionId: grant.sessionId, reason: 'Fresh owner permission is required.' });
        delete client.grant; this.save(client);
      }
    }
    for (const room of [...this.rooms.values()]) {
      if (room.hostId && !this.ready(room).some(peer => peer.id === room.hostId && peer.deviceId === room.ownerDeviceId)) {
        this.endRoom(room, 'The room host disconnected.');
      }
    }
    for (const client of this.sockets.values()) {
      if (client.roomId && !this.rooms.has(client.roomId)) this.clearMembership(client);
      else if (client.accepted && client.admissionReady !== true) {
        // An interrupted admission or legacy attachment cannot prove that the
        // client received its welcome. Keep the directory, require a fresh join.
        this.send(client, { type: 'rejected', reason: 'Room admission was interrupted. Ask to join again.' });
        this.leave(client);
      }
    }
    for (const owner of this.sockets.values()) {
      const saved = Array.isArray(owner.controlRequests) ? owner.controlRequests.slice(0, LIMITS.participants - 1) : [];
      delete owner.controlRequests;
      for (const request of saved) {
        const controller = this.peer(request?.controllerId);
        if (request && owner.accepted === true && owner.admissionReady === true &&
            controller?.accepted === true && controller.admissionReady === true && this.rooms.has(owner.roomId) &&
            owner.roomId === controller.roomId && request.roomId === owner.roomId && request.targetId === owner.id &&
            request.targetDeviceId === owner.deviceId && request.controllerDeviceId === controller.deviceId &&
            request.targetConnectionId === owner.connectionId && request.controllerConnectionId === controller.connectionId &&
            typeof request.requestId === 'string' && Number.isFinite(request.createdAt) && Number.isFinite(request.expiresAt) &&
            request.createdAt <= this.now() && request.expiresAt > this.now() &&
            request.expiresAt - request.createdAt === LIMITS.admissionMs) {
          this.requests.set(`${owner.id}:${controller.id}`, request);
        }
      }
      this.saveRequests(owner);
    }
  }
  attach(transport) {
    const waiting = [...this.sockets.values()].filter(client => !client.deviceId).length;
    if (this.sockets.size >= LIMITS.sockets || waiting >= LIMITS.unauthenticated) {
      transport.close(1013, 'Coordinator is busy. Try later.'); return null;
    }
    const client = { version: 1, connectionId: crypto.randomUUID(), authDeadline: this.now() + LIMITS.authMs,
      lastSeen: this.now(), rateStart: this.now(), rateCount: 0, transport };
    this.sockets.set(client.connectionId, client); this.save(client); return client.connectionId;
  }
  save(client) {
    const { transport, ...attachment } = client; transport.save(attachment);
  }
  send(client, payload) {
    if (client) { try { client.transport.send(payload); return true; } catch { /* Close callback cleans presence. */ } }
    return false;
  }
  error(client, message) { this.send(client, { type: 'error', message }); }
  current(client) { return this.sockets.get(client.connectionId) === client; }
  saveRequests(owner) {
    const requests = [...this.requests.values()].filter(request => request.targetId === owner.id);
    if (requests.length) owner.controlRequests = requests;
    else delete owner.controlRequests;
    this.save(owner);
  }
  deleteRequest(key) {
    const request = this.requests.get(key); if (!request) return;
    this.requests.delete(key); const owner = this.peer(request.targetId); if (owner) this.saveRequests(owner);
  }
  peer(id) { return typeof id === 'string' ? [...this.sockets.values()].find(client => client.id === id) : undefined; }
  accepted(room) { return [...this.sockets.values()].filter(client => client.roomId === room.id && client.accepted); }
  ready(room) { return this.accepted(room).filter(client => client.admissionReady === true); }
  pending(room) { return [...this.sockets.values()].filter(client => client.roomId === room.id && !client.accepted); }
  broadcastRoom(room, payload, exceptId) { for (const client of this.ready(room)) if (client.id !== exceptId) this.send(client, payload); }
  broadcastPresence() {
    const devices = [...this.devices.values()].map(device => {
      const online = [...this.sockets.values()].some(client => client.deviceId === device.id);
      const room = [...this.rooms.values()].find(item => item.ownerDeviceId === device.id && this.peer(item.hostId)?.admissionReady === true);
      return { id: device.id, name: device.name, online, hosting: Boolean(online && room), roomId: online && room ? room.id : null };
    });
    for (const client of this.sockets.values()) if (client.deviceId) this.send(client, { type: 'presence', devices });
  }
  close(client, message, code = 1008) {
    this.error(client, message); this.disconnect(client.connectionId); client.transport.close(code, message.slice(0, 100));
  }
  async receive(connectionId, raw) {
    this.reap();
    const client = this.sockets.get(connectionId); if (!client) return;
    if (typeof raw !== 'string' || encoder.encode(raw).byteLength > LIMITS.messageBytes) {
      this.close(client, 'Only bounded JSON messages are supported.', 1009); return;
    }
    if (this.now() - client.rateStart > 5000) { client.rateStart = this.now(); client.rateCount = 0; }
    if (++client.rateCount > 150) { this.close(client, 'Too many messages.'); return; }
    client.lastSeen = this.now(); this.save(client);
    let message;
    try { message = JSON.parse(raw); } catch { this.error(client, 'Invalid JSON.'); return; }
    if (!message || Array.isArray(message) || typeof message !== 'object' || typeof message.type !== 'string') {
      this.error(client, 'Invalid message.'); return;
    }
    if (!client.deviceId) {
      if (this.now() >= client.authDeadline) { this.close(client, 'Device authentication timed out.'); return; }
      if (client.authenticating) { this.close(client, 'Authentication is already in progress.'); return; }
      client.authenticating = true;
      try { await this.authenticate(client, message); }
      finally { delete client.authenticating; if (this.sockets.has(client.connectionId)) this.save(client); }
      return;
    }
    if (message.type === 'ping') { this.send(client, { type: 'pong', time: this.now() }); return; }
    if (['create-room', 'join', 'join-device', 'leave', 'forget'].includes(message.type)) {
      client.roomRevision = (client.roomRevision || 0) + 1; this.save(client);
    }
    if (message.type === 'forget') {
      const deviceId = client.deviceId;
      this.disconnect(client.connectionId); this.devices.delete(deviceId); this.store.deleteDevice(deviceId);
      this.send(client, { type: 'forgotten', deviceId }); this.broadcastPresence();
      client.transport.close(1000, 'Device forgotten.'); return;
    }
    if (message.type === 'leave') { this.leave(client); this.send(client, { type: 'room-left' }); return; }
    if (message.type === 'create-room') { await this.createRoom(client, message); return; }
    if (message.type === 'join' || message.type === 'join-device') { await this.join(client, message); return; }
    const room = this.rooms.get(client.roomId);
    if (!room || !client.accepted || client.admissionReady !== true) { this.error(client, 'Host approval and completed room admission are required.'); return; }
    if (message.type === 'ice-request') {
      const config = await this.ice(room);
      if (this.rooms.get(client.roomId) === room && client.accepted && client.admissionReady === true) this.send(client, { type: 'ice-config', ...config });
      return;
    }
    if (message.type === 'approve' || message.type === 'reject' || message.type === 'kick') {
      if (client.id !== room.hostId) { this.error(client, 'Only the host can manage room admission.'); return; }
      const target = this.peer(message.peerId);
      if (!target || target.roomId !== room.id || target.id === room.hostId ||
          (message.type === 'kick' ? !target.accepted : target.accepted)) { this.error(client, 'Participant not found.'); return; }
      if (message.type === 'approve') {
        if (target.admissionDeadline && this.now() >= target.admissionDeadline) {
          this.send(target, { type: 'rejected', reason: 'The connection request expired. Ask to join again.' });
          this.leave(target); this.error(client, 'The connection request expired.'); return;
        }
        if (this.accepted(room).length >= LIMITS.participants) { this.error(client, 'The room is full.'); return; }
        // Reserve a slot now, but expose no peer identity/signaling until the
        // welcome and announcement can be queued in one synchronous turn.
        target.accepted = true; target.admissionReady = false; this.save(target);
        await this.welcome(target, room, client);
      } else {
        this.send(target, { type: 'rejected', reason: message.type === 'reject' ? 'The host declined the request.' : 'The host ended your participation.' });
        const targetId = target.id; this.leave(target);
        this.send(client, { type: message.type === 'reject' ? 'join-rejected' : 'peer-kicked', peerId: targetId });
      }
      return;
    }
    if (message.type === 'signal') {
      const target = this.peer(message.to);
      if (!target || target.roomId !== room.id || !target.accepted || target.admissionReady !== true || target.id === client.id) { this.error(client, 'Approved recipient not found.'); return; }
      if (!message.data || Array.isArray(message.data) || typeof message.data !== 'object') { this.error(client, 'Invalid signaling data.'); return; }
      this.send(target, { type: 'signal', from: client.id, data: message.data }); return;
    }
    if (message.type === 'control-request') {
      const target = this.peer(message.to);
      if (!target || target.roomId !== room.id || !target.accepted || target.admissionReady !== true || target.id === client.id) { this.error(client, 'Approved screen owner not found.'); return; }
      const requestId = crypto.randomUUID();
      this.requests.set(`${target.id}:${client.id}`, { targetId: target.id, controllerId: client.id, requestId,
        createdAt: this.now(), expiresAt: this.now() + LIMITS.admissionMs, roomId: room.id,
        targetDeviceId: target.deviceId, controllerDeviceId: client.deviceId,
        targetConnectionId: target.connectionId, controllerConnectionId: client.connectionId });
      this.saveRequests(target);
      this.send(target, { type: 'control-request', from: client.id, name: client.name, requestId });
      this.send(client, { type: 'control-pending', to: target.id, requestId }); return;
    }
    if (message.type === 'control-response' || message.type === 'grant-control') {
      const target = this.peer(message.type === 'grant-control' ? message.peerId : message.to);
      if (!target || target.roomId !== room.id || !target.accepted || target.admissionReady !== true || target.id === client.id) { this.error(client, 'Approved controller not found.'); return; }
      const key = `${client.id}:${target.id}`; const request = this.requests.get(key);
      if (message.type === 'grant-control') {
        if (message.targetId !== client.id) { this.error(client, 'Only the screen owner can grant control.'); return; }
      } else if (!request || this.now() >= request.expiresAt || message.requestId !== request.requestId) {
        this.error(client, 'Control request not found or expired.'); return;
      }
      const accepted = message.type === 'grant-control' || message.accepted === true;
      if ((message.type === 'control-response' && typeof message.accepted !== 'boolean') || (accepted && !validSession(message.sessionId))) {
        this.error(client, 'A valid owner-issued control session is required.'); return;
      }
      this.deleteRequest(key);
      if (!accepted) { this.send(target, { type: 'control-response', from: client.id, accepted: false }); return; }
      this.releaseControl(client.id, 'Another controller was selected.');
      const grant = { ownerId: client.id, controllerId: target.id, sessionId: message.sessionId, roomId: room.id,
        ownerDeviceId: client.deviceId, controllerDeviceId: target.deviceId,
        ownerConnectionId: client.connectionId, controllerConnectionId: target.connectionId,
        createdAt: this.now(), expiresAt: this.now() + LIMITS.controlMs };
      this.grants.set(client.id, grant); client.grant = grant; this.save(client);
      this.send(target, { type: 'control-response', from: client.id, accepted: true, sessionId: grant.sessionId, expiresAt: grant.expiresAt });
      this.send(client, { type: 'control-granted', peerId: target.id, targetId: client.id, sessionId: grant.sessionId, expiresAt: grant.expiresAt }); return;
    }
    if (message.type === 'control-revoke' || message.type === 'revoke-control') {
      const grant = this.grants.get(client.id);
      if (!grant || (message.to && message.to !== grant.controllerId)) { this.error(client, 'Control grant not found.'); return; }
      this.releaseControl(client.id, 'Permission revoked.'); return;
    }
    this.error(client, 'Unsupported message type.');
  }
  async authenticate(client, message) {
    const name = cleanName(message.name);
    if (!name) { this.close(client, 'A device name is required.'); return; }
    let device;
    if (message.type === 'pair') {
      if (!validSecret(this.env.PAIRING_KEY) || !validSecret(message.pairingKey) ||
          !equal(await digest(message.pairingKey), await digest(this.env.PAIRING_KEY))) {
        this.close(client, 'Device pairing was refused.'); return;
      }
      if (this.devices.size >= LIMITS.devices) { this.close(client, 'The private device directory is full.'); return; }
      const token = secret();
      device = { id: crypto.randomUUID(), name, tokenHash: await digest(token), createdAt: this.now() };
      // Re-check after asynchronous hashing: concurrent attempts cannot pass the cap.
      if (!this.current(client) || this.now() >= client.authDeadline || this.devices.size >= LIMITS.devices) {
        this.close(client, 'The private device directory is full.'); return;
      }
      this.devices.set(device.id, device); this.store.saveDevice(device);
      this.send(client, { type: 'paired', deviceId: device.id, deviceToken: token });
    } else if (message.type === 'register') {
      device = typeof message.deviceId === 'string' && this.devices.get(message.deviceId);
      if (!device || !validSecret(message.deviceToken) || !equal(await digest(message.deviceToken), device.tokenHash)) {
        this.close(client, 'Device authentication was refused.'); return;
      }
      if (!this.current(client)) return;
      if (this.devices.get(device.id) !== device || this.now() >= client.authDeadline) {
        this.close(client, 'Device authentication was refused.'); return;
      }
      device.name = name; this.store.saveDevice(device);
    } else { this.close(client, 'Pair or authenticate your device first.'); return; }
    for (const other of [...this.sockets.values()]) {
      if (other !== client && other.deviceId === device.id) this.close(other, 'This device connected elsewhere.', 1000);
    }
    client.deviceId = device.id; client.name = device.name; delete client.authDeadline; this.save(client);
    this.send(client, { type: 'registered', deviceId: device.id }); this.broadcastPresence();
  }
  async createRoom(client, message) {
    if (client.roomId || [...this.rooms.values()].some(room => room.ownerDeviceId === client.deviceId)) {
      this.error(client, 'Leave your current room before hosting another.'); return;
    }
    const revision = client.roomRevision;
    const roomKey = secret(), hostToken = secret();
    const room = { id: crypto.randomUUID(), name: cleanName(message.name) || `${client.name}'s room`,
      ownerDeviceId: client.deviceId, roomKeyHash: await digest(roomKey), hostTokenHash: await digest(hostToken),
      hostId: null, createdAt: this.now(), startDeadline: this.now() + LIMITS.roomStartMs };
    if (!this.current(client) || client.roomRevision !== revision || client.roomId ||
        [...this.rooms.values()].some(item => item.ownerDeviceId === client.deviceId)) return;
    this.rooms.set(room.id, room); this.store.saveRoom(room);
    this.send(client, { type: 'room-created', roomId: room.id, roomKey, hostToken, name: room.name });
  }
  async join(client, message) {
    if (client.roomId) { this.error(client, 'Leave your current room first.'); return; }
    const revision = client.roomRevision;
    const viaDevice = message.type === 'join-device';
    const room = viaDevice ? [...this.rooms.values()].find(item => item.ownerDeviceId === message.deviceId && item.hostId) : this.rooms.get(message.roomId);
    const wantsHost = Object.hasOwn(message, 'hostToken');
    if (!room || (viaDevice && wantsHost) || (!viaDevice && (!validSecret(message.roomKey) ||
      !equal(await digest(message.roomKey), room.roomKeyHash)))) { this.error(client, 'Invalid invitation or room unavailable.'); return; }
    if (wantsHost && (client.deviceId !== room.ownerDeviceId || !validSecret(message.hostToken) ||
        !equal(await digest(message.hostToken), room.hostTokenHash) || room.hostId)) {
      this.error(client, 'Only the authenticated room owner can host.'); return;
    }
    if (!this.current(client) || client.roomRevision !== revision || client.roomId || this.rooms.get(room.id) !== room) return;
    if (!wantsHost && (!room.hostId || this.peer(room.hostId)?.admissionReady !== true)) { this.error(client, 'The room is waiting for its host.'); return; }
    if (!wantsHost && (this.accepted(room).length >= LIMITS.participants || this.pending(room).length >= LIMITS.pending)) {
      this.error(client, 'The room is full.'); return;
    }
    client.id = crypto.randomUUID(); client.roomId = room.id; client.role = wantsHost ? 'host' : 'guest'; client.accepted = wantsHost; client.admissionReady = false;
    if (wantsHost) {
      room.hostId = client.id; this.store.saveRoom(room); this.save(client);
      await this.welcome(client, room); this.broadcastPresence();
    } else {
      client.admissionDeadline = this.now() + LIMITS.admissionMs; this.save(client);
      this.send(client, { type: 'pending', selfId: client.id, room: roomInfo(room), message: 'Waiting for the host to approve.' });
      this.send(this.peer(room.hostId), { type: 'join-request', peerId: client.id, name: client.name });
    }
  }
  async welcome(client, room, owner = null) {
    const peerId = client.id, revision = client.roomRevision;
    const config = await this.ice(room);
    this.reap();
    if (!this.current(client) || client.id !== peerId || client.roomRevision !== revision ||
        client.roomId !== room.id || this.rooms.get(room.id) !== room || !client.accepted ||
        (owner && (!this.current(owner) || owner.id !== room.hostId || owner.roomId !== room.id || owner.admissionReady !== true))) return false;
    if (!this.send(client, { type: 'welcome', selfId: client.id, hostId: room.hostId, room: roomInfo(room),
      peers: this.ready(room).filter(peer => peer.id !== client.id).map(peerInfo), ...config })) return false;
    client.admissionReady = true; delete client.admissionDeadline; this.save(client);
    if (client.id === room.hostId) { delete room.startDeadline; this.store.saveRoom(room); }
    if (owner) {
      this.broadcastRoom(room, { type: 'peer-joined', peer: peerInfo(client) }, client.id);
      this.send(owner, { type: 'join-approved', peerId: client.id });
    }
    return true;
  }
  releaseControl(targetId, reason) {
    const grant = this.grants.get(targetId); if (!grant) return;
    this.grants.delete(targetId);
    const target = this.peer(targetId); if (target) { delete target.grant; this.save(target); }
    this.send(this.peer(grant.controllerId), { type: 'control-revoke', from: targetId, sessionId: grant.sessionId, reason });
    this.send(target, { type: 'control-revoked', peerId: grant.controllerId, sessionId: grant.sessionId, reason });
  }
  clearMembership(client) {
    client.roomRevision = (client.roomRevision || 0) + 1;
    for (const field of ['id', 'roomId', 'role', 'accepted', 'admissionReady', 'admissionDeadline', 'grant', 'controlRequests']) delete client[field]; this.save(client);
  }
  leave(client) {
    const room = this.rooms.get(client.roomId);
    if (!room) {
      for (const item of [...this.rooms.values()]) if (item.ownerDeviceId === client.deviceId) this.endRoom(item, 'The room host left.');
      this.clearMembership(client); return;
    }
    if (client.id === room.hostId) { this.endRoom(room, 'The room host left.'); return; }
    this.releaseControl(client.id, 'Screen owner disconnected.');
    for (const [targetId, grant] of [...this.grants]) if (grant.controllerId === client.id) this.releaseControl(targetId, 'Controller disconnected.');
    for (const [key, request] of [...this.requests]) if (request.targetId === client.id || request.controllerId === client.id) this.deleteRequest(key);
    if (client.admissionReady === true) this.broadcastRoom(room, { type: 'peer-left', peerId: client.id, id: client.id }, client.id);
    else this.send(this.peer(room.hostId), { type: 'join-cancelled', peerId: client.id });
    this.clearMembership(client); this.broadcastPresence();
  }
  endRoom(room, reason) {
    for (const [targetId, grant] of [...this.grants]) if (grant.roomId === room.id) this.releaseControl(targetId, reason);
    for (const [key, request] of [...this.requests]) if (request.roomId === room.id) this.deleteRequest(key);
    for (const client of [...this.sockets.values()]) if (client.roomId === room.id) {
      this.send(client, { type: 'room-ended', reason }); this.clearMembership(client);
    }
    this.rooms.delete(room.id); this.iceCache.delete(room.id); this.store.deleteRoom(room.id); this.broadcastPresence();
  }
  disconnect(connectionId) {
    const client = this.sockets.get(connectionId); if (!client) return;
    this.leave(client); this.sockets.delete(connectionId); this.broadcastPresence();
  }
  touch(connectionId, timestamp) {
    const client = this.sockets.get(connectionId);
    if (client && Number.isFinite(timestamp) && timestamp > client.lastSeen) { client.lastSeen = timestamp; this.save(client); }
  }
  reap() {
    const now = this.now();
    for (const client of [...this.sockets.values()]) {
      if ((!client.deviceId && now >= client.authDeadline) || now - client.lastSeen >= LIMITS.idleMs) {
        this.close(client, 'Connection timed out.', 1000); continue;
      }
      if (client.admissionDeadline && now >= client.admissionDeadline) {
        this.send(client, { type: 'rejected', reason: 'The connection request expired. Ask to join again.' }); this.leave(client);
      }
    }
    for (const room of [...this.rooms.values()]) {
      if (room.startDeadline && now >= room.startDeadline) this.endRoom(room, 'The host did not start the room.');
      else if (room.relayDeadline && now >= room.relayDeadline) this.endRoom(room, 'The free relay session time limit was reached.');
    }
    for (const [key, request] of [...this.requests]) if (now >= request.expiresAt) this.deleteRequest(key);
    for (const [targetId, grant] of [...this.grants]) if (now >= grant.expiresAt) this.releaseControl(targetId, 'The control permission expired. Ask the owner again.');
  }
  nextDeadline() {
    const deadlines = [...this.sockets.values()].flatMap(client => [client.authDeadline,
      client.lastSeen + LIMITS.idleMs, client.admissionDeadline]).concat([...this.rooms.values()]
      .flatMap(room => [room.startDeadline, room.relayDeadline]), [...this.grants.values()].map(grant => grant.expiresAt),
      [...this.requests.values()].map(request => request.expiresAt));
    return deadlines.filter(Number.isFinite).reduce((minimum, deadline) => Math.min(minimum, deadline), Infinity);
  }
  async ice(room) {
    const waiting = this.icePending.get(room.id); if (waiting) return waiting;
    const promise = this.loadIce(room); this.icePending.set(room.id, promise);
    try { return await promise; }
    finally { if (this.icePending.get(room.id) === promise) this.icePending.delete(room.id); }
  }
  async loadIce(room) {
    const direct = reason => ({ iceServers: DIRECT_ICE.map(server => ({ ...server })), relayEnabled: false, relaySecondsLimit: 0,
      ...(reason ? { relayReason: reason } : {}) });
    if (this.env.RELAY_ENABLED !== 'true') return direct('Relay is disabled. Direct connections only.');
    const domain = this.env.METERED_APP_DOMAIN || '';
    const expiry = Date.parse(this.env.METERED_CREDENTIAL_EXPIRES_AT || '');
    if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.metered\.live$/.test(domain) ||
        typeof this.env.METERED_API_KEY !== 'string' || this.env.METERED_API_KEY.length < 16 ||
        !Number.isFinite(expiry) || expiry <= this.now() + 30000 || expiry - this.now() > 86400000) {
      return direct('Relay needs a configured, expiring provider credential.');
    }
    const provider = await digest(JSON.stringify([domain, this.env.METERED_API_KEY, expiry]));
    if (this.rooms.get(room.id) !== room) return direct('The room ended.');
    const cached = this.iceCache.get(room.id);
    if (cached && cached.provider === provider && cached.config.relayExpiresAt === room.relayDeadline && room.relayDeadline > this.now()) {
      return { ...cached.config, relaySecondsLimit: Math.max(0, Math.floor((room.relayDeadline - this.now()) / 1000)) };
    }
    const restored = await this.readIceCache(room, provider, expiry);
    if (restored) {
      this.iceCache.set(room.id, { provider, config: restored });
      return { ...restored, relaySecondsLimit: Math.max(0, Math.floor((room.relayDeadline - this.now()) / 1000)) };
    }
    if (this.rooms.get(room.id) !== room) return direct('The room ended.');
    const current = new Date(this.now()).toISOString();
    const budget = this.store.loadBudget();
    const day = current.slice(0, 10), month = current.slice(0, 7);
    if (budget.day !== day) { budget.day = day; budget.daily = 0; }
    if (budget.month !== month) { budget.month = month; budget.monthly = 0; }
    const dailyLimit = positive(this.env.RELAY_DAILY_ISSUANCE_LIMIT, 4, 100);
    const monthlyLimit = positive(this.env.RELAY_MONTHLY_ISSUANCE_LIMIT, 60, 1000);
    if (budget.daily >= dailyLimit || budget.monthly >= monthlyLimit) return direct('The free relay issuance allowance is exhausted.');
    // Reserve before network I/O. Failed provider requests still count, preventing retry abuse.
    budget.daily++; budget.monthly++; this.store.saveBudget(budget);
    try {
      const url = new URL(`https://${domain}/api/v1/turn/credentials`);
      url.searchParams.set('apiKey', this.env.METERED_API_KEY);
      const response = await this.fetcher(url.href, { signal: AbortSignal.timeout(5000), redirect: 'manual', headers: { Accept: 'application/json' } });
      if (!response.ok) return direct('The relay provider is unavailable.');
      const reader = response.body?.getReader(); if (!reader) return direct('The relay provider returned an invalid configuration.');
      const chunks = []; let bytes = 0;
      for (;;) {
        const { done, value } = await reader.read(); if (done) break;
        bytes += value.byteLength;
        if (bytes > 16384) { await reader.cancel(); return direct('The relay provider returned an invalid configuration.'); }
        chunks.push(value);
      }
      const combined = new Uint8Array(bytes); let offset = 0;
      for (const chunk of chunks) { combined.set(chunk, offset); offset += chunk.byteLength; }
      const body = new TextDecoder().decode(combined);
      const supplied = JSON.parse(body);
      const iceServers = validatedIce(supplied);
      if (!iceServers) return direct('The relay provider returned no usable relay.');
      if (this.rooms.get(room.id) !== room || expiry <= this.now() + 1000 || (room.relayDeadline && room.relayDeadline <= this.now())) {
        return direct('The room or relay credential expired.');
      }
      const seconds = Math.min(positive(this.env.RELAY_SESSION_SECONDS, 600, 1800), Math.floor((expiry - this.now()) / 1000));
      const deadline = this.now() + seconds * 1000;
      room.relayDeadline = Math.min(room.relayDeadline || deadline, deadline); this.store.saveRoom(room);
      const config = { iceServers, relayEnabled: true, relaySecondsLimit: Math.max(0, Math.floor((room.relayDeadline - this.now()) / 1000)),
        relayExpiresAt: room.relayDeadline };
      const encrypted = await this.encryptIceCache(room, provider, config);
      if (this.rooms.get(room.id) !== room) return direct('The room ended.');
      room.iceCache = encrypted; this.store.saveRoom(room);
      this.iceCache.set(room.id, { provider, config }); return config;
    } catch { return direct('The relay provider is unavailable.'); }
  }
  async cacheKey() {
    if (!validSecret(this.env.PAIRING_KEY)) throw new Error('Cache key unavailable.');
    const raw = await crypto.subtle.digest('SHA-256', encoder.encode(`auralink-ice-cache-v1:${this.env.PAIRING_KEY}`));
    return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
  }
  async encryptIceCache(room, provider, config) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await this.cacheKey();
    const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv,
      additionalData: encoder.encode(`${room.id}:${provider}`) }, key, encoder.encode(JSON.stringify(config)));
    return { version: 1, provider, iv: encodeBytes(iv), cipher: encodeBytes(new Uint8Array(cipher)), expiresAt: config.relayExpiresAt };
  }
  async readIceCache(room, provider, providerExpiry) {
    const cache = room.iceCache;
    if (!cache || cache.version !== 1 || cache.provider !== provider || cache.expiresAt !== room.relayDeadline ||
        !Number.isFinite(cache.expiresAt) || cache.expiresAt <= this.now() || cache.expiresAt > providerExpiry) return null;
    try {
      const iv = decodeBytes(cache.iv, 12), cipher = decodeBytes(cache.cipher, 32768);
      if (iv.byteLength !== 12) return null;
      const clear = await crypto.subtle.decrypt({ name: 'AES-GCM', iv,
        additionalData: encoder.encode(`${room.id}:${provider}`) }, await this.cacheKey(), cipher);
      const config = JSON.parse(new TextDecoder().decode(clear));
      const iceServers = validatedIce(config.iceServers);
      if (!iceServers || config.relayEnabled !== true || config.relayExpiresAt !== cache.expiresAt) return null;
      return { ...config, iceServers };
    } catch { return null; }
  }
}
