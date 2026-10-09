// Platform-independent room policy. Transport adapters never supply peer identity.
export const LIMITS = Object.freeze({ devices: 32, sockets: 64, unauthenticated: 8,
  participants: 4, pending: 8, messageBytes: 65536, authMs: 10000,
  admissionMs: 60000, idleMs: 120000, roomStartMs: 30000, controlMs: 15 * 60000,
  publicClients: 48, publicRooms: 16, rooms: 48, publicSessionMs: 60 * 60000,
  publicBootstrapDaily: 1024, publicCreateDaily: 256, sourceDaily: 64,
  sourceBootstrapMinute: 8, sourceCreateHour: 8, sourceCounters: 256,
  publicCommandsDaily: 20000, publicRoomCommandsHourly: 2000 });
export const DIRECT_ICE = Object.freeze([{ urls: 'stun:stun.cloudflare.com:3478' }]);
export const WEBSOCKET_RELAY_LIMITS = Object.freeze({ maxMessageBytes: 262144, roomBytes: 536870912,
  roomSeconds: 0, dailyBytes: 1073741824, dailyMessages: 300000, senderBytesPer5s: 6291456,
  senderPacketsPer5s: 600, reservationBytes: 2097152, reservationMessages: 256 });
const encoder = new TextEncoder();
const SECRET = /^[A-Za-z0-9_-]{32,128}$/;
function validSecret(value) { return typeof value === 'string' && SECRET.test(value); }
function keysAre(value, keys) { return value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key)); }
// Canonical unpadded base64url needs no full binary copy to validate. The final
// sextet must have zero unused bits; otherwise several strings encode one value.
export function canonicalBase64url(value, minimumBytes, maximumBytes) {
  if (typeof value !== 'string' || value.length < Math.ceil(minimumBytes * 4 / 3) ||
      value.length > Math.ceil(maximumBytes * 4 / 3) || !/^[A-Za-z0-9_-]+$/.test(value)) return false;
  const remainder = value.length % 4;
  if (remainder === 1 || (remainder === 2 && !/[AQgw]$/.test(value)) ||
      (remainder === 3 && !/[AEIMQUYcgkosw048]$/.test(value))) return false;
  const bytes = Math.floor(value.length * 3 / 4);
  return bytes >= minimumBytes && bytes <= maximumBytes;
}
export function validRelaySignal(message) {
  if (!keysAre(message, ['type', 'to', 'data']) || message.type !== 'signal' ||
      typeof message.to !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(message.to) || !keysAre(message.data, ['relay'])) return false;
  const relay = message.data.relay;
  if (!keysAre(relay, ['version', 'epoch', 'counter', 'nonce', 'ciphertext']) || relay.version !== 1 ||
      typeof relay.epoch !== 'string' || typeof relay.nonce !== 'string' ||
      !/^[A-Za-z0-9_-]{16}$/.test(relay.epoch || '') || !/^[A-Za-z0-9_-]{16}$/.test(relay.nonce || '') ||
      !Number.isSafeInteger(relay.counter) || relay.counter < 1) return false;
  return canonicalBase64url(relay.ciphertext, 16, 180000);
}
export function cleanName(value) {
  if (typeof value !== 'string') return null;
  return value.normalize('NFKC').replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069<>]/g, '')
    .replace(/\s+/g, ' ').trim().slice(0, 48) || null;
}
export async function digest(value) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value)))]
    .map(byte => byte.toString(16).padStart(2, '0')).join('');
}
export async function sourceHash(address, serverSecret) {
  if (!validSecret(serverSecret)) throw new Error('Rate limit key unavailable.');
  const key = await crypto.subtle.importKey('raw', encoder.encode(serverSecret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return [...new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(`auralink-source-v1:${address}`)))]
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
function roomInfo(room) { return { id: room.id, name: room.name, maxParticipants: LIMITS.participants,
  ...(room.access === 'invite' ? { access: 'invite', inviteEnabled: Boolean(room.roomKeyHash), expiresAt: room.expiresAt } : {}) }; }
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

// These are the exact hosts/transports documented by Cloudflare's credential API.
// Its alternate port 53 is browser-blocked; accept that documented variant only
// to remove it, never to expose it to the client. No suffix or redirect trust.
const CLOUDFLARE_ICE_URLS = new Set(['stun:stun.cloudflare.com:3478',
  'turn:turn.cloudflare.com:3478?transport=udp', 'turn:turn.cloudflare.com:443?transport=udp',
  'turn:turn.cloudflare.com:3478?transport=tcp', 'turn:turn.cloudflare.com:80?transport=tcp',
  'turns:turn.cloudflare.com:5349?transport=tcp', 'turns:turn.cloudflare.com:443?transport=tcp',
  'turn:turn.cloudflare.com:53?transport=udp', 'turn:turn.cloudflare.com:53?transport=tcp']);
export function validatedCloudflareIce(supplied) {
  if (!Array.isArray(supplied) || !supplied.length || supplied.length > 12) return null;
  const iceServers = [];
  for (const entry of supplied) {
    const urls = Array.isArray(entry?.urls) ? entry.urls : [entry?.urls];
    if (!urls.length || urls.length > 8 || !urls.every(url => CLOUDFLARE_ICE_URLS.has(url))) return null;
    const relay = urls.some(url => /^turns?:/.test(url));
    if (!keysAre(entry, relay ? ['urls', 'username', 'credential'] : ['urls']) ||
        (relay && (!urls.every(url => /^turns?:/.test(url)) ||
          ![entry.username, entry.credential].every(value => typeof value === 'string' && /^[\x21-\x7e]{1,256}$/.test(value))))) return null;
    const usable = [...new Set(urls.filter(url => !/:53\?/.test(url)))];
    if (usable.length) iceServers.push(relay ? { urls: usable, username: entry.username, credential: entry.credential } : { urls: usable });
  }
  return iceServers.some(entry => entry.urls.some(url => /^turns?:/.test(url))) ? iceServers : null;
}

// A single deadline bounds fetching AND streamed body reads. The long-lived
// token is sent only to this fixed backend endpoint, never persisted or returned.
export async function requestCloudflareIce(fetcher, keyId, token, ttl) {
  const controller = new AbortController(); let reader, timer;
  const operation = (async () => {
    const response = await fetcher(`https://rtc.live.cloudflare.com/v1/turn/keys/${keyId}/credentials/generate-ice-servers`, {
      method: 'POST', redirect: 'manual', signal: controller.signal,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ ttl }) });
    if (response.status !== 201 || response.redirected ||
        !/^application\/json(?:\s*;|$)/i.test(response.headers?.get('content-type') || '')) return null;
    const declared = response.headers.get('content-length');
    if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > 16384)) return null;
    reader = response.body?.getReader(); if (!reader) return null;
    const chunks = []; let bytes = 0;
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      if (!(value instanceof Uint8Array) || (bytes += value.byteLength) > 16384) return null;
      chunks.push(value);
    }
    const combined = new Uint8Array(bytes); let offset = 0;
    for (const chunk of chunks) { combined.set(chunk, offset); offset += chunk.byteLength; }
    const body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(combined));
    if (!keysAre(body, ['iceServers'])) return null;
    const servers = validatedCloudflareIce(body.iceServers);
    if (servers?.some(server => server.username === token || server.credential === token)) return null;
    return servers;
  })();
  const deadline = new Promise((resolve, reject) => { timer = setTimeout(() => {
    controller.abort(); reject(new Error('The relay provider request timed out.'));
  }, 5000); });
  try { return await Promise.race([operation, deadline]); }
  finally {
    clearTimeout(timer); controller.abort();
    try { reader?.cancel().catch(() => {}); } catch {}
  }
}

export class Coordinator {
  constructor({ store, env = {}, now = () => Date.now(), fetcher = (input, init) => fetch(input, init), restored = [] }) {
    this.store = store; this.env = env; this.now = now; this.fetcher = fetcher;
    this.devices = new Map(store.loadDevices().map(device => [device.id, device]));
    this.rooms = new Map(store.loadRooms().map(room => [room.id, room]));
    this.publicBudget = store.loadPublicBudget?.() || { day: '', bootstrap: 0, create: 0, sources: {} };
    this.mediaBudget = store.loadMediaBudget?.() || { day: '', bytes: 0, messages: 0, rooms: {} };
    this.mediaBudgetValid = typeof this.mediaBudget.day === 'string' && Number.isSafeInteger(this.mediaBudget.bytes) &&
      this.mediaBudget.bytes >= 0 && Number.isSafeInteger(this.mediaBudget.messages) && this.mediaBudget.messages >= 0 &&
      this.mediaBudget.rooms && typeof this.mediaBudget.rooms === 'object' && !Array.isArray(this.mediaBudget.rooms) &&
      Object.keys(this.mediaBudget.rooms).length <= LIMITS.rooms && Object.entries(this.mediaBudget.rooms).every(([id, budget]) =>
        /^[a-f0-9-]{36}$/.test(id) && Number.isSafeInteger(budget.bytes) && budget.bytes >= 0 &&
        Number.isFinite(budget.startAt) && budget.startAt <= this.now());
    this.mediaKeys = new Map(); this.mediaKeyPending = new Map();
    this.sockets = new Map(); this.requests = new Map(); this.grants = new Map(); this.iceCache = new Map(); this.icePending = new Map();
    let restoredPublic = 0;
    for (const { transport, attachment } of restored) {
      if (!attachment || attachment.version !== 1 || !attachment.connectionId) {
        transport.close(1008, 'Connection state unavailable.'); continue;
      }
      const client = { ...attachment, transport };
      const publicIdentity = client.mode === 'public' && env.PUBLIC_ROOMS === 'true' &&
        /^public-[a-f0-9-]{36}$/.test(client.deviceId || '') && /^[a-f0-9]{64}$/.test(client.sourceHash || '') &&
        Number.isFinite(client.sessionDeadline) && (client.sessionDeadline === 0 ||
          (client.sessionDeadline > this.now() && client.sessionDeadline <= this.now() + LIMITS.publicSessionMs));
      if ((client.mode === 'public' && (!publicIdentity || restoredPublic >= LIMITS.publicClients)) ||
          (client.deviceId && client.mode !== 'public' && !this.devices.has(client.deviceId))) {
        transport.close(1008, 'Device registration unavailable.'); continue;
      }
      if (client.mode === 'public') restoredPublic++;
      // Credits are already charged in SQLite. A stale/corrupt lease is thrown
      // away without refund; restoration can never mint uncharged allowances.
      if (client.mediaLease && !this.validMediaLease(client, this.rooms.get(client.roomId))) delete client.mediaLease;
      this.sockets.set(client.connectionId, client);
    }
    let publicRooms = 0;
    for (const room of [...this.rooms.values()]) if (room.access === 'invite') {
      if (env.PUBLIC_ROOMS !== 'true' || publicRooms >= LIMITS.publicRooms || !Number.isFinite(room.createdAt) ||
          !Number.isFinite(room.expiresAt) || room.createdAt > this.now() ||
          (room.expiresAt !== 0 && (room.expiresAt <= this.now() || room.expiresAt - room.createdAt > LIMITS.publicSessionMs)) ||
          !/^public-[a-f0-9-]{36}$/.test(room.ownerDeviceId || '')) {
        this.endRoom(room, 'Public room state expired. Create a new room to continue.');
      } else publicRooms++;
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
  attach(transport, source = null) {
    const waiting = [...this.sockets.values()].filter(client => !client.deviceId).length;
    if (this.sockets.size >= LIMITS.sockets || waiting >= LIMITS.unauthenticated) {
      transport.close(1013, 'Coordinator is busy. Try later.'); return null;
    }
    const client = { version: 1, connectionId: crypto.randomUUID(), authDeadline: this.now() + LIMITS.authMs,
      lastSeen: this.now(), rateStart: this.now(), rateCount: 0,
      ...(typeof source === 'string' && /^[a-f0-9]{64}$/.test(source) ? { sourceHash: source } : {}), transport };
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
  publicAllowance(client, kind) {
    if (!/^[a-f0-9]{64}$/.test(client.sourceHash || '')) return false;
    const day = new Date(this.now()).toISOString().slice(0, 10);
    if (this.publicBudget.day !== day) this.publicBudget = { day, bootstrap: 0, create: 0, sources: {} };
    const budget = this.publicBudget;
    if (!budget.sources || typeof budget.sources !== 'object' || Array.isArray(budget.sources)) return false;
    let source = budget.sources[client.sourceHash];
    if (!source) {
      if (Object.keys(budget.sources).length >= LIMITS.sourceCounters) return false;
      source = budget.sources[client.sourceHash] = { daily: 0, minute: -1, bootstrap: 0, hour: -1, create: 0 };
    }
    const minute = Math.floor(this.now() / 60000), hour = Math.floor(this.now() / 3600000);
    if (source.minute !== minute) { source.minute = minute; source.bootstrap = 0; }
    if (source.hour !== hour) { source.hour = hour; source.create = 0; }
    if (kind === 'bootstrap') {
      if (budget.bootstrap >= LIMITS.publicBootstrapDaily || source.daily >= LIMITS.sourceDaily || source.bootstrap >= LIMITS.sourceBootstrapMinute) return false;
      budget.bootstrap++; source.daily++; source.bootstrap++;
    } else {
      if (budget.create >= LIMITS.publicCreateDaily || source.create >= LIMITS.sourceCreateHour) return false;
      budget.create++; source.create++;
    }
    this.store.savePublicBudget?.(budget); return true;
  }
  publicCommandAllowance(client) {
    if (client.mode !== 'public') return true;
    const day = new Date(this.now()).toISOString().slice(0, 10);
    if (this.publicBudget.day !== day) this.publicBudget = { day, bootstrap: 0, create: 0, sources: {} };
    const budget = this.publicBudget;
    if (budget.commands === undefined) budget.commands = 0;
    if (!Number.isSafeInteger(budget.commands) || budget.commands < 0 || budget.commands >= LIMITS.publicCommandsDaily) {
      this.send(client, { type: 'error', code: 'service-free-limit', message: 'The free public service command allowance is exhausted for today. Return after 00:00 UTC or use Nearby mode.' }); return false;
    }
    if (!budget.roomCommands) budget.roomCommands = {};
    for (const id of Object.keys(budget.roomCommands)) if (!this.rooms.has(id)) delete budget.roomCommands[id];
    if (client.roomId) {
      const hour = Math.floor(this.now() / 3600000);
      let usage = budget.roomCommands[client.roomId];
      if (!usage || usage.hour !== hour) usage = { hour, commands: 0 };
      if (!Number.isSafeInteger(usage.commands) || usage.commands < 0 || usage.commands >= LIMITS.publicRoomCommandsHourly) {
        this.send(client, { type: 'error', code: 'service-free-limit', message: 'This room reached its public command allowance for this hour. Wait for the next hour or use Nearby mode.' }); return false;
      }
      usage.commands++; budget.roomCommands[client.roomId] = usage;
    }
    budget.commands++; this.store.savePublicBudget(budget); return true;
  }
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
    for (const client of this.sockets.values()) if (client.deviceId && client.mode !== 'public') this.send(client, { type: 'presence', devices });
  }
  close(client, message, code = 1008) {
    this.error(client, message); this.disconnect(client.connectionId); client.transport.close(code, message.slice(0, 100));
  }
  async receive(connectionId, raw) {
    this.reap();
    const client = this.sockets.get(connectionId); if (!client) return;
    const wireBytes = typeof raw === 'string' ? encoder.encode(raw).byteLength : Infinity;
    if (wireBytes > WEBSOCKET_RELAY_LIMITS.maxMessageBytes) {
      this.close(client, 'Only bounded JSON messages are supported.', 1009); return;
    }
    if (!Number.isFinite(client.inputRateStart) || this.now() - client.inputRateStart >= 5000) { client.inputRateStart = this.now(); client.inputRateCount = 0; }
    if (!Number.isSafeInteger(client.inputRateCount) || client.inputRateCount < 0 ||
        ++client.inputRateCount > WEBSOCKET_RELAY_LIMITS.senderPacketsPer5s + 150) { this.close(client, 'Too many messages.'); return; }
    this.save(client);
    let message;
    try { message = JSON.parse(raw); } catch {
      if (wireBytes > LIMITS.messageBytes) this.close(client, 'Invalid or oversized encrypted media message.', 1009);
      else this.error(client, 'Invalid JSON.'); return;
    }
    if (!message || Array.isArray(message) || typeof message !== 'object' || typeof message.type !== 'string') {
      if (wireBytes > LIMITS.messageBytes) this.close(client, 'Invalid or oversized encrypted media message.', 1009);
      else this.error(client, 'Invalid message.'); return;
    }
    const encryptedRelay = message.type === 'signal' && Object.hasOwn(message.data || {}, 'relay');
    if ((wireBytes > LIMITS.messageBytes || encryptedRelay) && !validRelaySignal(message)) {
      this.close(client, 'Invalid or oversized encrypted media message.', 1009); return;
    }
    if (encryptedRelay) {
      if (!Number.isFinite(client.mediaRateStart) || this.now() - client.mediaRateStart >= 5000) {
        client.mediaRateStart = this.now(); client.mediaRateCount = 0;
      }
      if (!Number.isSafeInteger(client.mediaRateCount) || client.mediaRateCount < 0 ||
          ++client.mediaRateCount > WEBSOCKET_RELAY_LIMITS.senderPacketsPer5s) { this.close(client, 'Too many encrypted media messages.'); return; }
    } else {
      if (this.now() - client.rateStart >= 5000) { client.rateStart = this.now(); client.rateCount = 0; }
      if (++client.rateCount > 150) { this.close(client, 'Too many messages.'); return; }
    }
    client.lastSeen = this.now(); this.save(client);
    if (!client.deviceId) {
      if (this.now() >= client.authDeadline) { this.close(client, 'Device authentication timed out.'); return; }
      if (client.authenticating) { this.close(client, 'Authentication is already in progress.'); return; }
      client.authenticating = true;
      try { await this.authenticate(client, message); }
      finally { delete client.authenticating; if (this.sockets.has(client.connectionId)) this.save(client); }
      return;
    }
    if (message.type === 'ping') { this.send(client, { type: 'pong', time: this.now() }); return; }
    // Exact encrypted media uses its own byte/packet budget, never two writes.
    // Cleanup remains possible after quota exhaustion and is socket-bound.
    if (!encryptedRelay && !['leave', 'forget'].includes(message.type) && !this.publicCommandAllowance(client)) return;
    if (['create-room', 'join', 'join-device', 'leave', 'forget'].includes(message.type)) {
      client.roomRevision = (client.roomRevision || 0) + 1; this.save(client);
    }
    if (message.type === 'forget') {
      const deviceId = client.deviceId;
      this.disconnect(client.connectionId);
      if (client.mode !== 'public') { this.devices.delete(deviceId); this.store.deleteDevice(deviceId); }
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
    if (['burn-invite', 'rotate-invite', 'block'].includes(message.type)) {
      if (client.id !== room.hostId || room.access !== 'invite') { this.error(client, 'Only the host can change this invitation.'); return; }
      if (message.type === 'rotate-invite') { await this.rotateInvite(client, room); return; }
      if (message.type === 'block') {
        const target = this.peer(message.peerId);
        if (!target || target.roomId !== room.id || target.id === room.hostId) { this.error(client, 'Participant not found.'); return; }
        room.blocked = [...new Set([...(room.blocked || []), target.deviceId])].slice(-32);
        const targetId = target.id;
        this.send(target, { type: 'rejected', reason: 'The host blocked this connection and disabled the invitation.' });
        this.leave(target); this.send(client, { type: 'peer-blocked', peerId: targetId });
      }
      this.burnInvite(room); return;
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
      if (encryptedRelay) {
        const peerId = client.id, revision = client.roomRevision;
        const config = await this.websocketMedia(room); this.reap();
        if (!this.current(client) || client.id !== peerId || client.roomRevision !== revision || client.roomId !== room.id ||
            this.rooms.get(room.id) !== room || client.admissionReady !== true || !client.accepted || !this.current(target) ||
            target.roomId !== room.id || target.admissionReady !== true || !target.accepted) return;
        if (!config.websocketRelayEnabled) { this.send(client, { type: 'error', code: 'websocket-relay-limit', message: 'Encrypted media fallback is unavailable for this room. Create a new room or use a direct connection.' }); return; }
        if (!this.mediaAllowance(client, target, room, wireBytes)) return;
      }
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
    if (message.type === 'bootstrap') {
      if (this.env.PUBLIC_ROOMS !== 'true' || [...this.sockets.values()].filter(peer => peer.mode === 'public').length >= LIMITS.publicClients ||
          !this.publicAllowance(client, 'bootstrap')) { this.close(client, 'Public connection limit reached. Try again later.'); return; }
      client.deviceId = `public-${crypto.randomUUID()}`; client.mode = 'public'; client.name = name;
      // Zero means the authenticated socket has no wall-clock session cutoff.
      // Heartbeat loss, explicit leave and all capacity/usage quotas still apply.
      client.sessionDeadline = 0; delete client.authDeadline; this.save(client);
      this.send(client, { type: 'registered', deviceId: client.deviceId, mode: 'public' }); return;
    } else if (message.type === 'pair') {
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
    if (this.rooms.size >= LIMITS.rooms) { this.error(client, 'The coordinator room limit was reached. Try again later.'); return; }
    if (client.roomId || [...this.rooms.values()].some(room => room.ownerDeviceId === client.deviceId)) {
      this.error(client, 'Leave your current room before hosting another.'); return;
    }
    const publicRoom = client.mode === 'public';
    if (publicRoom && ([...this.rooms.values()].filter(room => room.access === 'invite').length >= LIMITS.publicRooms || !this.publicAllowance(client, 'create'))) {
      this.error(client, 'Public room limit reached. Try again later.'); return;
    }
    const revision = client.roomRevision;
    const roomKey = secret(), hostToken = secret();
    const room = { id: crypto.randomUUID(), name: cleanName(message.name) || `${client.name}'s room`,
      ownerDeviceId: client.deviceId, roomKeyHash: await digest(roomKey), hostTokenHash: await digest(hostToken),
      hostId: null, createdAt: this.now(), startDeadline: this.now() + LIMITS.roomStartMs,
      ...(publicRoom ? { access: 'invite', inviteRevision: 0, blocked: [], expiresAt: 0 } : {}) };
    if (!this.current(client) || client.roomRevision !== revision || client.roomId ||
        [...this.rooms.values()].some(item => item.ownerDeviceId === client.deviceId) ||
        this.rooms.size >= LIMITS.rooms || (publicRoom && [...this.rooms.values()].filter(item => item.access === 'invite').length >= LIMITS.publicRooms)) return;
    this.rooms.set(room.id, room); this.store.saveRoom(room);
    this.send(client, { type: 'room-created', roomId: room.id, roomKey, hostToken, name: room.name,
      ...(publicRoom ? { access: 'invite', inviteEnabled: true, expiresAt: room.expiresAt } : {}) });
  }
  burnInvite(room) {
    room.inviteRevision = (room.inviteRevision || 0) + 1; room.roomKeyHash = null; this.store.saveRoom(room);
    this.broadcastRoom(room, { type: 'invite-disabled', roomId: room.id, inviteEnabled: false });
  }
  async rotateInvite(client, room) {
    this.burnInvite(room); const revision = room.inviteRevision; const key = secret(); const hash = await digest(key);
    if (!this.current(client) || client.id !== room.hostId || this.rooms.get(room.id) !== room || room.inviteRevision !== revision) return;
    room.roomKeyHash = hash; this.store.saveRoom(room);
    this.send(client, { type: 'invite-updated', roomId: room.id, roomKey: key, inviteEnabled: true });
    this.broadcastRoom(room, { type: 'invite-status', roomId: room.id, inviteEnabled: true }, client.id);
  }
  async join(client, message) {
    if (client.roomId) { this.error(client, 'Leave your current room first.'); return; }
    const revision = client.roomRevision;
    const viaDevice = message.type === 'join-device';
    const room = viaDevice ? [...this.rooms.values()].find(item => item.ownerDeviceId === message.deviceId && item.hostId) : this.rooms.get(message.roomId);
    const wantsHost = Object.hasOwn(message, 'hostToken');
    if (client.mode === 'public' && (viaDevice || room?.access !== 'invite')) { this.error(client, 'Use a public room invitation code.'); return; }
    const inviteRevision = room?.inviteRevision, keyHash = room?.roomKeyHash;
    if (!room || (viaDevice && wantsHost) || (!viaDevice && (!validSecret(message.roomKey) ||
      !equal(await digest(message.roomKey), room.roomKeyHash)))) { this.error(client, 'Invalid invitation or room unavailable.'); return; }
    if (wantsHost && (client.deviceId !== room.ownerDeviceId || !validSecret(message.hostToken) ||
        !equal(await digest(message.hostToken), room.hostTokenHash) || room.hostId)) {
      this.error(client, 'Only the authenticated room owner can host.'); return;
    }
    if (!this.current(client) || client.roomRevision !== revision || client.roomId || this.rooms.get(room.id) !== room) return;
    if (room.access === 'invite' && (room.inviteRevision !== inviteRevision || room.roomKeyHash !== keyHash || !room.roomKeyHash || room.blocked?.includes(client.deviceId))) {
      this.error(client, 'This invitation was disabled or this connection was blocked. Ask the host for a new code.'); return;
    }
    if (!wantsHost && (!room.hostId || this.peer(room.hostId)?.admissionReady !== true)) { this.error(client, 'The room is waiting for its host.'); return; }
    if (!wantsHost && (this.accepted(room).length >= LIMITS.participants || this.pending(room).length >= LIMITS.pending)) {
      this.error(client, 'The room is full.'); return;
    }
    client.id = crypto.randomUUID(); client.roomId = room.id; client.role = wantsHost ? 'host' : 'guest'; client.accepted = wantsHost; client.admissionReady = false;
    if (wantsHost) {
      room.hostId = client.id; this.store.saveRoom(room); this.save(client);
      await this.welcome(client, room); this.broadcastPresence();
    } else if (room.access === 'invite') {
      client.accepted = true; client.admissionDeadline = this.now() + LIMITS.admissionMs;
      client.inviteRevision = inviteRevision; this.save(client);
      await this.welcome(client, room, this.peer(room.hostId));
    } else {
      client.admissionDeadline = this.now() + LIMITS.admissionMs; this.save(client);
      this.send(client, { type: 'pending', selfId: client.id, room: roomInfo(room), message: 'Waiting for the host to approve.' });
      this.send(this.peer(room.hostId), { type: 'join-request', peerId: client.id, name: client.name });
    }
  }
  async welcome(client, room, owner = null) {
    const peerId = client.id, revision = client.roomRevision;
    const config = await this.ice(room);
    const media = await this.websocketMedia(room);
    this.reap();
    if (!this.current(client) || client.id !== peerId || client.roomRevision !== revision ||
        client.roomId !== room.id || this.rooms.get(room.id) !== room || !client.accepted ||
        (owner && (!this.current(owner) || owner.id !== room.hostId || owner.roomId !== room.id || owner.admissionReady !== true))) return false;
    if (room.access === 'invite' && client.id !== room.hostId &&
        (client.inviteRevision !== room.inviteRevision || !room.roomKeyHash || room.blocked?.includes(client.deviceId))) {
      this.send(client, { type: 'rejected', reason: 'The invitation changed before connection completed. Ask the host for a new code.' }); this.leave(client); return false;
    }
    if (!this.send(client, { type: 'welcome', selfId: client.id, hostId: room.hostId, room: roomInfo(room),
      peers: this.ready(room).filter(peer => peer.id !== client.id).map(peerInfo), ...config, ...media })) return false;
    client.websocketRelayEnabled = media.websocketRelayEnabled === true;
    client.admissionReady = true; delete client.admissionDeadline; this.save(client);
    if (client.id === room.hostId) { delete room.startDeadline; this.store.saveRoom(room); }
    if (owner) {
      this.broadcastRoom(room, { type: 'peer-joined', peer: peerInfo(client) }, client.id);
      if (room.access !== 'invite') this.send(owner, { type: 'join-approved', peerId: client.id });
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
    for (const field of ['id', 'roomId', 'role', 'accepted', 'admissionReady', 'admissionDeadline', 'inviteRevision', 'grant', 'controlRequests', 'websocketRelayEnabled', 'mediaLease']) delete client[field]; this.save(client);
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
    this.rooms.delete(room.id); this.iceCache.delete(room.id); this.mediaKeys.delete(room.id); this.store.deleteRoom(room.id); this.broadcastPresence();
  }
  async websocketMedia(room) {
    const disabled = { websocketRelayEnabled: false };
    if (this.env.WEBSOCKET_RELAY !== 'true' || !this.mediaBudgetValid || this.rooms.get(room.id) !== room) return disabled;
    const waiting = this.mediaKeyPending.get(room.id); if (waiting) return waiting;
    const promise = this.loadMediaKey(room); this.mediaKeyPending.set(room.id, promise);
    try { return await promise; }
    finally { if (this.mediaKeyPending.get(room.id) === promise) this.mediaKeyPending.delete(room.id); }
  }
  async loadMediaKey(room) {
    const disabled = { websocketRelayEnabled: false }, provider = 'auralink-websocket-key-v1';
    let value = this.mediaKeys.get(room.id);
    try {
      if (!value && room.websocketKeyCache) {
        const cache = room.websocketKeyCache;
        if (cache.version !== 1 || cache.provider !== provider || !Number.isFinite(cache.expiresAt) ||
            (cache.expiresAt !== 0 && (cache.expiresAt <= this.now() || cache.expiresAt > this.now() + LIMITS.publicSessionMs))) return disabled;
        const iv = decodeBytes(cache.iv, 12), cipher = decodeBytes(cache.cipher, 1024);
        if (iv.length !== 12) return disabled;
        const clear = await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: encoder.encode(`${room.id}:${provider}`) }, await this.cacheKey(), cipher);
        value = JSON.parse(new TextDecoder().decode(clear));
        if (!keysAre(value, ['key', 'relayExpiresAt']) || !/^[A-Za-z0-9_-]{43}$/.test(value.key || '') ||
            encodeBytes(decodeBytes(value.key, 32)) !== value.key || value.relayExpiresAt !== cache.expiresAt) return disabled;
      } else if (!value) {
        // The encrypted key is bound to this live room via authenticated cache
        // data; room teardown removes it. Media remains byte/packet limited.
        value = { key: secret(), relayExpiresAt: 0 };
        const encrypted = await this.encryptIceCache(room, provider, value);
        if (this.rooms.get(room.id) !== room || (value.relayExpiresAt !== 0 && value.relayExpiresAt <= this.now())) return disabled;
        room.websocketKeyCache = encrypted; this.store.saveRoom(room);
      }
      if (this.rooms.get(room.id) !== room || (value.relayExpiresAt !== 0 && value.relayExpiresAt <= this.now())) return disabled;
      this.mediaKeys.set(room.id, value);
      return { websocketRelayEnabled: true, relayKey: value.key, websocketRelayLimits: { ...WEBSOCKET_RELAY_LIMITS } };
    } catch { return disabled; }
  }
  mediaAllowance(client, target, room, bytes) {
    const denied = message => { this.send(client, { type: 'error', code: 'websocket-relay-limit', message }); return false; };
    if (this.env.WEBSOCKET_RELAY !== 'true' || !this.mediaBudgetValid || client.websocketRelayEnabled !== true ||
        target.websocketRelayEnabled !== true || !room.websocketKeyCache ||
        (room.websocketKeyCache.expiresAt !== 0 && room.websocketKeyCache.expiresAt <= this.now())) {
      return denied('Encrypted media fallback is unavailable for this room. Create a new room or use a direct connection.');
    }
    const budget = this.mediaBudget, day = new Date(this.now()).toISOString().slice(0, 10);
    if (budget.day !== day) { budget.day = day; budget.bytes = 0; budget.messages = 0; }
    for (const id of Object.keys(budget.rooms)) if (!this.rooms.has(id)) delete budget.rooms[id];
    const usage = budget.rooms[room.id] || { bytes: 0, startAt: this.now() };
    if (WEBSOCKET_RELAY_LIMITS.roomSeconds > 0 && this.now() - usage.startAt >= WEBSOCKET_RELAY_LIMITS.roomSeconds * 1000) {
      return denied('This room reached its encrypted-media time limit. Create a new room or use a direct connection.');
    }
    if (!Number.isFinite(client.mediaBurstStart) || this.now() - client.mediaBurstStart >= 5000) { client.mediaBurstStart = this.now(); client.mediaBurstBytes = 0; }
    if (!Number.isSafeInteger(client.mediaBurstBytes) || client.mediaBurstBytes < 0 || client.mediaBurstBytes + bytes > WEBSOCKET_RELAY_LIMITS.senderBytesPer5s) {
      return denied('Encrypted-media sending is temporarily too fast. Reduce the screen quality and retry.');
    }
    let lease = this.validMediaLease(client, room) ? client.mediaLease : null;
    if (!lease || lease.bytesRemaining < bytes || lease.messagesRemaining < 1) {
      const byteCredits = lease?.bytesRemaining || 0, packetCredits = lease?.messagesRemaining || 0;
      const reservedBytes = byteCredits >= bytes ? 0 : Math.min(WEBSOCKET_RELAY_LIMITS.reservationBytes - byteCredits,
        WEBSOCKET_RELAY_LIMITS.dailyBytes - budget.bytes, WEBSOCKET_RELAY_LIMITS.roomBytes - usage.bytes);
      const reservedMessages = packetCredits >= 1 ? 0 : Math.min(WEBSOCKET_RELAY_LIMITS.reservationMessages - packetCredits,
        WEBSOCKET_RELAY_LIMITS.dailyMessages - budget.messages);
      if (reservedBytes + byteCredits < bytes || reservedMessages + packetCredits < 1) {
        if (budget.bytes + bytes - byteCredits > WEBSOCKET_RELAY_LIMITS.dailyBytes || reservedMessages + packetCredits < 1) {
          return denied('The free service encrypted-media allowance is exhausted for today. Try a direct connection or return after 00:00 UTC.');
        }
        return denied('This room reached its encrypted-media byte allowance. Create a new room or use a direct connection.');
      }
      // Reserve before exposing credits in the durable socket attachment. A
      // failure between these steps wastes credits; it cannot refund or reuse
      // them. SQLite counts reservations, not exact media delivered. Refill
      // bytes/packets independently while retaining only this socket's valid
      // residual; small audio/input packets do not waste fresh byte chunks.
      budget.bytes += reservedBytes; budget.messages += reservedMessages; usage.bytes += reservedBytes; budget.rooms[room.id] = usage;
      this.store.saveMediaBudget(budget);
      lease = { roomId: room.id, connectionId: client.connectionId, peerId: client.id, day, expiresAt: room.websocketKeyCache.expiresAt,
        bytesRemaining: byteCredits + reservedBytes, messagesRemaining: packetCredits + reservedMessages };
    }
    lease.bytesRemaining -= bytes; lease.messagesRemaining--;
    client.mediaLease = lease; client.mediaBurstBytes += bytes; this.save(client); return true;
  }
  validMediaLease(client, room) {
    const lease = client.mediaLease;
    return Boolean(room && this.mediaBudgetValid && this.mediaBudget.day === new Date(this.now()).toISOString().slice(0, 10) &&
      this.mediaBudget.rooms[room.id] && keysAre(lease, ['roomId', 'connectionId', 'peerId', 'day', 'expiresAt', 'bytesRemaining', 'messagesRemaining']) &&
      lease.roomId === room.id && client.roomId === room.id && lease.connectionId === client.connectionId && lease.peerId === client.id &&
      lease.day === new Date(this.now()).toISOString().slice(0, 10) &&
      Number.isFinite(lease.expiresAt) && lease.expiresAt === room.websocketKeyCache?.expiresAt &&
      (lease.expiresAt === 0 || lease.expiresAt > this.now()) &&
      Number.isSafeInteger(lease.bytesRemaining) && lease.bytesRemaining >= 0 && lease.bytesRemaining <= WEBSOCKET_RELAY_LIMITS.reservationBytes &&
      Number.isSafeInteger(lease.messagesRemaining) && lease.messagesRemaining >= 0 && lease.messagesRemaining <= WEBSOCKET_RELAY_LIMITS.reservationMessages &&
      this.mediaBudget.bytes >= lease.bytesRemaining && this.mediaBudget.messages >= lease.messagesRemaining &&
      this.mediaBudget.rooms[room.id].bytes >= lease.bytesRemaining);
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
      if ((!client.deviceId && now >= client.authDeadline) || now - client.lastSeen >= LIMITS.idleMs ||
          (client.sessionDeadline && now >= client.sessionDeadline)) {
        this.close(client, 'Connection timed out.', 1000); continue;
      }
      if (client.admissionDeadline && now >= client.admissionDeadline) {
        this.send(client, { type: 'rejected', reason: 'The connection request expired. Ask to join again.' }); this.leave(client);
      }
    }
    for (const room of [...this.rooms.values()]) {
      if (room.startDeadline && now >= room.startDeadline) this.endRoom(room, 'The host did not start the room.');
      else if (room.expiresAt && now >= room.expiresAt) this.endRoom(room, 'The room time limit was reached. Create a new room to continue.');
      else if (room.relayDeadline && now >= room.relayDeadline) this.endRoom(room, 'The free relay session time limit was reached.');
    }
    for (const [key, request] of [...this.requests]) if (now >= request.expiresAt) this.deleteRequest(key);
    for (const [targetId, grant] of [...this.grants]) if (now >= grant.expiresAt) this.releaseControl(targetId, 'The control permission expired. Ask the owner again.');
  }
  nextDeadline() {
    const deadlines = [...this.sockets.values()].flatMap(client => [client.authDeadline,
      client.lastSeen + LIMITS.idleMs, client.admissionDeadline, client.sessionDeadline]).concat([...this.rooms.values()]
      .flatMap(room => [room.startDeadline, room.relayDeadline, room.expiresAt]), [...this.grants.values()].map(grant => grant.expiresAt),
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
    const name = this.env.TURN_PROVIDER || 'metered';
    const sessionSeconds = positive(this.env.RELAY_SESSION_SECONDS, 600, 1800);
    let domain, expiry, provider, validate = validatedIce;
    if (name === 'cloudflare') {
      // This is an operator assertion, not a spending cap. Credential issuance
      // counters cannot bound external TURN traffic or account-wide billing.
      if (this.env.CLOUDFLARE_TURN_FREE_ONLY_CONFIRMED !== 'true') return direct('Cloudflare TURN awaits verified free-only account controls.');
      const keyId = this.env.CLOUDFLARE_TURN_KEY_ID, token = this.env.CLOUDFLARE_TURN_API_TOKEN;
      if (typeof keyId !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(keyId) ||
          typeof token !== 'string' || !/^[\x21-\x7e]{16,2048}$/.test(token)) return direct('Cloudflare TURN needs backend credentials.');
      expiry = this.now() + sessionSeconds * 1000;
      provider = await digest(JSON.stringify(['cloudflare', keyId, token, sessionSeconds]));
      validate = validatedCloudflareIce;
    } else if (name === 'metered') {
      domain = this.env.METERED_APP_DOMAIN || '';
      expiry = Date.parse(this.env.METERED_CREDENTIAL_EXPIRES_AT || '');
      if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.metered\.live$/.test(domain) ||
          typeof this.env.METERED_API_KEY !== 'string' || this.env.METERED_API_KEY.length < 16 ||
          !Number.isFinite(expiry) || expiry <= this.now() + 30000 || expiry - this.now() > 86400000) {
        return direct('Relay needs a configured, expiring provider credential.');
      }
      provider = await digest(JSON.stringify([domain, this.env.METERED_API_KEY, expiry]));
    } else {
      return direct('The configured TURN provider is unsupported.');
    }
    if (this.rooms.get(room.id) !== room) return direct('The room ended.');
    if (room.relayDeadline && room.relayDeadline <= this.now()) return direct('The room relay deadline expired.');
    const cached = this.iceCache.get(room.id);
    if (cached && cached.provider === provider && cached.config.relayExpiresAt === room.relayDeadline && room.relayDeadline > this.now()) {
      return { ...cached.config, relaySecondsLimit: Math.max(0, Math.floor((room.relayDeadline - this.now()) / 1000)) };
    }
    const restored = await this.readIceCache(room, provider, expiry, validate);
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
      let iceServers;
      if (name === 'cloudflare') {
        iceServers = await requestCloudflareIce(this.fetcher, this.env.CLOUDFLARE_TURN_KEY_ID,
          this.env.CLOUDFLARE_TURN_API_TOKEN, sessionSeconds);
        if (this.env.RELAY_ENABLED !== 'true' || this.env.CLOUDFLARE_TURN_FREE_ONLY_CONFIRMED !== 'true' ||
            this.env.TURN_PROVIDER !== 'cloudflare') return direct('Cloudflare TURN was disabled.');
      } else {
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
        iceServers = validatedIce(JSON.parse(new TextDecoder().decode(combined)));
      }
      if (!iceServers) return direct('The relay provider returned no usable relay.');
      if (this.rooms.get(room.id) !== room || expiry <= this.now() + 1000 || (room.relayDeadline && room.relayDeadline <= this.now())) {
        return direct('The room or relay credential expired.');
      }
      const seconds = Math.min(sessionSeconds, Math.floor((expiry - this.now()) / 1000));
      const deadline = Math.min(this.now() + seconds * 1000, Number.isFinite(room.expiresAt) && room.expiresAt > 0 ? room.expiresAt : Infinity);
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
  async readIceCache(room, provider, providerExpiry, validate = validatedIce) {
    const cache = room.iceCache;
    if (!cache || cache.version !== 1 || cache.provider !== provider || cache.expiresAt !== room.relayDeadline ||
        !Number.isFinite(cache.expiresAt) || cache.expiresAt <= this.now() || cache.expiresAt > providerExpiry) return null;
    try {
      const iv = decodeBytes(cache.iv, 12), cipher = decodeBytes(cache.cipher, 32768);
      if (iv.byteLength !== 12) return null;
      const clear = await crypto.subtle.decrypt({ name: 'AES-GCM', iv,
        additionalData: encoder.encode(`${room.id}:${provider}`) }, await this.cacheKey(), cipher);
      const config = JSON.parse(new TextDecoder().decode(clear));
      const iceServers = validate(config.iceServers);
      if (!iceServers || config.relayEnabled !== true || config.relayExpiresAt !== cache.expiresAt) return null;
      return { ...config, iceServers };
    } catch { return null; }
  }
}
