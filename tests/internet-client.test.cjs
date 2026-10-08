'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const moduleReady = import(`data:text/javascript;base64,${fs.readFileSync(path.join(__dirname, '../src/renderer/internet.js')).toString('base64')}`);
const tick = () => new Promise(resolve => setImmediate(resolve));
function storage() { const values = new Map(); return { getItem: key => values.get(key) || null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key), values }; }
class Socket extends EventTarget {
  constructor(url, server) { super(); this.url = url; this.server = server; this.readyState = 0; this.sent = []; queueMicrotask(() => { this.readyState = 1; this.dispatchEvent(new Event('open')); }); }
  send(value) { const packet = JSON.parse(value); this.sent.push(packet); this.server?.(this, packet); }
  receive(packet) { const event = new Event('message'); event.data = JSON.stringify(packet); this.dispatchEvent(event); }
  close() { if (this.readyState === 3) return; this.readyState = 3; this.dispatchEvent(new Event('close')); }
}
const origin = 'https://private-qa.workers.dev';
const token = 'qa-device-token-which-is-long-enough';
function pairedServer(socket, packet) {
  if (packet.type === 'pair') socket.receive({ type: 'paired', deviceId: 'device-a', deviceToken: token });
  if (['pair', 'register'].includes(packet.type)) socket.receive({ type: 'registered', deviceId: 'device-a' });
  if (packet.type === 'ping') socket.receive({ type: 'pong' });
  if (packet.type === 'leave') socket.receive({ type: 'room-left' });
  if (packet.type === 'forget') socket.receive({ type: 'forgotten', deviceId: 'device-a' });
}

test('service addresses require a clean HTTPS origin; invitations carry room keys, never device credentials', async () => {
  const { internetOrigin, internetInvitation } = await moduleReady;
  assert.equal(internetOrigin(origin + '/'), origin);
  for (const value of ['http://example.com', 'https://name:secret@example.com', origin + '/path', origin + '/?key=secret', origin + '/#token']) assert.throws(() => internetOrigin(value));
  const invitation = internetInvitation(`${origin}/#internet=1&room=room-a&key=secret-key`);
  assert.equal(invitation.roomId, 'room-a'); assert.equal(invitation.roomKey, 'secret-key'); assert.equal(invitation.internet, true);
  assert.equal(internetInvitation('https://192.168.1.4/#key=nearby&fp=fingerprint'), null);
  assert.throws(() => internetInvitation(`${origin}/#internet=1&key=missing-room`));
  assert.throws(() => internetInvitation(`${origin}/#internet=1&room=room-a&key=one&key=two`));
  assert.throws(() => internetInvitation(`${origin}/#internet=1&room=room-a&key=one&deviceToken=secret`));
  assert.throws(() => internetOrigin(origin + '\n'));
});

test('pairing happens only after verified transport; only device credential is saved per service', async () => {
  const { InternetDirectory } = await moduleReady; const saved = storage(); const sockets = []; const sequence = [];
  const directory = new InternetDirectory({ storage: saved, trust: async value => { sequence.push(`trust:${value}`); }, socketFactory: url => { sequence.push('socket'); const socket = new Socket(url, pairedServer); sockets.push(socket); return socket; } });
  try {
    await directory.open(origin, { pairingKey: 'private-qa-code', name: 'My phone' });
    assert.deepEqual(sequence, [`trust:${origin}`, 'socket']);
    assert.equal(sockets[0].url, 'wss://private-qa.workers.dev/internet/ws');
    assert.equal(new URL(sockets[0].url).search, '', 'No credential may be placed in a socket URL');
    assert.equal(directory.status, 'online');
    const raw = [...saved.values.values()].join(''); assert.ok(!raw.includes('private-qa-code')); assert.equal(directory.identity(origin).deviceToken, token);
    directory.close(); await directory.open(origin, { name: 'Restored phone' });
    assert.equal(sockets[1].sent[0].type, 'register'); assert.ok(!('pairingKey' in sockets[1].sent[0]));
  } finally { directory.close(); }
});

test('reconnection restores private presence only and never silently rejoins a room', async () => {
  const { InternetDirectory } = await moduleReady; const saved = storage(); const sockets = [];
  const directory = new InternetDirectory({ storage: saved, reconnectDelays: [0], socketFactory: url => { const socket = new Socket(url, pairedServer); sockets.push(socket); return socket; } });
  let disconnects = 0; directory.addEventListener('disconnected', () => disconnects++);
  try {
    await directory.open(origin, { pairingKey: 'private-qa-code' });
    sockets[0].receive({ type: 'presence', devices: [{ id: 'device-b', name: 'My Mac', online: true, hosting: true, roomId: 'room-a' }] });
    directory.joinDevice('device-b'); sockets[0].close();
    assert.equal(disconnects, 1); assert.equal(directory.devices[0].online, false);
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(sockets.length, 2); assert.equal(directory.status, 'online');
    assert.deepEqual(sockets[1].sent.map(packet => packet.type), ['register']);
  } finally { directory.close(); }
});

test('reconnection is bounded and auth rejection preserves credentials without retrying automatically', async () => {
  const { InternetDirectory } = await moduleReady; const saved = storage(); const sockets = [];
  const directory = new InternetDirectory({ storage: saved, reconnectDelays: [0], socketFactory: url => { const socket = new Socket(url, (socket, packet) => { if (sockets.length === 1) pairedServer(socket, packet); else socket.receive({ type: 'error', message: 'Device is no longer paired.' }); }); sockets.push(socket); return socket; } });
  await directory.open(origin, { pairingKey: 'private-qa-code' }); sockets[0].close();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(sockets.length, 2); assert.equal(directory.status, 'offline');
  await assert.rejects(directory.forget(), /Go online/); assert.ok(directory.identity(origin), 'Authentication failure must not silently delete the saved credential');
  directory.close();
});

test('ordinary leave keeps directory socket online, while explicit forgetting revokes own record', async () => {
  const { InternetDirectory } = await moduleReady; let socket;
  const directory = new InternetDirectory({ storage: storage(), socketFactory: url => socket = new Socket(url, pairedServer) });
  await directory.open(origin, { pairingKey: 'private-qa-code' });
  await directory.leaveRoom(); assert.equal(directory.status, 'online'); assert.equal(socket.readyState, 1); assert.equal(socket.sent.at(-1).type, 'leave');
  await directory.forget(); assert.equal(socket.sent.at(-1).type, 'forget'); assert.equal(socket.readyState, 3); assert.equal(directory.status, 'offline');
});

test('forget waits for matching server confirmation, retaining the credential until acknowledged', async () => {
  const { InternetDirectory } = await moduleReady; let socket;
  const directory = new InternetDirectory({ storage: storage(), socketFactory: url => socket = new Socket(url, (socket, packet) => { if (packet.type !== 'forget') pairedServer(socket, packet); }) });
  try {
    await directory.open(origin, { pairingKey: 'private-qa-code' });
    const removing = directory.forget(); assert.equal(directory.forget(), removing); assert.ok(directory.identity(origin)); assert.equal(socket.readyState, 1);
    assert.throws(() => directory.joinDevice('device-b'), /removal/); await assert.rejects(directory.createRoom('Another room'), /removal/);
    socket.receive({ type: 'forgotten', deviceId: 'other-device' }); assert.ok(directory.identity(origin)); assert.ok(directory.forgetWaiter);
    socket.receive({ type: 'forgotten', deviceId: 'device-a' }); await removing;
    assert.equal(directory.identity(origin), null); assert.equal(directory.status, 'offline'); assert.equal(socket.readyState, 3); assert.equal(directory.deviceId, null);
  } finally { directory.close(); }
});

test('offline forget and missing removal acknowledgment preserve the device credential for retry', async () => {
  const { InternetDirectory } = await moduleReady; let socket;
  const directory = new InternetDirectory({ timeout: 10, storage: storage(), socketFactory: url => socket = new Socket(url, (socket, packet) => { if (packet.type !== 'forget') pairedServer(socket, packet); }) });
  try {
    await directory.open(origin, { pairingKey: 'private-qa-code' }); directory.close();
    await assert.rejects(directory.forget(), /Go online/); assert.ok(directory.identity(origin));
    await directory.open(origin); await assert.rejects(directory.forget(), /did not confirm/); assert.ok(directory.identity(origin)); assert.equal(directory.status, 'offline');
    socket.receive({ type: 'forgotten', deviceId: 'device-a' }); assert.ok(directory.identity(origin), 'Late packets after the timed out socket is retired cannot erase credentials');
    await directory.open(origin); const removing = directory.forget(); const rejected = assert.rejects(removing, /credential is still saved/); socket.receive({ type: 'error', message: 'Removal unavailable' }); await rejected; assert.ok(directory.identity(origin)); assert.equal(directory.status, 'online');
  } finally { directory.close(); }
});

test('room creation failures resolve cleanly without polluting device identities', async () => {
  const { InternetDirectory } = await moduleReady; let socket;
  const directory = new InternetDirectory({ storage: storage(), socketFactory: url => socket = new Socket(url, pairedServer) });
  try {
    await directory.open(origin, { pairingKey: 'private-qa-code' });
    let waiting = directory.createRoom('My room'); socket.receive({ type: 'error', message: 'Room limit reached.' }); await assert.rejects(waiting, /Room limit/);
    waiting = directory.createRoom('My room'); socket.receive({ type: 'room-created', roomId: 'r1', roomKey: 'private-room-key', hostToken: 'private-owner-token', name: 'My room' });
    const room = await waiting; assert.equal(room.invite, `${origin}/#internet=1&room=r1&key=private-room-key`); assert.ok(!room.invite.includes('owner-token'));
    directory.joinRoom(room, true); assert.equal(socket.sent.at(-1).hostToken, 'private-owner-token');
  } finally { directory.close(); }
  await tick();
});

test('missed pong stops the live session before a silent close handshake finishes and reconnects presence only', async () => {
  const { InternetDirectory } = await moduleReady; const sockets = []; let stoppedMedia = 0; let revokedControl = 0;
  const directory = new InternetDirectory({ storage: storage(), heartbeatInterval: 5, pongTimeout: 15, reconnectDelays: [0], socketFactory: url => {
    const index = sockets.length;
    const socket = new Socket(url, (socket, packet) => { if (index === 0 && packet.type === 'ping') return; pairedServer(socket, packet); });
    if (index === 0) socket.close = () => { socket.readyState = 2; socket.closeRequested = true; }; // No close event: silent network.
    sockets.push(socket); return socket;
  } });
  const disconnected = new Promise(resolve => directory.addEventListener('disconnected', () => { stoppedMedia++; revokedControl++; resolve(); }, { once: true }));
  try {
    await directory.open(origin, { pairingKey: 'private-qa-code' });
    sockets[0].receive({ type: 'presence', devices: [{ id: 'device-b', name: 'Peer', online: true, hosting: true, roomId: 'room-1' }] });
    directory.joinDevice('device-b');
    await disconnected;
    assert.equal(stoppedMedia, 1); assert.equal(revokedControl, 1); assert.equal(directory.devices[0].online, false);
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(sockets[0].closeRequested, true); assert.equal(sockets[0].readyState, 2, 'Disconnect must not wait for native/TCP close event');
    assert.equal(directory.status, 'online'); assert.equal(sockets.length, 2);
    assert.ok(sockets[1].sent.some(packet => packet.type === 'register'));
    assert.ok(!sockets[1].sent.some(packet => ['join', 'join-device', 'create-room', 'control-response'].includes(packet.type)), 'A heartbeat failure must not resume room or control');
    sockets[0].receive({ type: 'welcome', selfId: 'stale-room', peers: [] });
    assert.equal(directory.status, 'online', 'Late packets from the retired socket cannot replace the current connection');
  } finally { directory.close(); }
});

test('healthy pongs clear their deadline and closing clears both heartbeat timers', async () => {
  const { InternetDirectory } = await moduleReady; const sockets = []; let disconnects = 0;
  const directory = new InternetDirectory({ storage: storage(), heartbeatInterval: 5, pongTimeout: 15, socketFactory: url => { const socket = new Socket(url, pairedServer); sockets.push(socket); return socket; } });
  directory.addEventListener('disconnected', () => disconnects++);
  try {
    await directory.open(origin, { pairingKey: 'private-qa-code' });
    const deadline = performance.now() + 1000;
    const pings = () => sockets[0].sent.filter(packet => packet.type === 'ping').length;
    // Parallel media fixtures can delay timer dispatch. Wait for the behavior
    // being checked instead of requiring two intervals within a fixed sleep.
    while (pings() < 2 && performance.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok(pings() >= 2, 'The healthy connection must send at least two heartbeats within the bounded wait');
    assert.equal(directory.status, 'online'); assert.equal(disconnects, 0);
    assert.notEqual(directory.heartbeatTimer, null); assert.equal(directory.pongTimer, null);
  } finally { directory.close(); }
  const sentBefore = sockets[0].sent.length;
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(directory.heartbeatTimer, null); assert.equal(directory.pongTimer, null); assert.equal(sockets[0].sent.length, sentBefore); assert.equal(sockets.length, 1);
});

test('a changed display name reconnects the private directory before a future room request', async () => {
  const { InternetDirectory } = await moduleReady; const sockets = [];
  const directory = new InternetDirectory({ storage: storage(), socketFactory: url => { const socket = new Socket(url, pairedServer); sockets.push(socket); return socket; } });
  try {
    await directory.open(origin, { pairingKey: 'private-qa-code', name: 'Original name' });
    await directory.open(origin, { name: 'Updated name' });
    assert.equal(sockets.length, 2); assert.equal(sockets[0].readyState, 3); assert.equal(sockets[1].sent[0].type, 'register'); assert.equal(sockets[1].sent[0].name, 'Updated name');
    assert.equal(directory.status, 'online'); assert.ok(!sockets[1].sent.some(packet => packet.type === 'join'));
  } finally { directory.close(); }
});

test('a delayed room-left acknowledgment blocks the next admission and cannot end a later room', async () => {
  const { InternetDirectory } = await moduleReady; let socket; const delivered = [];
  const directory = new InternetDirectory({ storage: storage(), socketFactory: url => socket = new Socket(url, (socket, packet) => { if (packet.type !== 'leave') pairedServer(socket, packet); }) });
  directory.addEventListener('message', ({ detail }) => delivered.push(detail));
  try {
    await directory.open(origin, { pairingKey: 'private-qa-code' });
    const leaving = directory.leaveRoom(); assert.equal(directory.leaveRoom(), leaving, 'Repeated leave shares the same acknowledgment');
    assert.throws(() => directory.joinDevice('device-b'), /previous room/);
    await assert.rejects(directory.createRoom('New room'), /previous room/);
    socket.receive({ type: 'room-left' }); await leaving;
    directory.joinDevice('device-b'); socket.receive({ type: 'room-left' });
    assert.equal(directory.status, 'online'); assert.ok(!delivered.some(message => message.type === 'room-left'), 'Old leave acknowledgments never reach a new room');
  } finally { directory.close(); }
});

test('silent authentication timeout retires a socket without waiting for its close event', async () => {
  const { InternetDirectory } = await moduleReady; let socket;
  const directory = new InternetDirectory({ timeout: 10, reconnectDelays: [], storage: storage(), socketFactory: url => { socket = new Socket(url, () => {}); socket.close = () => { socket.readyState = 2; }; return socket; } });
  await assert.rejects(directory.open(origin, { pairingKey: 'private-qa-code' }), /did not answer/);
  assert.equal(directory.status, 'offline'); assert.equal(directory.socket, null); assert.equal(socket.readyState, 2); directory.close();
});

test('leaving cancels pending creation and a late old result cannot resolve a replacement request', async () => {
  const { InternetDirectory } = await moduleReady; let socket;
  const directory = new InternetDirectory({ storage: storage(), socketFactory: url => socket = new Socket(url, pairedServer) });
  try {
    await directory.open(origin, { pairingKey: 'private-qa-code' });
    const first = directory.createRoom('Cancelled room'); const cancelled = assert.rejects(first, /cancelled/);
    await directory.leaveRoom(); await cancelled; assert.equal(directory.roomWaiter, null);
    socket.receive({ type: 'room-created', roomId: 'obsolete', roomKey: 'old-key', hostToken: 'old-token' });
    const second = directory.createRoom('Replacement room');
    socket.receive({ type: 'room-created', roomId: 'current', roomKey: 'current-key', hostToken: 'current-token' });
    assert.equal((await second).roomId, 'current'); assert.equal(directory.status, 'online');
  } finally { directory.close(); }
});

test('blocked browser storage does not prevent starting nearby mode or explicit first-time pairing', async () => {
  const { InternetDirectory } = await moduleReady; const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw new DOMException('Storage blocked', 'SecurityError'); } });
  let directory;
  try {
    directory = new InternetDirectory({ socketFactory: url => new Socket(url, pairedServer) });
    assert.equal(directory.status, 'offline'); assert.equal(directory.identity(origin), null);
    await directory.open(origin, { pairingKey: 'private-qa-code' }); assert.equal(directory.status, 'online'); assert.equal(directory.identity(origin), null);
  } finally { directory?.close(); if (previous) Object.defineProperty(globalThis, 'localStorage', previous); else delete globalThis.localStorage; }
});

test('public bootstrap never sends or overwrites a saved private identity, and reconnect never resumes a room', async () => {
  const { InternetDirectory } = await moduleReady; const saved = storage(); const sockets = []; const sequence = [];
  const savedPrivate = JSON.stringify({ deviceId: 'device-a', deviceToken: token }); saved.setItem(`auralink.internet.identity:${origin}`, savedPrivate);
  const directory = new InternetDirectory({ storage: saved, reconnectDelays: [0], trust: async address => sequence.push(`trust:${address}`), socketFactory: url => {
    sequence.push('socket'); const socket = new Socket(url, (socket, packet) => {
      if (packet.type === 'bootstrap') socket.receive({ type: 'registered', deviceId: `public-${sockets.length}`, mode: 'public' });
      if (packet.type === 'ping') socket.receive({ type: 'pong' });
    }); sockets.push(socket); return socket;
  } });
  try {
    await directory.openPublic(origin, { name: 'Anonymous phone' });
    assert.deepEqual(sequence, [`trust:${origin}`, 'socket']); assert.equal(directory.mode, 'public');
    assert.deepEqual(sockets[0].sent, [{ type: 'bootstrap', name: 'Anonymous phone' }]);
    sockets[0].receive({ type: 'paired', deviceId: 'attack', deviceToken: 'attack-credential-1234567890' });
    sockets[0].receive({ type: 'presence', devices: [{ id: 'not-public', name: 'Private identity', online: true }] });
    assert.equal(saved.getItem(`auralink.internet.identity:${origin}`), savedPrivate); assert.deepEqual(directory.devices, []);
    directory.joinRoom({ roomId: 'room-a', roomKey: 'private-room-capability' }); sockets[0].close(); await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(directory.status, 'online'); assert.equal(directory.deviceId, 'public-2');
    assert.deepEqual(sockets[1].sent, [{ type: 'bootstrap', name: 'Anonymous phone' }]);
    await directory.forget(); assert.equal(directory.status, 'offline'); assert.equal(directory.deviceId, null);
    assert.equal(saved.getItem(`auralink.internet.identity:${origin}`), savedPrivate);
    assert.ok(!sockets.flatMap(socket => socket.sent).some(packet => ['pair', 'register', 'forget'].includes(packet.type)));
  } finally { directory.close(); }
});

test('invitation codes contain the complete strong capability and reject truncation or ambiguous fields', async () => {
  const { DEFAULT_PUBLIC_ORIGIN, roomInvitation, roomCode } = await moduleReady;
  const roomId = '89bf3734-2920-41c1-bbce-439085f9037e'; const roomKey = 'A'.repeat(43); const code = `A1.${roomId}.${roomKey}`;
  const parsed = roomInvitation(code); assert.equal(parsed.url, DEFAULT_PUBLIC_ORIGIN); assert.equal(parsed.roomKey, roomKey); assert.equal(parsed.roomId, roomId); assert.equal(parsed.public, true);
  assert.equal(roomCode({ ...parsed, access: 'invite' }), code);
  assert.equal(roomCode({ ...parsed, url: origin, access: 'invite' }), '', 'Custom origins use a link so the service is never guessed incorrectly');
  for (const invalid of [code.slice(0, -1), code + '.extra', 'A1.123456.123456', code.replace(roomId, 'not-a-room'), code.replace(roomKey, '*'.repeat(43))]) assert.throws(() => roomInvitation(invalid));
  assert.throws(() => roomInvitation(`${DEFAULT_PUBLIC_ORIGIN}/#internet=1&room=${roomId}&key=${roomKey}&key=${roomKey}`));
  assert.deepEqual(roomInvitation(`auralink://join#code=${code}`), parsed);
  for (const invalid of [`auralink://join/#code=${code}`, `auralink://join:443#code=${code}`, `auralink://user@join#code=${code}`, `auralink://join?x=1#code=${code}`, `auralink://join#code=${code}&code=${code}`, `auralink://join#code=${code.replace('A1.', 'A1%2e')}`, `auralink://join#code=${code}\n`, code.slice(0, -1) + 'B']) assert.throws(() => roomInvitation(invalid));
});
