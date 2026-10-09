'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const modulePromise = import('../internet-service/src/coordinator.mjs');
const PAIRING_KEY = 'private-test-pairing-key-abcdefghijklmnopqrstuvwxyz';

class Store {
  constructor() { this.devices = new Map(); this.rooms = new Map(); this.budget = { daily: 0, monthly: 0 }; this.publicBudget = null; }
  loadDevices() { return [...this.devices.values()].map(value => structuredClone(value)); }
  saveDevice(value) { this.devices.set(value.id, structuredClone(value)); }
  deleteDevice(id) { this.devices.delete(id); }
  loadRooms() { return [...this.rooms.values()].map(value => structuredClone(value)); }
  saveRoom(value) { this.rooms.set(value.id, structuredClone(value)); }
  deleteRoom(id) { this.rooms.delete(id); }
  loadBudget() { return structuredClone(this.budget); }
  saveBudget(value) { this.budget = structuredClone(value); }
  loadPublicBudget() { return structuredClone(this.publicBudget); }
  savePublicBudget(value) { this.publicBudget = structuredClone(value); }
  loadMediaBudget() { return structuredClone(this.mediaBudget || null); }
  saveMediaBudget(value) { this.mediaBudget = structuredClone(value); this.mediaWrites = (this.mediaWrites || 0) + 1; }
}
function transport() {
  return { messages: [], attachment: null, closed: false,
    send(payload) { this.messages.push(structuredClone(payload)); },
    save(value) { this.attachment = structuredClone(value); },
    close(code, reason) { this.closed = { code, reason }; },
    take(type) { const at = this.messages.findIndex(message => message.type === type); return at < 0 ? null : this.messages.splice(at, 1)[0]; } };
}
async function setup(options = {}) {
  const { Coordinator, LIMITS } = await modulePromise;
  let time = Date.parse('2026-10-07T14:00:00Z');
  const store = new Store();
  const engine = new Coordinator({ store, now: () => time, env: { PAIRING_KEY, ...options.env }, fetcher: options.fetcher });
  const connect = (source = 'a'.repeat(64)) => { const ws = transport(); ws.id = engine.attach(ws, source); return ws; };
  const send = (ws, message) => engine.receive(ws.id, JSON.stringify(message));
  const pair = async name => { const ws = connect(); await send(ws, { type: 'pair', pairingKey: PAIRING_KEY, name }); ws.credentials = ws.take('paired'); assert.ok(ws.take('registered')); return ws; };
  const host = async (name = 'Host') => {
    const ws = await pair(name); await send(ws, { type: 'create-room', name: 'Private test room' });
    ws.room = ws.take('room-created'); assert.ok(ws.room);
    await send(ws, { ...ws.room, type: 'join' }); ws.welcome = ws.take('welcome'); assert.ok(ws.welcome); return ws;
  };
  const guest = async (owner, name, approve = true) => {
    const ws = await pair(name); await send(ws, { type: 'join-device', deviceId: owner.credentials.deviceId });
    ws.pending = ws.take('pending'); assert.ok(ws.pending);
    if (approve) { await send(owner, { type: 'approve', peerId: ws.pending.selfId }); ws.welcome = ws.take('welcome'); assert.ok(ws.welcome); }
    return ws;
  };
  const bootstrap = async (name, source) => { const ws = connect(source); await send(ws, { type: 'bootstrap', name }); ws.registered = ws.take('registered'); assert.equal(ws.registered?.mode, 'public'); return ws; };
  const publicHost = async (source) => {
    const ws = await bootstrap('Public owner', source); await send(ws, { type: 'create-room', name: 'Invitation room' });
    ws.room = ws.take('room-created'); assert.equal(ws.room.access, 'invite');
    await send(ws, { ...ws.room, type: 'join' }); ws.welcome = ws.take('welcome'); assert.ok(ws.welcome); return ws;
  };
  const publicGuest = async (owner, name = 'Guest', source) => {
    const ws = await bootstrap(name, source); await send(ws, { type: 'join', roomId: owner.room.roomId, roomKey: owner.room.roomKey });
    ws.welcome = ws.take('welcome'); assert.ok(ws.welcome); return ws;
  };
  return { engine, store, connect, send, pair, host, guest, bootstrap, publicHost, publicGuest, LIMITS, now: () => time, advance: ms => { time += ms; } };
}
function relaySignal(to, bytes = 70000, counter = 1) {
  return { type: 'signal', to, data: { relay: { version: 1, epoch: 'a'.repeat(16), nonce: 'b'.repeat(16),
    counter, ciphertext: Buffer.alloc(bytes, 91).toString('base64url') } } };
}

test('encrypted media forwarding uses strict envelopes and ready same-room membership, with no raw persistence', async () => {
  const { WEBSOCKET_RELAY_LIMITS: limits } = await modulePromise;
  const s = await setup({ env: { WEBSOCKET_RELAY: 'true' } }); const owner = await s.host();
  assert.equal(owner.welcome.websocketRelayEnabled, true); assert.match(owner.welcome.relayKey, /^[A-Za-z0-9_-]{43}$/);
  const guest = await s.guest(owner, 'Guest', false);
  assert.equal(guest.pending.relayKey, undefined);
  const message = relaySignal(owner.welcome.selfId); await s.send(guest, message);
  assert.match(guest.take('error').message, /approval/); assert.equal(owner.take('signal'), null); assert.equal(s.store.mediaBudget, undefined);
  await s.send(owner, { type: 'approve', peerId: guest.pending.selfId }); guest.welcome = guest.take('welcome');
  assert.equal(guest.welcome.relayKey, owner.welcome.relayKey);
  await s.send(guest, message); const forwarded = owner.take('signal');
  assert.deepEqual(Object.keys(forwarded).sort(), ['data', 'from', 'type']); assert.equal(forwarded.from, guest.welcome.selfId);
  assert.deepEqual(forwarded.data, message.data); assert.equal(s.store.mediaBudget.messages, limits.reservationMessages);
  assert.equal(s.store.mediaBudget.bytes, limits.reservationBytes);
  assert.equal(guest.attachment.mediaLease.bytesRemaining, limits.reservationBytes - Buffer.byteLength(JSON.stringify(message)));
  assert.equal(guest.attachment.mediaLease.messagesRemaining, limits.reservationMessages - 1);
  const persisted = JSON.stringify({ rooms: [...s.store.rooms.values()], budget: s.store.mediaBudget, attachments: [owner.attachment, guest.attachment] });
  assert.equal(persisted.includes(owner.welcome.relayKey), false); assert.equal(persisted.includes(message.data.relay.ciphertext), false);
  const other = await s.host('Other host'); await s.send(guest, relaySignal(other.welcome.selfId));
  assert.match(guest.take('error').message, /not found|room/i); assert.equal(other.take('signal'), null); assert.equal(s.store.mediaBudget.messages, limits.reservationMessages);
  await s.send(owner, { type: 'kick', peerId: guest.welcome.selfId }); await s.send(guest, message);
  assert.equal(owner.take('signal'), null); assert.equal(s.store.mediaBudget.messages, limits.reservationMessages); assert.equal(guest.attachment.mediaLease, undefined);
});

test('encrypted media byte, packet and burst limits survive hibernation; connected rooms have no fixed time cutoff', async () => {
  const { Coordinator, WEBSOCKET_RELAY_LIMITS: limits } = await modulePromise;
  const env = { PAIRING_KEY, WEBSOCKET_RELAY: 'true' };
  const s = await setup({ env }); const owner = await s.host(); const guest = await s.guest(owner, 'Guest');
  const message = relaySignal(owner.welcome.selfId, 180000), size = Buffer.byteLength(JSON.stringify(message));
  for (let i = 0; i < Math.floor(limits.senderBytesPer5s / size); i++) await s.send(guest, message);
  const before = s.store.mediaBudget.messages;
  let resumed = new Coordinator({ store: s.store, env, now: s.now, restored: [owner, guest].map(ws => ({ transport: ws, attachment: structuredClone(ws.attachment) })) });
  owner.messages = []; guest.messages = []; await resumed.receive(guest.id, JSON.stringify(message));
  assert.equal(owner.take('signal'), null); assert.match(guest.take('error').message, /too fast/); assert.equal(s.store.mediaBudget.messages, before);
  s.advance(5000); await resumed.receive(guest.id, JSON.stringify(message)); assert.ok(owner.take('signal'));
  // Already reserved credits remain spendable at the global ceiling. Force a
  // fresh reservation to exercise refusal without falsely refunding a lease.
  delete resumed.sockets.get(guest.id).mediaLease; resumed.save(resumed.sockets.get(guest.id));
  resumed.mediaBudget.messages = limits.dailyMessages; resumed.store.saveMediaBudget(resumed.mediaBudget);
  await resumed.receive(guest.id, JSON.stringify(message)); assert.equal(guest.take('error').code, 'websocket-relay-limit'); assert.equal(owner.take('signal'), null);
  resumed = new Coordinator({ store: s.store, env, now: s.now, restored: [owner, guest].map(ws => ({ transport: ws, attachment: structuredClone(ws.attachment) })) });
  await resumed.receive(guest.id, JSON.stringify(message)); assert.match(guest.take('error').message, /today/);
  resumed.mediaBudget.messages = 0; resumed.mediaBudget.bytes = limits.dailyBytes; await resumed.receive(guest.id, JSON.stringify(message)); assert.match(guest.take('error').message, /today/);
  resumed.mediaBudget.bytes = 0; resumed.mediaBudget.rooms[owner.room.roomId].bytes = limits.roomBytes;
  // Simulate midnight global rollover without extending this room's persisted byte limit.
  resumed.mediaBudget.day = '2026-10-06'; await resumed.receive(guest.id, JSON.stringify(message)); assert.match(guest.take('error').message, /room.*byte/i);
  assert.equal(resumed.mediaBudget.messages, 0); resumed.mediaBudget.rooms[owner.room.roomId].bytes = 0;
  for (let i = 0; i < 60; i++) { s.advance(30000); resumed.touch(owner.id, s.now()); resumed.touch(guest.id, s.now()); }
  await resumed.receive(guest.id, JSON.stringify(message)); assert.ok(owner.take('signal')); assert.equal(guest.take('error'), null);
  assert.equal(resumed.rooms.size, 1); assert.equal(owner.take('room-ended'), null); // Direct calls remain available.
});

test('media reservations batch SQL writes and hibernation retains depleted socket credits', async () => {
  const { Coordinator, WEBSOCKET_RELAY_LIMITS: limits } = await modulePromise;
  const env = { PAIRING_KEY, WEBSOCKET_RELAY: 'true' }, s = await setup({ env });
  const owner = await s.host(), guest = await s.guest(owner, 'Guest');
  for (let i = 1; i <= 200; i++) await s.send(guest, relaySignal(owner.welcome.selfId, 16, i));
  assert.equal(s.store.mediaWrites, 1); assert.equal(s.store.mediaBudget.messages, limits.reservationMessages);
  assert.equal(guest.attachment.mediaLease.messagesRemaining, 56);
  const before = structuredClone(guest.attachment.mediaLease);
  const resumed = new Coordinator({ store: s.store, env, now: s.now,
    restored: [owner, guest].map(ws => ({ transport: ws, attachment: structuredClone(ws.attachment) })) });
  assert.deepEqual(resumed.sockets.get(guest.id).mediaLease, before);
  for (let i = 201; i <= 256; i++) await resumed.receive(guest.id, JSON.stringify(relaySignal(owner.welcome.selfId, 16, i)));
  assert.equal(s.store.mediaWrites, 1); assert.equal(guest.attachment.mediaLease.messagesRemaining, 0);
  await resumed.receive(guest.id, JSON.stringify(relaySignal(owner.welcome.selfId, 16, 257)));
  assert.equal(s.store.mediaWrites, 2); assert.equal(s.store.mediaBudget.messages, limits.reservationMessages * 2);
  assert.equal(s.store.mediaBudget.bytes, limits.reservationBytes);
  assert.equal(owner.messages.filter(message => message.type === 'signal').length, 257);
});

test('already charged residual remains usable at reservation ceilings without new SQL writes', async () => {
  const { WEBSOCKET_RELAY_LIMITS: limits } = await modulePromise;
  const s = await setup({ env: { WEBSOCKET_RELAY: 'true' } }), owner = await s.host(), guest = await s.guest(owner, 'Guest');
  await s.send(guest, relaySignal(owner.welcome.selfId, 16)); assert.ok(owner.take('signal'));
  s.engine.mediaBudget.bytes = limits.dailyBytes; s.engine.mediaBudget.messages = limits.dailyMessages;
  s.engine.mediaBudget.rooms[owner.room.roomId].bytes = limits.roomBytes;
  s.store.saveMediaBudget(s.engine.mediaBudget); const writes = s.store.mediaWrites;
  await s.send(guest, relaySignal(owner.welcome.selfId, 16, 2)); assert.ok(owner.take('signal')); assert.equal(s.store.mediaWrites, writes);
  delete s.engine.sockets.get(guest.id).mediaLease;
  await s.send(guest, relaySignal(owner.welcome.selfId, 16, 3)); assert.equal(guest.take('error').code, 'websocket-relay-limit');
  assert.equal(owner.take('signal'), null); assert.equal(s.store.mediaWrites, writes);
});

test('crash between durable SQL reservation and attachment save only wastes credits and forwards nothing', async () => {
  const { Coordinator, WEBSOCKET_RELAY_LIMITS: limits } = await modulePromise;
  for (const failure of ['SQL-after-write', 'attachment-before-save']) {
    const env = { PAIRING_KEY, WEBSOCKET_RELAY: 'true' }, s = await setup({ env });
    const owner = await s.host(), guest = await s.guest(owner, 'Guest');
    const oldAttachment = structuredClone(guest.attachment), message = relaySignal(owner.welcome.selfId, 16);
    if (failure === 'SQL-after-write') {
      const original = s.store.saveMediaBudget.bind(s.store);
      s.store.saveMediaBudget = value => { original(value); throw new Error('Injected crash after durable reservation.'); };
    } else {
      const original = guest.save.bind(guest);
      guest.save = value => { if (value.mediaLease) throw new Error('Injected crash before attachment persistence.'); original(value); };
    }
    await assert.rejects(s.send(guest, message), /Injected crash/);
    assert.equal(owner.take('signal'), null); assert.equal(s.store.mediaBudget.bytes, limits.reservationBytes);
    // Reconstruct using the durable pre-crash attachment, never in-memory lease.
    s.store.saveMediaBudget = Store.prototype.saveMediaBudget.bind(s.store); guest.save = transport().save;
    const resumed = new Coordinator({ store: s.store, env, now: s.now,
      restored: [{ transport: owner, attachment: structuredClone(owner.attachment) }, { transport: guest, attachment: oldAttachment }] });
    await resumed.receive(guest.id, JSON.stringify(message)); assert.ok(owner.take('signal'));
    assert.equal(s.store.mediaBudget.bytes, limits.reservationBytes * 2);
    assert.equal(s.store.mediaBudget.messages, limits.reservationMessages * 2);
  }
});

test('copied, oversized, expired or foreign-day media leases cannot restore uncharged credits', async () => {
  const { Coordinator, WEBSOCKET_RELAY_LIMITS: limits } = await modulePromise;
  for (const failure of ['connectionId', 'peerId', 'roomId', 'day', 'expiry', 'bytes', 'messages', 'extra']) {
    const env = { PAIRING_KEY, WEBSOCKET_RELAY: 'true' }, s = await setup({ env });
    const owner = await s.host(), guest = await s.guest(owner, 'Guest');
    await s.send(guest, relaySignal(owner.welcome.selfId, 16)); owner.take('signal');
    const attachment = structuredClone(guest.attachment), lease = attachment.mediaLease;
    if (['connectionId', 'peerId', 'roomId'].includes(failure)) lease[failure] = crypto.randomUUID();
    if (failure === 'day') lease.day = '2026-10-06';
    if (failure === 'expiry') lease.expiresAt += 1;
    if (failure === 'bytes') lease.bytesRemaining = limits.reservationBytes + 1;
    if (failure === 'messages') lease.messagesRemaining = limits.reservationMessages + 1;
    if (failure === 'extra') lease.other = true;
    const resumed = new Coordinator({ store: s.store, env, now: s.now,
      restored: [{ transport: owner, attachment: structuredClone(owner.attachment) }, { transport: guest, attachment }] });
    assert.equal(resumed.sockets.get(guest.id).mediaLease, undefined, failure);
    await resumed.receive(guest.id, JSON.stringify(relaySignal(owner.welcome.selfId, 16, 2))); assert.ok(owner.take('signal'), failure);
    assert.equal(s.store.mediaBudget.bytes, limits.reservationBytes * 2, failure);
  }
});

test('encrypted room key is shared through healthy hibernation and refuses tampering, key rotation or copied-room replay', async () => {
  const { Coordinator } = await modulePromise;
  for (const mutation of ['none', 'cipher', 'pairing-key', 'room-copy']) {
    const env = { PAIRING_KEY, WEBSOCKET_RELAY: 'true' }; const s = await setup({ env });
    const owner = await s.host(); const guest = await s.guest(owner, 'Guest');
    await s.send(guest, relaySignal(owner.welcome.selfId)); owner.take('signal');
    if (mutation === 'cipher') s.store.rooms.get(owner.room.roomId).websocketKeyCache.cipher = 'a'.repeat(100);
    if (mutation === 'pairing-key') env.PAIRING_KEY = 'new-server-pairing-key-abcdefghijklmnopqrstuvwxyz';
    if (mutation === 'room-copy') {
      const old = s.store.rooms.get(owner.room.roomId), changed = crypto.randomUUID(); s.store.rooms.clear(); old.id = changed; s.store.rooms.set(changed, old);
      owner.attachment.roomId = changed; guest.attachment.roomId = changed;
    }
    const resumed = new Coordinator({ store: s.store, env, now: s.now, restored: [owner, guest].map(ws => ({ transport: ws, attachment: structuredClone(ws.attachment) })) });
    const room = [...resumed.rooms.values()][0]; const config = await resumed.websocketMedia(room);
    assert.equal(config.websocketRelayEnabled, mutation === 'none', mutation);
    if (mutation === 'none') assert.equal(config.relayKey, owner.welcome.relayKey);
    await resumed.receive(guest.id, JSON.stringify(relaySignal(owner.welcome.selfId)));
    if (mutation === 'none') assert.ok(owner.take('signal')); else { assert.equal(owner.take('signal'), null); assert.equal(guest.take('error').code, 'websocket-relay-limit'); }
  }
});

test('malformed relay or oversized plaintext cannot use the increased transport bound', async () => {
  const { validRelaySignal } = await modulePromise; const s = await setup({ env: { WEBSOCKET_RELAY: 'true' } }); const owner = await s.host();
  const variants = [message => { message.from = 'spoofed'; }, message => { message.data.sdp = 'plaintext'; },
    message => { message.data.relay.codec = 'plaintext'; }, message => { message.data.relay.counter = Number.MAX_SAFE_INTEGER + 1; },
    message => { message.data.relay.epoch = 'x'; }, message => { message.data.relay.nonce = 'x'; },
    message => { message.data.relay.ciphertext = Buffer.alloc(180001).toString('base64url'); },
    message => { message.data.relay.ciphertext = 'a'.repeat(23); }, message => { message.data.relay.ciphertext = 'x'.repeat(21); }];
  for (const change of variants) { const message = relaySignal(owner.welcome.selfId); change(message); assert.equal(validRelaySignal(message), false); }
  for (const message of [relaySignal(owner.welcome.selfId), { type: 'signal', to: owner.welcome.selfId, data: { plaintext: 'x'.repeat(70000) } }]) {
    const outsider = s.connect(); if (message.data.relay) message.data.extra = 'no'; await s.send(outsider, message); assert.equal(outsider.closed.code, 1009);
  }
  const disabled = await setup(); const offOwner = await disabled.host(); const offGuest = await disabled.guest(offOwner, 'Guest');
  await disabled.send(offGuest, relaySignal(offOwner.welcome.selfId, 16)); assert.equal(offGuest.take('error').code, 'websocket-relay-limit'); assert.equal(offOwner.take('signal'), null);
});

test('media key decryption completing after leave cannot forward into a replacement room', async () => {
  const s = await setup({ env: { WEBSOCKET_RELAY: 'true' } }); const owner = await s.host(); const guest = await s.guest(owner, 'Guest');
  let finish, started; const ready = new Promise(resolve => { started = resolve; });
  const original = s.engine.websocketMedia.bind(s.engine);
  s.engine.websocketMedia = async room => { started(); await new Promise(resolve => { finish = resolve; }); return original(room); };
  const forward = s.send(guest, relaySignal(owner.welcome.selfId)); await ready;
  await s.send(guest, { type: 'leave' }); finish(); await forward;
  assert.equal(owner.take('signal'), null); assert.equal(s.store.mediaBudget, undefined); assert.equal(guest.attachment.roomId, undefined);
});

test('public normal-command quota is persistent and excludes cleanup, heartbeats and separately metered media', async () => {
  const { Coordinator } = await modulePromise, env = { PAIRING_KEY, PUBLIC_ROOMS: 'true', WEBSOCKET_RELAY: 'true' };
  const s = await setup({ env }); const owner = await s.publicHost(); const guest = await s.publicGuest(owner);
  const before = s.store.publicBudget.commands; await s.send(guest, { type: 'ping' }); assert.equal(s.store.publicBudget.commands, before);
  await s.send(guest, relaySignal(owner.welcome.selfId)); assert.ok(owner.take('signal')); assert.equal(s.store.publicBudget.commands, before);
  s.engine.publicBudget.commands = s.LIMITS.publicCommandsDaily; s.store.savePublicBudget(s.engine.publicBudget);
  const resumed = new Coordinator({ store: s.store, env, now: s.now, restored: [owner, guest].map(ws => ({ transport: ws, attachment: structuredClone(ws.attachment) })) });
  await resumed.receive(guest.id, JSON.stringify({ type: 'signal', to: owner.welcome.selfId, data: { sdp: 'budgeted' } }));
  assert.equal(owner.take('signal'), null); assert.equal(guest.take('error').code, 'service-free-limit');
  await resumed.receive(guest.id, '{"type":"leave"}'); assert.ok(guest.take('room-left'));
  resumed.publicBudget.commands = 0; resumed.publicBudget.roomCommands = { [owner.room.roomId]: { hour: Math.floor(s.now() / 3600000), commands: s.LIMITS.publicRoomCommandsHourly } };
  await resumed.receive(owner.id, '{"type":"ice-request"}'); assert.equal(owner.take('error').code, 'service-free-limit');
  await resumed.receive(owner.id, '{"type":"forget"}'); assert.ok(owner.take('forgotten'));
});

test('public bootstrap is opt-in, ephemeral and cannot read or impersonate the private directory', async () => {
  const disabled = await setup(); const blocked = disabled.connect(); await disabled.send(blocked, { type: 'bootstrap', name: 'Public guest' });
  assert.ok(blocked.closed); assert.equal(blocked.take('registered'), null);
  const s = await setup({ env: { PUBLIC_ROOMS: 'true' } }); const privateOwner = await s.pair('Private owner');
  const guest = await s.bootstrap('Public guest'); assert.equal(s.store.devices.size, 1);
  assert.equal(guest.take('paired'), null); assert.equal(guest.take('presence'), null);
  await s.send(privateOwner, { type: 'ping' }); s.engine.broadcastPresence(); assert.equal(guest.take('presence'), null);
  const lastPresence = privateOwner.messages.filter(message => message.type === 'presence').at(-1);
  assert.deepEqual(lastPresence.devices.map(device => device.id), [privateOwner.credentials.deviceId]);
  await s.send(guest, { type: 'join-device', deviceId: privateOwner.credentials.deviceId }); assert.match(guest.take('error').message, /public room invitation/);
  await s.send(guest, { type: 'register', ...privateOwner.credentials, name: 'Impostor' });
  assert.equal(guest.attachment.deviceId, guest.registered.deviceId); assert.equal(guest.take('registered'), null);
  await s.send(guest, { type: 'forget' }); assert.ok(guest.take('forgotten')); assert.equal(s.store.devices.size, 1);
});

test('a public invitation automatically admits guests but never grants remote control or host authority', async () => {
  const s = await setup({ env: { PUBLIC_ROOMS: 'true' } }); const owner = await s.publicHost();
  assert.match(owner.room.roomKey, /^[A-Za-z0-9_-]{43}$/); assert.match(owner.room.hostToken, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(s.store.devices.size, 0); assert.equal(JSON.stringify([...s.store.rooms.values()]).includes(owner.room.roomKey), false);
  const guest = await s.publicGuest(owner); assert.equal(guest.take('pending'), null); assert.equal(owner.take('join-request'), null);
  assert.equal(guest.welcome.room.access, 'invite'); assert.equal(guest.welcome.room.inviteEnabled, true);
  assert.equal(owner.take('peer-joined').peer.id, guest.welcome.selfId); assert.equal(s.engine.grants.size, 0);
  await s.send(guest, { type: 'signal', from: 'forged-host', to: owner.welcome.selfId, data: { fixture: true } });
  assert.equal(owner.take('signal').from, guest.welcome.selfId);
  await s.send(guest, { type: 'grant-control', targetId: owner.welcome.selfId, peerId: owner.welcome.selfId, sessionId: 'fixture-consent-session-12345' });
  assert.match(guest.take('error').message, /screen owner/); assert.equal(s.engine.grants.size, 0);
  await s.send(guest, { type: 'control-request', to: owner.welcome.selfId }); const request = owner.take('control-request');
  await s.send(owner, { type: 'control-response', to: guest.welcome.selfId, requestId: request.requestId, accepted: true, sessionId: 'separate-owner-consent-session' });
  assert.equal(guest.take('control-response').accepted, true); assert.equal(s.engine.grants.size, 1);
  const impostor = await s.bootstrap('Owner impostor'); await s.send(impostor, { ...owner.room, type: 'join' });
  assert.match(impostor.take('error').message, /authenticated room owner/); assert.equal(impostor.take('welcome'), null);
});

test('invite burn, rotation and block revoke leaked old capabilities without affecting admitted calls', async () => {
  const s = await setup({ env: { PUBLIC_ROOMS: 'true' } }); const owner = await s.publicHost(); const guest = await s.publicGuest(owner);
  await s.send(guest, { type: 'burn-invite' }); assert.match(guest.take('error').message, /Only the host/);
  await s.send(owner, { type: 'burn-invite' }); assert.ok(owner.take('invite-disabled')); assert.ok(guest.take('invite-disabled'));
  assert.equal(s.engine.rooms.size, 1); assert.equal(s.engine.ready([...s.engine.rooms.values()][0]).length, 2);
  const outsider = await s.bootstrap('Outsider'); await s.send(outsider, { type: 'join', roomId: owner.room.roomId, roomKey: owner.room.roomKey });
  assert.match(outsider.take('error').message, /Invalid invitation/); assert.equal(outsider.take('welcome'), null);
  await s.send(owner, { type: 'rotate-invite' }); const updated = owner.take('invite-updated');
  assert.notEqual(updated.roomKey, owner.room.roomKey); assert.equal(guest.take('invite-updated'), null); assert.ok(guest.take('invite-status'));
  await s.send(outsider, { type: 'join', roomId: updated.roomId, roomKey: updated.roomKey }); assert.ok(outsider.take('welcome'));
  await s.send(owner, { type: 'block', peerId: guest.welcome.selfId }); assert.ok(guest.take('rejected')); assert.ok(owner.take('peer-blocked'));
  assert.ok(owner.take('invite-disabled')); assert.equal(guest.attachment.roomId, undefined);
  await s.send(owner, { type: 'rotate-invite' }); const next = owner.take('invite-updated');
  await s.send(guest, { type: 'join', roomId: next.roomId, roomKey: next.roomKey }); assert.match(guest.take('error').message, /blocked/);
  const fresh = await s.bootstrap('Fresh connection', 'b'.repeat(64));
  await s.send(fresh, { type: 'join', roomId: next.roomId, roomKey: updated.roomKey }); assert.match(fresh.take('error').message, /Invalid invitation/);
  // Anonymous people are not permanently identifiable. The host controls which new code is shared.
  await s.send(fresh, { type: 'join', roomId: next.roomId, roomKey: next.roomKey }); assert.ok(fresh.take('welcome'));
});

test('public auto-admission reserves slots and a concurrent invitation burn cancels delayed welcomes', async () => {
  const s = await setup({ env: { PUBLIC_ROOMS: 'true' } }); const owner = await s.publicHost();
  const guests = []; for (let i = 0; i < 4; i++) guests.push(await s.bootstrap(`Guest ${i}`));
  const resolvers = []; s.engine.ice = () => new Promise(resolve => resolvers.push(resolve));
  const admissions = guests.slice(0, 3).map(guest => s.send(guest, { type: 'join', roomId: owner.room.roomId, roomKey: owner.room.roomKey }));
  // Hashing yields. Let each reservation pass validation before testing the cap.
  while (resolvers.length < 3) await new Promise(resolve => setImmediate(resolve));
  await s.send(guests[3], { type: 'join', roomId: owner.room.roomId, roomKey: owner.room.roomKey }); assert.match(guests[3].take('error').message, /full/);
  await s.send(owner, { type: 'burn-invite' });
  for (const resolve of resolvers) resolve({ iceServers: [], relayEnabled: false, relaySecondsLimit: 0 }); await Promise.all(admissions);
  for (const guest of guests.slice(0, 3)) { assert.equal(guest.take('welcome'), null); assert.ok(guest.take('rejected')); }
  assert.equal(s.engine.ready([...s.engine.rooms.values()][0]).length, 1); assert.equal(owner.take('peer-joined'), null);
});

test('invite rotation during asynchronous validation cannot accept the old hashed room capability', async () => {
  const s = await setup({ env: { PUBLIC_ROOMS: 'true' } }); const owner = await s.publicHost(); const guest = await s.bootstrap('Guest');
  const joining = s.send(guest, { type: 'join', roomId: owner.room.roomId, roomKey: owner.room.roomKey });
  await s.send(owner, { type: 'rotate-invite' }); await joining;
  assert.equal(guest.take('welcome'), null); assert.equal(guest.attachment.roomId, undefined); assert.ok(guest.take('error'));
});

test('public lifetime, revocation and source budgets survive hibernation without private identity records', async () => {
  const s = await setup({ env: { PUBLIC_ROOMS: 'true' } }); const owner = await s.publicHost(); const guest = await s.publicGuest(owner);
  const { Coordinator } = await modulePromise;
  const resumed = new Coordinator({ store: s.store, env: { PAIRING_KEY, PUBLIC_ROOMS: 'true' }, now: s.now,
    restored: [owner, guest].map(ws => ({ transport: ws, attachment: structuredClone(ws.attachment) })) });
  assert.equal(resumed.ready([...resumed.rooms.values()][0]).length, 2); assert.equal(resumed.devices.size, 0);
  assert.equal(resumed.publicBudget.bootstrap, 2); assert.equal(resumed.publicBudget.create, 1);
  for (let i = 0; i < 180; i++) { s.advance(30000); resumed.touch(owner.id, s.now()); resumed.touch(guest.id, s.now()); resumed.reap(); }
  assert.equal(resumed.rooms.size, 1); assert.equal(resumed.sockets.size, 2); assert.equal(owner.closed, false);
  resumed.disconnect(owner.id);
  assert.equal(resumed.rooms.size, 0); assert.ok(guest.take('room-ended')); assert.equal(resumed.grants.size, 0);
});

test('an idle public room with healthy host heartbeats remains open until its owner leaves', async () => {
  const s = await setup({ env: { PUBLIC_ROOMS: 'true' } }); const owner = await s.publicHost();
  assert.equal(owner.room.expiresAt, 0);
  for (let i = 0; i < 240; i++) { s.advance(30000); await s.send(owner, { type: 'ping' }); s.engine.reap(); }
  assert.equal(s.engine.rooms.size, 1); assert.equal(owner.closed, false);
  await s.send(owner, { type: 'leave' }); assert.equal(s.engine.rooms.size, 0);
});

test('guest heartbeats cannot retain a room after the host connection is lost', async () => {
  const s = await setup({ env: { PUBLIC_ROOMS: 'true' } }); const owner = await s.publicHost(); const guest = await s.publicGuest(owner);
  for (let i = 0; i < 4; i++) { s.advance(30000); s.engine.touch(guest.id, s.now()); s.engine.reap(); }
  assert.equal(owner.closed.code, 1000); assert.match(owner.closed.reason, /timed out/);
  assert.equal(s.engine.rooms.size, 0); assert.ok(guest.take('room-ended'));
});

test('live public relay keys and charged media credits survive multi-hour hibernation without a timer reset', async () => {
  const env = { PAIRING_KEY, PUBLIC_ROOMS: 'true', WEBSOCKET_RELAY: 'true' };
  const s = await setup({ env }); const owner = await s.publicHost(); const guest = await s.publicGuest(owner);
  await s.send(guest, relaySignal(owner.welcome.selfId, 16)); assert.ok(owner.take('signal'));
  const reserved = structuredClone(s.store.mediaBudget); const { Coordinator } = await modulePromise;
  for (let i = 0; i < 240; i++) { s.advance(30000); s.engine.touch(owner.id, s.now()); s.engine.touch(guest.id, s.now()); s.engine.reap(); }
  const resumed = new Coordinator({ store: s.store, env, now: s.now, restored: [owner,guest].map(ws=>({transport:ws,attachment:structuredClone(ws.attachment)})) });
  const room = [...resumed.rooms.values()][0]; const config = await resumed.websocketMedia(room);
  assert.equal(config.websocketRelayEnabled, true); assert.equal(config.relayKey, owner.welcome.relayKey);
  assert.equal(config.websocketRelayLimits.roomSeconds, 0);
  assert.deepEqual(s.store.mediaBudget, reserved);
  await resumed.receive(guest.id, JSON.stringify(relaySignal(owner.welcome.selfId,16,2))); assert.ok(owner.take('signal'));
  resumed.disconnect(owner.id); assert.equal(resumed.rooms.size, 0); assert.ok(guest.take('room-ended'));
  assert.equal((await resumed.websocketMedia(room)).websocketRelayEnabled, false);
});

test('source bootstrap and room creation caps cannot be reset by socket replacement or hibernation', async () => {
  const s = await setup({ env: { PUBLIC_ROOMS: 'true' } });
  for (let i = 0; i < s.LIMITS.sourceBootstrapMinute; i++) { const peer = await s.bootstrap(`Guest ${i}`); s.engine.disconnect(peer.id); }
  const { Coordinator } = await modulePromise;
  const resumed = new Coordinator({ store: s.store, env: { PAIRING_KEY, PUBLIC_ROOMS: 'true' }, now: s.now });
  const refused = transport(); refused.id = resumed.attach(refused, 'a'.repeat(64));
  await resumed.receive(refused.id, JSON.stringify({ type: 'bootstrap', name: 'Too many' })); assert.ok(refused.closed); assert.equal(refused.take('registered'), null);
  s.advance(60000); const owner = await s.bootstrap('Owner');
  for (let i = 0; i < s.LIMITS.sourceCreateHour; i++) {
    await s.send(owner, { type: 'create-room' }); assert.ok(owner.take('room-created')); await s.send(owner, { type: 'leave' });
  }
  await s.send(owner, { type: 'create-room' }); assert.match(owner.take('error').message, /limit/); assert.equal(owner.take('room-created'), null);
});

test('source identifiers are keyed HMACs and public restore refuses lost or forged identity leases', async () => {
  const { sourceHash, Coordinator } = await modulePromise; const first = await sourceHash('203.0.113.1', PAIRING_KEY);
  assert.match(first, /^[a-f0-9]{64}$/); assert.notEqual(first, await sourceHash('203.0.113.1', 'another-private-pairing-key-abcdefghijklmnopqrstuvwxyz'));
  assert.notEqual(first, await sourceHash('203.0.113.2', PAIRING_KEY));
  const s = await setup({ env: { PUBLIC_ROOMS: 'true' } }); const owner = await s.publicHost(first);
  const persisted = JSON.stringify(s.store.publicBudget); assert.equal(persisted.includes('203.0.113'), false); assert.equal(persisted.includes(PAIRING_KEY), false);
  const altered = structuredClone(owner.attachment); altered.deviceId = 'forged-public';
  const resumed = new Coordinator({ store: s.store, env: { PAIRING_KEY, PUBLIC_ROOMS: 'true' }, now: s.now,
    restored: [{ transport: owner, attachment: altered }] });
  assert.ok(owner.closed); assert.equal(resumed.rooms.size, 0); assert.equal(resumed.sockets.size, 0);
});

test('unknown sockets get no private directory; incorrect pairing and token are rejected', async () => {
  const s = await setup(); const stranger = s.connect();
  await s.send(stranger, { type: 'pair', pairingKey: 'wrong-key-abcdefghijklmnopqrstuvwxyz', name: 'Stranger' });
  assert.ok(stranger.closed); assert.equal(stranger.take('presence'), null); assert.equal(s.store.devices.size, 0);
  const owner = await s.pair('Owner'); s.engine.disconnect(owner.id);
  const impostor = s.connect();
  await s.send(impostor, { type: 'register', deviceId: owner.credentials.deviceId,
    deviceToken: 'wrong-token-abcdefghijklmnopqrstuvwxyz', name: 'Owner' });
  assert.ok(impostor.closed); assert.equal(impostor.take('presence'), null);
});

test('device tokens are hash-only persisted, names cleaned, offline status retained', async () => {
  const s = await setup(); const owner = await s.pair('<Owner>\u202e\n computer'); const guest = await s.pair('Phone');
  assert.equal(s.store.devices.get(owner.credentials.deviceId).name, 'Owner computer');
  const persisted = JSON.stringify([...s.store.devices.values()]);
  assert.equal(persisted.includes(owner.credentials.deviceToken), false); assert.equal(persisted.includes(PAIRING_KEY), false);
  guest.messages = []; s.engine.disconnect(owner.id);
  const presence = guest.take('presence'); const offline = presence.devices.find(device => device.id === owner.credentials.deviceId);
  assert.equal(offline.online, false); assert.equal(offline.hosting, false);
  assert.equal(JSON.stringify(guest.attachment).includes(guest.credentials.deviceToken), false);
});

test('forget during a concurrent token hash cannot resurrect the forgotten registration', async () => {
  const s = await setup(); const owner = await s.pair('Owner'); const replacement = s.connect();
  const registration = s.send(replacement, { ...owner.credentials, type: 'register', name: 'Replacement' });
  await s.send(owner, { type: 'forget' }); await registration;
  assert.equal(s.store.devices.size, 0); assert.equal(s.engine.devices.size, 0);
  assert.equal(replacement.take('registered'), null); assert.ok(replacement.closed);
});

test('leave cancels create-room or invitation join already waiting on secret hashing', async () => {
  const s = await setup(); const owner = await s.pair('Owner');
  const creating = s.send(owner, { type: 'create-room' }); await s.send(owner, { type: 'leave' }); await creating;
  assert.equal(s.engine.rooms.size, 0); assert.equal(owner.take('room-created'), null);
  const host = await s.host(); const guest = await s.pair('Guest');
  const joining = s.send(guest, { type: 'join', roomId: host.room.roomId, roomKey: host.room.roomKey });
  await s.send(guest, { type: 'leave' }); await joining;
  assert.equal(guest.attachment.roomId, undefined); assert.equal(guest.take('pending'), null);
  assert.equal(host.take('join-request'), null);
});

test('control request survives healthy hibernation until its owner responds', async () => {
  const s = await setup(); const owner = await s.host(); const guest = await s.guest(owner, 'Guest');
  await s.send(guest, { type: 'control-request', to: owner.welcome.selfId }); const request = owner.take('control-request');
  s.advance(20000); const { Coordinator } = await modulePromise;
  const resumed = new Coordinator({ store: s.store, env: { PAIRING_KEY }, now: s.now,
    restored: [owner, guest].map(ws => ({ transport: ws, attachment: structuredClone(ws.attachment) })) });
  await resumed.receive(owner.id, JSON.stringify({ type: 'control-response', to: guest.welcome.selfId,
    requestId: request.requestId, accepted: true, sessionId: 'pending-request-after-hibernation' }));
  assert.equal(guest.take('control-response').accepted, true); assert.equal(resumed.grants.size, 1);
});

test('delayed ICE approval cannot admit or announce a guest who left and requested again', async () => {
  const s = await setup(); const owner = await s.host(); const guest = await s.guest(owner, 'Guest', false);
  let resolveIce;
  s.engine.ice = () => new Promise(resolve => { resolveIce = resolve; });
  const approving = s.send(owner, { type: 'approve', peerId: guest.pending.selfId });
  await s.send(guest, { type: 'leave' });
  await s.send(guest, { type: 'join-device', deviceId: owner.credentials.deviceId });
  const next = guest.take('pending'); owner.messages = []; guest.messages = [];
  resolveIce({ iceServers: [], relayEnabled: false, relaySecondsLimit: 0 }); await approving;
  assert.equal(guest.take('welcome'), null); assert.equal(owner.take('peer-joined'), null);
  assert.equal(owner.take('join-approved'), null);
  assert.equal(s.engine.peer(next.selfId).accepted, false);
});

test('concurrent approvals reserve capacity but expose peers only after each welcome is ready', async () => {
  const s = await setup(); const owner = await s.host();
  const guests = [];
  for (let i = 0; i < 4; i++) guests.push(await s.guest(owner, `Guest ${i}`, false));
  const resolvers = [];
  s.engine.ice = () => new Promise(resolve => resolvers.push(resolve));
  const approvals = guests.slice(0, 3).map(guest => s.send(owner, { type: 'approve', peerId: guest.pending.selfId }));
  const room = s.engine.rooms.get(owner.room.roomId);
  assert.equal(s.engine.accepted(room).length, 4); assert.equal(s.engine.ready(room).length, 1);
  await s.send(owner, { type: 'approve', peerId: guests[3].pending.selfId });
  assert.match(owner.take('error').message, /full/); assert.equal(s.engine.peer(guests[3].pending.selfId).accepted, false);
  await s.send(owner, { type: 'signal', to: guests[0].pending.selfId, data: { fixture: 'not-ready' } });
  assert.match(owner.take('error').message, /recipient/); assert.equal(guests[0].take('signal'), null);
  await s.send(owner, { type: 'control-request', to: guests[0].pending.selfId });
  assert.match(owner.take('error').message, /screen owner/); assert.equal(guests[0].take('control-request'), null);
  await s.send(guests[0], { type: 'signal', to: owner.welcome.selfId, data: { fixture: 'not-ready' } });
  assert.match(guests[0].take('error').message, /approval/); assert.equal(owner.take('signal'), null);

  const config = { iceServers: [], relayEnabled: false, relaySecondsLimit: 0 };
  resolvers[0](config); await approvals[0];
  const welcomeA = guests[0].take('welcome');
  assert.deepEqual(welcomeA.peers.map(peer => peer.id), [owner.welcome.selfId]);
  assert.equal(s.engine.ready(room).length, 2);
  assert.equal(guests[1].take('peer-joined'), null); assert.equal(guests[2].take('peer-joined'), null);
  await s.send(guests[0], { type: 'signal', to: guests[1].pending.selfId, data: { fixture: 'early-offer' } });
  assert.match(guests[0].take('error').message, /recipient/); assert.equal(guests[1].take('signal'), null);
  await s.send(guests[0], { type: 'grant-control', targetId: welcomeA.selfId, peerId: guests[1].pending.selfId, sessionId: 'ready-phase-fixture-session' });
  assert.match(guests[0].take('error').message, /controller/); assert.equal(s.engine.grants.size, 0);

  resolvers[1](config); await approvals[1];
  const welcomeB = guests[1].take('welcome');
  assert.deepEqual(new Set(welcomeB.peers.map(peer => peer.id)), new Set([owner.welcome.selfId, welcomeA.selfId]));
  assert.equal(guests[0].take('peer-joined').peer.id, welcomeB.selfId);
  assert.equal(guests[2].take('peer-joined'), null);
  await s.send(guests[0], { type: 'signal', to: welcomeB.selfId, data: { fixture: 'ready-offer' } });
  assert.equal(guests[1].take('signal').from, welcomeA.selfId);
  resolvers[2](config); await approvals[2];
  assert.equal(guests[2].take('welcome').peers.length, 3);
  assert.equal(s.engine.ready(room).length, 4);
  assert.equal(guests[3].take('peer-joined'), null);
});

test('hibernation restores ready admissions and fails closed for interrupted or legacy welcomes', async () => {
  const s = await setup(); const owner = await s.host(); const guest = await s.guest(owner, 'Ready guest');
  const interrupted = await s.guest(owner, 'Interrupted guest', false);
  s.engine.ice = () => new Promise(() => {});
  void s.send(owner, { type: 'approve', peerId: interrupted.pending.selfId });
  assert.equal(interrupted.attachment.accepted, true); assert.equal(interrupted.attachment.admissionReady, false);
  const { Coordinator } = await modulePromise;
  const resumed = new Coordinator({ store: s.store, env: { PAIRING_KEY }, now: s.now,
    restored: [owner, guest, interrupted].map(ws => ({ transport: ws, attachment: structuredClone(ws.attachment) })) });
  assert.equal(resumed.rooms.size, 1); assert.equal(resumed.ready([...resumed.rooms.values()][0]).length, 2);
  assert.ok(interrupted.take('rejected')); assert.equal(interrupted.attachment.roomId, undefined);
  assert.equal(interrupted.attachment.admissionReady, undefined);

  const legacyOwner = structuredClone(owner.attachment); delete legacyOwner.admissionReady;
  const legacy = new Coordinator({ store: s.store, env: { PAIRING_KEY }, now: s.now,
    restored: [{ transport: owner, attachment: legacyOwner }, { transport: guest, attachment: structuredClone(guest.attachment) }] });
  assert.equal(legacy.rooms.size, 0); assert.equal(guest.attachment.roomId, undefined); assert.ok(guest.take('room-ended'));
});

test('approval waiting on ICE retains the original deadline and cannot publish an expired welcome', async () => {
  const s = await setup(); const owner = await s.host(); const guest = await s.guest(owner, 'Guest', false);
  let resolveIce;
  s.engine.ice = () => new Promise(resolve => { resolveIce = resolve; });
  const approving = s.send(owner, { type: 'approve', peerId: guest.pending.selfId });
  assert.equal(guest.attachment.admissionDeadline, s.now() + s.LIMITS.admissionMs);
  s.advance(s.LIMITS.admissionMs);
  resolveIce({ iceServers: [], relayEnabled: false, relaySecondsLimit: 0 }); await approving;
  assert.equal(guest.take('welcome'), null); assert.ok(guest.take('rejected'));
  assert.equal(guest.attachment.roomId, undefined); assert.equal(owner.take('peer-joined'), null);
  assert.equal(owner.take('join-approved'), null); assert.equal(s.engine.ready([...s.engine.rooms.values()][0]).length, 1);
});

test('relay config survives hibernation without exhausting a one-fetch daily allowance', async () => {
  let calls = 0;
  const env = { PAIRING_KEY, RELAY_ENABLED: 'true', METERED_APP_DOMAIN: 'private.metered.live',
    METERED_API_KEY: 'secret-provider-key', METERED_CREDENTIAL_EXPIRES_AT: '2026-10-07T15:00:00Z', RELAY_DAILY_ISSUANCE_LIMIT: '1' };
  const fetcher = async () => { calls++; return new Response(JSON.stringify([
    { urls: 'turn:global.relay.metered.ca:443?transport=tcp', username: 'temporary-user', credential: 'temporary-password' }])); };
  const s = await setup({ env, fetcher }); const owner = await s.host(); const guest = await s.pair('Guest');
  s.advance(20000); const { Coordinator } = await modulePromise;
  const resumed = new Coordinator({ store: s.store, env, fetcher, now: s.now,
    restored: [owner, guest].map(ws => ({ transport: ws, attachment: structuredClone(ws.attachment) })) });
  await resumed.receive(guest.id, JSON.stringify({ type: 'join-device', deviceId: owner.credentials.deviceId }));
  const pending = guest.take('pending');
  await resumed.receive(owner.id, JSON.stringify({ type: 'approve', peerId: pending.selfId }));
  assert.equal(guest.take('welcome').relayEnabled, true); assert.equal(calls, 1); assert.equal(s.store.budget.daily, 1);
  assert.equal(JSON.stringify([...s.store.rooms.values()]).includes('temporary-password'), false);
  assert.equal(JSON.stringify([...s.store.rooms.values()]).includes('secret-provider-key'), false);
});

test('replayed or expired pending control attachments cannot cross device, socket, room or time bindings', async () => {
  const { Coordinator } = await modulePromise;
  for (const mutation of ['controllerConnectionId', 'targetDeviceId', 'roomId', 'expired']) {
    const s = await setup(); const owner = await s.host(); const guest = await s.guest(owner, 'Guest');
    await s.send(guest, { type: 'control-request', to: owner.welcome.selfId }); const request = owner.take('control-request');
    const altered = structuredClone(owner.attachment);
    if (mutation === 'expired') s.advance(60000);
    else altered.controlRequests[0][mutation] = crypto.randomUUID();
    const resumed = new Coordinator({ store: s.store, env: { PAIRING_KEY }, now: s.now,
      restored: [{ transport: owner, attachment: altered }, { transport: guest, attachment: structuredClone(guest.attachment) }] });
    await resumed.receive(owner.id, JSON.stringify({ type: 'control-response', to: guest.welcome.selfId,
      requestId: request.requestId, accepted: true, sessionId: 'invalid-pending-control-session' }));
    assert.equal(resumed.grants.size, 0, mutation); assert.match(owner.take('error').message, /not found|expired/i, mutation);
    assert.equal(owner.attachment.controlRequests, undefined, mutation);
  }
});

test('provider rotation, expired cache, wrong encryption key or tampering cannot reuse stored ICE', async () => {
  const { Coordinator } = await modulePromise;
  for (const mutation of ['api-key', 'domain', 'expiry', 'pairing-key', 'cipher', 'room-copy']) {
    let calls = 0;
    const env = { PAIRING_KEY, RELAY_ENABLED: 'true', METERED_APP_DOMAIN: 'private.metered.live',
      METERED_API_KEY: 'secret-provider-key', METERED_CREDENTIAL_EXPIRES_AT: '2026-10-07T15:00:00Z', RELAY_DAILY_ISSUANCE_LIMIT: '1' };
    const fetcher = async () => { calls++; return new Response(JSON.stringify([
      { urls: 'turn:global.relay.metered.ca:443', username: 'temporary-user', credential: 'temporary-password' }])); };
    const s = await setup({ env, fetcher }); const owner = await s.host(); const guest = await s.pair('Guest');
    const changed = { ...env };
    if (mutation === 'api-key') changed.METERED_API_KEY = 'rotated-provider-api-key';
    if (mutation === 'domain') changed.METERED_APP_DOMAIN = 'rotated.metered.live';
    if (mutation === 'expiry') changed.METERED_CREDENTIAL_EXPIRES_AT = '2026-10-07T13:59:00Z';
    if (mutation === 'pairing-key') changed.PAIRING_KEY = 'rotated-pairing-key-abcdefghijklmnopqrstuvwxyz';
    const persisted = s.store.rooms.get(owner.room.roomId);
    if (mutation === 'cipher') persisted.iceCache.cipher = persisted.iceCache.cipher.slice(0, -2) + 'AA';
    if (mutation === 'room-copy') {
      // AES-GCM authenticates the actual room ID, not just a provider fingerprint.
      persisted.id = crypto.randomUUID();
      s.store.rooms.clear(); s.store.rooms.set(persisted.id, persisted);
      owner.attachment.roomId = persisted.id;
    }
    const resumed = new Coordinator({ store: s.store, env: changed, fetcher, now: s.now,
      restored: [owner, guest].map(ws => ({ transport: ws, attachment: structuredClone(ws.attachment) })) });
    await resumed.receive(guest.id, JSON.stringify({ type: 'join-device', deviceId: owner.credentials.deviceId }));
    const pending = guest.take('pending'); assert.ok(pending, mutation);
    await resumed.receive(owner.id, JSON.stringify({ type: 'approve', peerId: pending.selfId }));
    assert.equal(guest.take('welcome').relayEnabled, false, mutation); assert.equal(calls, 1, mutation);
  }
});

test('room relay deadline applies before handling a message even when its alarm is late', async () => {
  const s = await setup({ env: { RELAY_ENABLED: 'true', METERED_APP_DOMAIN: 'private.metered.live',
    METERED_API_KEY: 'secret-provider-key', METERED_CREDENTIAL_EXPIRES_AT: '2026-10-07T15:00:00Z', RELAY_SESSION_SECONDS: '60' },
    fetcher: async () => new Response(JSON.stringify([{ urls: 'turn:global.relay.metered.ca:443', username: 'temp', credential: 'pass' }])) });
  const owner = await s.host(); const guest = await s.guest(owner, 'Guest');
  s.advance(60000); owner.messages = [];
  await s.send(guest, { type: 'signal', to: owner.welcome.selfId, data: { afterDeadline: true } });
  assert.equal(owner.take('signal'), null); assert.ok(owner.take('room-ended'));
  assert.match(guest.take('error').message, /approval/); assert.equal(s.engine.rooms.size, 0);
});

test('idle connection cannot revive itself after its lease already expired', async () => {
  const s = await setup(); const owner = await s.pair('Owner');
  s.advance(s.LIMITS.idleMs);
  await s.send(owner, { type: 'create-room' });
  assert.ok(owner.closed); assert.equal(owner.take('room-created'), null); assert.equal(s.engine.rooms.size, 0);
});

test('automatic heartbeat activity never extends an unauthenticated connection deadline', async () => {
  const s = await setup(); const stranger = s.connect();
  s.advance(s.LIMITS.authMs); s.engine.touch(stranger.id, s.now()); s.engine.reap();
  assert.ok(stranger.closed); assert.equal(s.engine.sockets.size, 0); assert.equal(s.store.devices.size, 0);
});

test('hibernation cannot reset message-rate counters to bypass the bounded signaling rate', async () => {
  const s = await setup(); const owner = await s.pair('Owner');
  for (let i = 0; i < 100; i++) await s.send(owner, { type: 'ping' });
  const { Coordinator } = await modulePromise;
  const resumed = new Coordinator({ store: s.store, env: { PAIRING_KEY }, now: s.now,
    restored: [{ transport: owner, attachment: structuredClone(owner.attachment) }] });
  for (let i = 0; i < 51; i++) await resumed.receive(owner.id, '{"type":"ping"}');
  assert.ok(owner.closed); assert.equal(resumed.sockets.size, 0);
});

test('control-request expiration is enforced at the exact deadline before owner response', async () => {
  const s = await setup(); const owner = await s.host(); const guest = await s.guest(owner, 'Guest');
  await s.send(guest, { type: 'control-request', to: owner.welcome.selfId }); const request = owner.take('control-request');
  assert.equal(s.engine.nextDeadline(), s.now() + s.LIMITS.admissionMs);
  s.advance(s.LIMITS.admissionMs);
  await s.send(owner, { type: 'control-response', to: guest.welcome.selfId, requestId: request.requestId,
    accepted: true, sessionId: 'late-control-response-session' });
  assert.equal(s.engine.grants.size, 0); assert.match(owner.take('error').message, /not found|expired/);
  assert.equal(owner.attachment.controlRequests, undefined);
});

test('overlapping authentication on one socket cannot switch identities or create orphan devices', async () => {
  const s = await setup(); const socket = s.connect();
  await Promise.all([s.send(socket, { type: 'pair', pairingKey: PAIRING_KEY, name: 'One' }),
    s.send(socket, { type: 'pair', pairingKey: PAIRING_KEY, name: 'Two' })]);
  assert.ok(socket.closed); assert.equal(socket.take('paired'), null); assert.equal(s.store.devices.size, 0);
});

test('copied host capability cannot let another paired device impersonate room owner', async () => {
  const s = await setup(); const owner = await s.pair('Owner'); await s.send(owner, { type: 'create-room' });
  const room = owner.take('room-created'); const thief = await s.pair('Thief');
  await s.send(thief, { ...room, type: 'join', from: owner.credentials.deviceId });
  assert.match(thief.take('error').message, /authenticated room owner/); assert.equal(thief.take('welcome'), null);
  await s.send(owner, { ...room, type: 'join' }); assert.ok(owner.take('welcome'));
  assert.equal(JSON.stringify([...s.store.rooms.values()]).includes(room.roomKey), false);
  assert.equal(JSON.stringify([...s.store.rooms.values()]).includes(room.hostToken), false);
});

test('host approval gates signaling and independent owner approval gates control', async () => {
  const s = await setup(); const owner = await s.host(); const guest = await s.guest(owner, 'Phone', false);
  await s.send(guest, { type: 'signal', to: owner.welcome.selfId, data: { sdp: 'not-yet' } });
  assert.match(guest.take('error').message, /Host approval/); assert.equal(owner.take('signal'), null);
  await s.send(guest, { type: 'approve', peerId: guest.pending.selfId }); assert.match(guest.take('error').message, /Host approval/);
  await s.send(owner, { type: 'approve', peerId: guest.pending.selfId }); guest.welcome = guest.take('welcome');
  assert.equal(guest.welcome.relayEnabled, false); assert.deepEqual(guest.welcome.iceServers, [{ urls: 'stun:stun.cloudflare.com:3478' }]);
  await s.send(guest, { type: 'signal', to: owner.welcome.selfId, from: 'forged', data: { candidate: 'test' } });
  assert.equal(owner.take('signal').from, guest.welcome.selfId);
  await s.send(guest, { type: 'grant-control', targetId: owner.welcome.selfId, peerId: owner.welcome.selfId, sessionId: 'a'.repeat(32) });
  assert.match(guest.take('error').message, /Only the screen owner/); assert.equal(s.engine.grants.size, 0);
  await s.send(guest, { type: 'control-request', to: owner.welcome.selfId }); const request = owner.take('control-request');
  await s.send(owner, { type: 'control-response', to: guest.welcome.selfId, requestId: 'wrong', accepted: true, sessionId: 'b'.repeat(32) });
  assert.match(owner.take('error').message, /not found or expired/); assert.equal(s.engine.grants.size, 0);
  await s.send(owner, { type: 'control-response', to: guest.welcome.selfId, requestId: request.requestId, accepted: true, sessionId: 'b'.repeat(32) });
  assert.equal(guest.take('control-response').accepted, true); assert.ok(owner.take('control-granted'));
  await s.send(owner, { type: 'control-revoke', to: guest.welcome.selfId });
  assert.equal(guest.take('control-revoke').sessionId, 'b'.repeat(32)); assert.equal(s.engine.grants.size, 0);
});

test('four-person capacity includes owner and cannot be raised by forged role', async () => {
  const s = await setup(); const owner = await s.host();
  await s.guest(owner, 'Guest 1'); await s.guest(owner, 'Guest 2'); await s.guest(owner, 'Guest 3');
  const fifth = await s.pair('Guest 4'); await s.send(fifth, { type: 'join-device', deviceId: owner.credentials.deviceId, role: 'host' });
  assert.match(fifth.take('error').message, /full/); assert.equal(fifth.take('pending'), null);
});

test('host disconnect ends rooms and grants but directory connections survive', async () => {
  const s = await setup(); const owner = await s.host(); const guest = await s.guest(owner, 'Guest');
  await s.send(owner, { type: 'grant-control', targetId: owner.welcome.selfId, peerId: guest.welcome.selfId, sessionId: 'x'.repeat(32) });
  s.engine.disconnect(owner.id);
  assert.equal(s.engine.rooms.size, 0); assert.equal(s.engine.grants.size, 0); assert.ok(guest.take('control-revoke'));
  assert.ok(guest.take('room-ended')); assert.equal(guest.closed, false); assert.equal(guest.attachment.roomId, undefined);
  await s.send(guest, { type: 'signal', to: owner.welcome.selfId, data: {} }); assert.match(guest.take('error').message, /Host approval/);
  assert.equal(guest.messages.filter(message => message.type === 'presence').at(-1).devices.find(device => device.id === owner.credentials.deviceId).online, false);
});

test('leave invalidates room grant; stale requests cannot cross into a new room', async () => {
  const s = await setup(); const owner = await s.host(); const guest = await s.guest(owner, 'Guest');
  await s.send(guest, { type: 'control-request', to: owner.welcome.selfId }); const old = owner.take('control-request');
  await s.send(guest, { type: 'leave' }); assert.ok(guest.take('room-left')); assert.equal(s.engine.requests.size, 0);
  await s.send(guest, { type: 'join-device', deviceId: owner.credentials.deviceId }); const pending = guest.take('pending');
  await s.send(owner, { type: 'approve', peerId: pending.selfId }); const welcome = guest.take('welcome');
  await s.send(owner, { type: 'control-response', to: welcome.selfId, requestId: old.requestId, accepted: true, sessionId: 'q'.repeat(32) });
  assert.match(owner.take('error').message, /not found or expired/); assert.equal(s.engine.grants.size, 0);
});

test('hibernation preserves verified control lease bound to the same authenticated room sockets', async () => {
  const s = await setup(); const owner = await s.host(); const guest = await s.guest(owner, 'Guest');
  await s.send(owner, { type: 'grant-control', targetId: owner.welcome.selfId, peerId: guest.welcome.selfId, sessionId: 'h'.repeat(32) });
  owner.messages = []; guest.messages = [];
  const { Coordinator } = await modulePromise;
  const resumed = new Coordinator({ store: s.store, env: { PAIRING_KEY }, now: s.now,
    restored: [owner, guest].map(ws => ({ transport: ws, attachment: structuredClone(ws.attachment) })) });
  assert.equal(resumed.accepted([...resumed.rooms.values()][0]).length, 2); assert.equal(resumed.grants.size, 1);
  assert.equal(guest.take('control-revoke'), null); assert.equal(owner.take('control-revoked'), null);
  assert.equal(owner.attachment.grant.sessionId, 'h'.repeat(32));
  await resumed.receive(guest.id, JSON.stringify({ type: 'signal', to: owner.welcome.selfId, data: { resumed: true } }));
  assert.equal(owner.take('signal').from, guest.welcome.selfId);
});

test('expired control lease revokes on reconstruction and cannot silently extend', async () => {
  const s = await setup(); const owner = await s.host(); const guest = await s.guest(owner, 'Guest');
  await s.send(owner, { type: 'grant-control', targetId: owner.welcome.selfId, peerId: guest.welcome.selfId, sessionId: 'e'.repeat(32) });
  const expiry = owner.attachment.grant.expiresAt; assert.equal(expiry - s.now(), s.LIMITS.controlMs);
  assert.equal(s.engine.nextDeadline() <= expiry, true);
  s.advance(s.LIMITS.controlMs); owner.messages = []; guest.messages = [];
  const { Coordinator } = await modulePromise;
  const resumed = new Coordinator({ store: s.store, env: { PAIRING_KEY }, now: s.now,
    restored: [owner, guest].map(ws => ({ transport: ws, attachment: structuredClone(ws.attachment) })) });
  assert.equal(resumed.grants.size, 0); assert.equal(guest.take('control-revoke').sessionId, 'e'.repeat(32));
  assert.ok(owner.take('control-revoked')); assert.equal(owner.attachment.grant, undefined);
});

test('replayed control attachment is refused for replaced socket, device or room binding', async () => {
  const { Coordinator } = await modulePromise;
  for (const mutation of ['connectionId', 'deviceId', 'roomId']) {
    const s = await setup(); const owner = await s.host(); const guest = await s.guest(owner, 'Guest');
    await s.send(owner, { type: 'grant-control', targetId: owner.welcome.selfId, peerId: guest.welcome.selfId, sessionId: 'r'.repeat(32) });
    const replacement = structuredClone(guest.attachment);
    replacement[mutation] = mutation === 'deviceId' ? owner.credentials.deviceId : crypto.randomUUID();
    owner.messages = []; guest.messages = [];
    const resumed = new Coordinator({ store: s.store, env: { PAIRING_KEY }, now: s.now,
      restored: [{ transport: owner, attachment: structuredClone(owner.attachment) }, { transport: guest, attachment: replacement }] });
    assert.equal(resumed.grants.size, 0, mutation); assert.ok(owner.take('control-revoked'), mutation);
    assert.equal(owner.attachment.grant, undefined, mutation);
  }
});

test('control lease alarm revokes despite healthy heartbeats and does not end the call', async () => {
  const s = await setup(); const owner = await s.host(); const guest = await s.guest(owner, 'Guest');
  await s.send(owner, { type: 'grant-control', targetId: owner.welcome.selfId, peerId: guest.welcome.selfId, sessionId: 't'.repeat(32) });
  for (let i = 0; i < 30; i++) {
    s.advance(30000); s.engine.touch(owner.id, s.now()); s.engine.touch(guest.id, s.now()); s.engine.reap();
  }
  assert.equal(s.engine.grants.size, 0); assert.equal(s.engine.rooms.size, 1);
  assert.equal(guest.take('control-revoke').sessionId, 't'.repeat(32)); assert.ok(owner.take('control-revoked'));
  assert.equal(guest.take('room-ended'), null);
});

test('reconstruction with missing host fails closed and clears guest admission', async () => {
  const s = await setup(); const owner = await s.host(); const guest = await s.guest(owner, 'Guest');
  guest.messages = []; const { Coordinator } = await modulePromise;
  const resumed = new Coordinator({ store: s.store, env: { PAIRING_KEY }, now: s.now,
    restored: [{ transport: guest, attachment: structuredClone(guest.attachment) }] });
  assert.equal(resumed.rooms.size, 0); assert.ok(guest.take('room-ended')); assert.equal(guest.attachment.roomId, undefined);
});

test('unauthenticated sockets and expired requests are bounded and reaped', async () => {
  const s = await setup(); const strangers = Array.from({ length: 9 }, s.connect);
  assert.ok(strangers[8].closed); assert.equal(s.engine.sockets.size, 8);
  s.advance(s.LIMITS.authMs); s.engine.reap(); assert.equal(s.engine.sockets.size, 0);
  const owner = await s.host(); const guest = await s.guest(owner, 'Guest', false);
  s.advance(s.LIMITS.admissionMs); s.engine.reap(); assert.ok(guest.take('rejected'));
  assert.equal(guest.attachment.roomId, undefined); assert.ok(owner.take('join-cancelled'));
});

test('forget removes own device, invalidates old token, and restores directory capacity', async () => {
  const s = await setup(); const owner = await s.pair('Owner');
  await s.send(owner, { type: 'forget' }); assert.ok(owner.take('forgotten')); assert.equal(s.store.devices.size, 0);
  const old = s.connect(); await s.send(old, { ...owner.credentials, type: 'register', name: 'Owner' });
  assert.ok(old.closed); assert.equal(old.take('registered'), null);
});

test('device capacity cannot exceed 32 even with simultaneous pairing requests', async () => {
  const s = await setup();
  for (let i = 0; i < 31; i++) { const ws = await s.pair(`Device ${i}`); s.engine.disconnect(ws.id); }
  const a = s.connect(), b = s.connect();
  await Promise.all([s.send(a, { type: 'pair', pairingKey: PAIRING_KEY, name: 'A' }), s.send(b, { type: 'pair', pairingKey: PAIRING_KEY, name: 'B' })]);
  assert.equal(s.store.devices.size, 32); assert.equal(Boolean(a.take('paired')) !== Boolean(b.take('paired')), true);
});

test('relay defaults off and provider errors never disclose credentials or make a paid fallback', async () => {
  let calls = 0;
  const s = await setup({ fetcher: async () => { calls++; throw new Error('sensitive-key'); } });
  const owner = await s.host(); assert.equal(calls, 0); assert.equal(owner.welcome.relayEnabled, false);
  const configured = await setup({ env: { RELAY_ENABLED: 'true', METERED_APP_DOMAIN: 'private.metered.live',
    METERED_API_KEY: 'secret-provider-key', METERED_CREDENTIAL_EXPIRES_AT: '2026-10-07T15:00:00Z' },
    fetcher: async () => { throw new Error('secret-provider-key'); } });
  const host = await configured.host(); assert.equal(host.welcome.relayEnabled, false);
  assert.equal(JSON.stringify(host.messages).includes('secret-provider-key'), false);
});

test('relay allowance, provider expiry and session cutoff persist across service restarts', async () => {
  let calls = 0;
  const s = await setup({ env: { RELAY_ENABLED: 'true', METERED_APP_DOMAIN: 'private.metered.live',
    METERED_API_KEY: 'secret-provider-key', METERED_CREDENTIAL_EXPIRES_AT: '2026-10-07T15:00:00Z', RELAY_DAILY_ISSUANCE_LIMIT: '1', RELAY_SESSION_SECONDS: '60' },
    fetcher: async address => { calls++; assert.equal(new URL(address).hostname, 'private.metered.live');
      return new Response(JSON.stringify([{ urls: 'turn:global.relay.metered.ca:443?transport=tcp', username: 'temporary-user', credential: 'temporary-password' }])); } });
  const owner = await s.host(); const guest = await s.guest(owner, 'Guest');
  assert.equal(owner.welcome.relayEnabled, true); assert.equal(guest.welcome.relayEnabled, true); assert.equal(calls, 1);
  assert.equal(s.store.budget.daily, 1); assert.equal(s.store.budget.monthly, 1);
  assert.equal(JSON.stringify([...s.store.rooms.values()]).includes('temporary-password'), false);
  s.advance(60000); s.engine.reap(); assert.ok(guest.take('room-ended')); assert.equal(s.engine.rooms.size, 0);
  await s.send(owner, { type: 'create-room' }); const room = owner.take('room-created'); await s.send(owner, { ...room, type: 'join' });
  const next = owner.take('welcome'); assert.equal(next.relayEnabled, false); assert.match(next.relayReason, /exhausted/); assert.equal(calls, 1);
});

test('oversized/binary messages fail closed and excessive signal rates are bounded', async () => {
  const s = await setup(); const binary = s.connect(); await s.engine.receive(binary.id, new Uint8Array(2)); assert.ok(binary.closed);
  const tooLarge = s.connect(); await s.engine.receive(tooLarge.id, 'a'.repeat(65537)); assert.equal(tooLarge.closed.code, 1009);
  const flood = await s.pair('Flood');
  for (let i = 0; i < 151; i++) await s.send(flood, { type: 'ping' }); assert.ok(flood.closed);
});
