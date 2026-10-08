import test from 'node:test';
import assert from 'node:assert/strict';
import { createLocalCoordinator } from './local-runtime.mjs';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';

function client(socket) {
  socket.accept();
  const messages = [], waits = [], history = [];
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data); history.push(message);
    const at = waits.findIndex(wait => wait.type === message.type);
    if (at >= 0) { const waiter = waits.splice(at, 1)[0]; clearTimeout(waiter.timer); waiter.resolve(message); }
    else messages.push(message);
  });
  return { socket, history, send: message => socket.send(JSON.stringify(message)),
    next(type) {
      const at = messages.findIndex(message => message.type === type);
      if (at >= 0) return Promise.resolve(messages.splice(at, 1)[0]);
      return new Promise((resolve, reject) => {
        const waiter = { type, resolve, timer: setTimeout(() => { waits.splice(waits.indexOf(waiter), 1); reject(new Error(`Timed out waiting for ${type}`)); }, 10000) };
        waits.push(waiter);
      });
    } };
}

test('real Workers runtime: bounded encrypted media forwarding, encrypted keys and SQLite quota survive healthy hibernation', { timeout: 60000 }, async () => {
  const persist = await mkdtemp(join(tmpdir(), 'auralink-media-runtime-'));
  const runtime = await createLocalCoordinator({ persist, bindings: { PUBLIC_ROOMS: 'true', WEBSOCKET_RELAY: 'true' } });
  const sockets = []; let roomKey, ciphertext, expectedBytes = 0, reservedBytes = 0, reservedMessages = 0, creditBytes = 0, creditMessages = 0, limits;
  const accountPacket = bytes => {
    if (creditBytes < bytes) { reservedBytes += limits.reservationBytes - creditBytes; creditBytes = limits.reservationBytes; }
    if (creditMessages < 1) { reservedMessages += limits.reservationMessages - creditMessages; creditMessages = limits.reservationMessages; }
    creditBytes -= bytes; creditMessages--; expectedBytes += bytes;
  };
  try {
    const landing = await runtime.mf.dispatchFetch(`${runtime.url}/`); assert.equal(landing.status, 200);
    assert.match(landing.headers.get('Content-Security-Policy'), /default-src 'none'/); assert.equal(landing.headers.get('Referrer-Policy'), 'no-referrer');
    const html = await landing.text(); assert.match(html, /auralink:\/\/join#code=/); assert.match(html, /releases\/latest/); assert.equal(html.includes('https://cdn'), false);
    const connect = async name => {
      const response = await runtime.mf.dispatchFetch(`${runtime.url}/internet/ws`, { headers: { Upgrade: 'websocket', 'CF-Connecting-IP': '198.51.100.20' } });
      assert.equal(response.status, 101); const ws = client(response.webSocket); sockets.push(ws.socket);
      ws.send({ type: 'bootstrap', name }); assert.equal((await ws.next('registered')).mode, 'public'); return ws;
    };
    const host = await connect('Media owner'); host.send({ type: 'create-room' }); const room = await host.next('room-created');
    host.send({ ...room, type: 'join' }); const owner = await host.next('welcome');
    assert.equal(owner.websocketRelayEnabled, true); assert.equal(owner.relayEnabled, false); roomKey = owner.relayKey; limits = owner.websocketRelayLimits;
    const guest = await connect('Media guest'); guest.send({ type: 'join', roomId: room.roomId, roomKey: room.roomKey }); const admitted = await guest.next('welcome');
    assert.equal(admitted.relayKey, roomKey); await host.next('peer-joined');
    ciphertext = Buffer.alloc(180000, 82).toString('base64url');
    const media = counter => ({ type: 'signal', to: owner.selfId, data: { relay: { version: 1, epoch: 'a'.repeat(16), nonce: 'b'.repeat(16), counter, ciphertext } } });
    const wireBytes = Buffer.byteLength(JSON.stringify(media(1)));
    const allowed = Math.floor(owner.websocketRelayLimits.senderBytesPer5s / wireBytes);
    for (let i = 1; i <= allowed; i++) {
      const message = media(i); guest.send(message); const forwarded = await host.next('signal');
      assert.equal(forwarded.from, admitted.selfId); assert.deepEqual(forwarded.data, message.data);
      assert.deepEqual(Object.keys(forwarded).sort(), ['data', 'from', 'type']); accountPacket(Buffer.byteLength(JSON.stringify(message)));
    }
    guest.send(media(allowed + 1)); const denied = await guest.next('error'); assert.equal(denied.code, 'websocket-relay-limit'); assert.match(denied.message, /too fast/);
    await new Promise(resolve => setTimeout(resolve, 25000));
    const next = await connect('After hibernation'); next.send({ type: 'join', roomId: room.roomId, roomKey: room.roomKey });
    assert.equal((await next.next('welcome')).relayKey, roomKey); await host.next('peer-joined');
    const final = media(allowed + 2); guest.send(final); assert.equal((await host.next('signal')).from, admitted.selfId); accountPacket(Buffer.byteLength(JSON.stringify(final)));
    host.send({ type: 'block', peerId: admitted.selfId }); await guest.next('rejected'); await host.next('peer-blocked');
    guest.send(media(allowed + 3)); assert.match((await guest.next('error')).message, /approval/);
    host.socket.close(1000, 'Finished'); await next.next('room-ended');
  } finally { for (const socket of sockets) try { socket.close(); } catch {} await runtime.close(); }
  try {
    const files = await readdir(persist, { recursive: true }); const databases = files.filter(file => file.endsWith('.sqlite'));
    assert.ok(databases.length > 0); let record;
    for (const file of databases) {
      const db = new DatabaseSync(join(persist, file), { readOnly: true });
      try {
        if (!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='media_budget'").get()) continue;
        record = JSON.parse(db.prepare('SELECT record FROM media_budget WHERE id=1').get().record);
        const rows = db.prepare('SELECT record FROM rooms').all(); assert.equal(rows.length, 0);
        const stored = JSON.stringify(record); assert.equal(stored.includes(ciphertext), false); assert.equal(stored.includes(roomKey), false);
      } finally { db.close(); }
    }
    assert.ok(record); assert.equal(record.bytes, reservedBytes); assert.equal(record.messages, reservedMessages);
    assert.ok(record.bytes >= expectedBytes); assert.ok(record.bytes - expectedBytes <= limits.reservationBytes);
  } finally { await rm(persist, { recursive: true, force: true }); }
});

test('real Workers runtime: authenticated approval, owner control, revoke and private presence', { timeout: 60000 }, async () => {
  const runtime = await createLocalCoordinator();
  const sockets = [];
  try {
    const health = await runtime.mf.dispatchFetch(`${runtime.url}/internet/health`);
    assert.equal(health.status, 200); assert.deepEqual(await health.json(), { service: 'auralink-internet', protocol: 1, status: 'ok' });
    assert.equal((await runtime.mf.dispatchFetch(`${runtime.url}/internet/health?token=hidden`)).status, 400);
    assert.equal((await runtime.mf.dispatchFetch(`${runtime.url}/internet/ws`)).status, 426);
    const connect = async name => {
      const response = await runtime.mf.dispatchFetch(`${runtime.url}/internet/ws`, { headers: { Upgrade: 'websocket' } });
      assert.equal(response.status, 101); const ws = client(response.webSocket); sockets.push(ws.socket);
      ws.send({ type: 'pair', pairingKey: runtime.pairingKey, name });
      ws.credentials = await ws.next('paired'); await ws.next('registered'); await ws.next('presence'); return ws;
    };
    const host = await connect('Owner'); const guest = await connect('Phone');
    guest.send({ type: 'ping' }); assert.equal((await guest.next('pong')).type, 'pong');
    host.send({ type: 'create-room', name: 'Runtime test' }); const room = await host.next('room-created');
    host.send({ ...room, type: 'join' }); const ownerWelcome = await host.next('welcome');
    assert.equal(ownerWelcome.relayEnabled, false); assert.equal(ownerWelcome.iceServers[0].urls, 'stun:stun.cloudflare.com:3478');
    guest.send({ type: 'join-device', deviceId: host.credentials.deviceId });
    const pending = await guest.next('pending'); const join = await host.next('join-request'); assert.equal(join.peerId, pending.selfId);
    guest.send({ type: 'signal', to: ownerWelcome.selfId, data: { sdp: 'unapproved' } });
    assert.match((await guest.next('error')).message, /approval/);
    host.send({ type: 'approve', peerId: pending.selfId }); const guestWelcome = await guest.next('welcome'); await host.next('peer-joined');
    guest.send({ type: 'signal', from: 'spoofed', to: ownerWelcome.selfId, data: { candidate: 'test' } });
    assert.equal((await host.next('signal')).from, guestWelcome.selfId);
    guest.send({ type: 'control-request', to: ownerWelcome.selfId }); const request = await host.next('control-request');
    // Native consent can take longer than the hibernation interval. Keep the same request.
    await new Promise(resolve => setTimeout(resolve, 25000));
    host.send({ type: 'control-response', to: guestWelcome.selfId, requestId: request.requestId, accepted: true, sessionId: 'runtime-consent-session-0123456789' });
    assert.equal((await guest.next('control-response')).accepted, true); await host.next('control-granted');
    // The initial auth alarm can wake at10s. Wait beyond a subsequent hibernation interval.
    // A consent lease must survive healthy runtime reconstruction, without a new grant.
    await new Promise(resolve => setTimeout(resolve, 15000));
    host.send({ type: 'control-revoke', to: guestWelcome.selfId });
    assert.equal((await guest.next('control-revoke')).sessionId, 'runtime-consent-session-0123456789'); await host.next('control-revoked');
    host.socket.close(1000, 'test owner disconnect');
    assert.match((await guest.next('room-ended')).reason, /host/);
    // Several presence broadcasts can be queued. Read until the host is offline.
    let seenOffline = false;
    for (let i = 0; i < 8 && !seenOffline; i++) {
      const presence = await guest.next('presence');
      seenOffline = presence.devices.some(device => device.id === host.credentials.deviceId && !device.online && !device.hosting);
    }
    assert.equal(seenOffline, true);
    guest.send({ type: 'forget' }); assert.equal((await guest.next('forgotten')).deviceId, guest.credentials.deviceId);
  } finally { for (const socket of sockets) try { socket.close(); } catch {} await runtime.close(); }
});

test('real Workers runtime: concurrent guests receive welcome before fast signaling or peer announcements', { timeout: 60000 }, async () => {
  const runtime = await createLocalCoordinator(); const sockets = [];
  try {
    const connect = async name => {
      const response = await runtime.mf.dispatchFetch(`${runtime.url}/internet/ws`, { headers: { Upgrade: 'websocket' } });
      assert.equal(response.status, 101); const ws = client(response.webSocket); sockets.push(ws.socket);
      ws.send({ type: 'pair', pairingKey: runtime.pairingKey, name });
      ws.credentials = await ws.next('paired'); await ws.next('registered'); return ws;
    };
    const host = await connect('Owner');
    host.send({ type: 'create-room' }); const room = await host.next('room-created');
    host.send({ ...room, type: 'join' }); const owner = await host.next('welcome');
    host.socket.addEventListener('message', event => {
      const message = JSON.parse(event.data);
      if (message.type === 'signal') host.send({ type: 'signal', to: message.from, data: { fixture: 'fast-reply' } });
    });
    const guests = [];
    for (let i = 0; i < 3; i++) {
      const guest = await connect(`Guest ${i}`); guests.push(guest);
      guest.send({ type: 'join-device', deviceId: host.credentials.deviceId });
      guest.pending = await guest.next('pending'); await host.next('join-request');
      guest.socket.addEventListener('message', event => {
        const message = JSON.parse(event.data);
        if (message.type === 'welcome') guest.send({ type: 'signal', to: owner.selfId, data: { fixture: 'fast-offer' } });
      });
    }
    for (const guest of guests) host.send({ type: 'approve', peerId: guest.pending.selfId });
    await Promise.all(guests.map(guest => guest.next('welcome')));
    for (let i = 0; i < 3; i++) await host.next('peer-joined');
    await Promise.all(guests.map(guest => guest.next('signal')));
    for (const guest of guests) {
      const roomEvents = guest.history.filter(message => ['welcome', 'peer-joined', 'signal'].includes(message.type));
      assert.equal(roomEvents[0].type, 'welcome'); assert.equal(roomEvents.at(-1).type === 'signal' || roomEvents.some(message => message.type === 'signal'), true);
      const announcement = host.history.findIndex(message => message.type === 'peer-joined' && message.peer.id === guest.pending.selfId);
      const offer = host.history.findIndex(message => message.type === 'signal' && message.from === guest.pending.selfId);
      assert.ok(announcement >= 0 && offer > announcement);
    }
  } finally { for (const socket of sockets) try { socket.close(); } catch {} await runtime.close(); }
});

test('real Workers runtime: missing pairing configuration refuses sockets', { timeout: 60000 }, async () => {
  const runtime = await createLocalCoordinator({ bindings: { PAIRING_KEY: '' } });
  try {
    assert.equal((await runtime.mf.dispatchFetch(`${runtime.url}/internet/ws`, { headers: { Upgrade: 'websocket' } })).status, 503);
    assert.equal((await runtime.mf.dispatchFetch(`${runtime.url}/internet/health`)).status, 200);
  } finally { await runtime.close(); }
});

test('real Workers runtime: public invitation auto-entry, private isolation and host moderation', { timeout: 60000 }, async () => {
  const runtime = await createLocalCoordinator({ bindings: { PUBLIC_ROOMS: 'true' } }); const sockets = [];
  try {
    const connect = async (name, privateMode = false) => {
      const response = await runtime.mf.dispatchFetch(`${runtime.url}/internet/ws`, { headers: { Upgrade: 'websocket', 'CF-Connecting-IP': '203.0.113.10' } });
      assert.equal(response.status, 101); const ws = client(response.webSocket); sockets.push(ws.socket);
      ws.send(privateMode ? { type: 'pair', pairingKey: runtime.pairingKey, name } : { type: 'bootstrap', name });
      ws.registered = await ws.next('registered');
      if (privateMode) await ws.next('paired'); else assert.equal(ws.registered.mode, 'public');
      return ws;
    };
    const privatePeer = await connect('Private directory owner', true); await privatePeer.next('presence');
    const host = await connect('Public owner'); const guest = await connect('Public guest');
    host.send({ type: 'create-room', name: 'Public invitation runtime' }); const room = await host.next('room-created');
    assert.equal(room.access, 'invite'); assert.match(room.roomKey, /^[A-Za-z0-9_-]{43}$/);
    host.send({ ...room, type: 'join' }); const owner = await host.next('welcome');
    guest.send({ type: 'join', roomId: room.roomId, roomKey: room.roomKey }); const admitted = await guest.next('welcome');
    assert.equal(admitted.room.access, 'invite'); assert.equal((await host.next('peer-joined')).peer.id, admitted.selfId);
    assert.equal(guest.history.some(message => ['presence', 'pending', 'paired'].includes(message.type)), false);
    assert.equal(host.history.some(message => ['presence', 'join-request', 'paired'].includes(message.type)), false);
    guest.send({ type: 'control-request', to: owner.selfId }); const request = await host.next('control-request');
    // Ephemeral authentication and the independent owner request must survive
    // actual workerd hibernation without creating private directory records.
    await new Promise(resolve => setTimeout(resolve, 25000));
    host.send({ type: 'control-response', to: admitted.selfId, requestId: request.requestId, accepted: true, sessionId: 'public-separate-consent-012345' });
    assert.equal((await guest.next('control-response')).accepted, true); await host.next('control-granted');
    host.send({ type: 'block', peerId: admitted.selfId });
    await guest.next('rejected'); await host.next('peer-blocked'); await host.next('invite-disabled'); await host.next('control-revoked');
    guest.send({ type: 'join', roomId: room.roomId, roomKey: room.roomKey }); assert.match((await guest.next('error')).message, /Invalid invitation/);
    host.send({ type: 'rotate-invite' }); const updated = await host.next('invite-updated'); assert.notEqual(updated.roomKey, room.roomKey);
    guest.send({ type: 'join', roomId: room.roomId, roomKey: updated.roomKey }); assert.match((await guest.next('error')).message, /blocked/);
    const next = await connect('New public guest'); next.send({ type: 'join', roomId: updated.roomId, roomKey: updated.roomKey });
    assert.equal((await next.next('welcome')).room.id, room.roomId);
    host.socket.close(1000, 'Owner finished'); assert.match((await next.next('room-ended')).reason, /host/);
    assert.equal(privatePeer.history.filter(message => message.type === 'presence').at(-1).devices.length, 1);
  } finally { for (const socket of sockets) try { socket.close(); } catch {} await runtime.close(); }
});

test('real Workers runtime: encrypted relay cache reuses one provider fetch after healthy idle', { timeout: 60000 }, async () => {
  let providerCalls = 0;
  const runtime = await createLocalCoordinator({ bindings: { RELAY_ENABLED: 'true', METERED_APP_DOMAIN: 'fixture.metered.live',
    METERED_API_KEY: 'fixture-provider-api-key', METERED_CREDENTIAL_EXPIRES_AT: new Date(Date.now() + 3600000).toISOString(),
    RELAY_DAILY_ISSUANCE_LIMIT: '1' }, outbound: async request => {
      const url = new URL(request.url); assert.equal(url.hostname, 'fixture.metered.live'); assert.equal(url.pathname, '/api/v1/turn/credentials');
      providerCalls++;
      return new Response(JSON.stringify([{ urls: 'turn:global.relay.metered.ca:443', username: 'fixture-user', credential: 'fixture-password' }]));
    } });
  const sockets = [];
  try {
    const connect = async name => {
      const response = await runtime.mf.dispatchFetch(`${runtime.url}/internet/ws`, { headers: { Upgrade: 'websocket' } });
      const ws = client(response.webSocket); sockets.push(ws.socket);
      ws.send({ type: 'pair', pairingKey: runtime.pairingKey, name });
      ws.credentials = await ws.next('paired'); await ws.next('registered'); return ws;
    };
    const host = await connect('Owner'); const guest = await connect('Guest');
    host.send({ type: 'create-room' }); const room = await host.next('room-created');
    host.send({ ...room, type: 'join' }); const welcome = await host.next('welcome');
    assert.equal(welcome.relayEnabled, true, JSON.stringify({ providerCalls, reason: welcome.relayReason })); assert.equal(providerCalls, 1);
    await new Promise(resolve => setTimeout(resolve, 25000));
    guest.send({ type: 'join-device', deviceId: host.credentials.deviceId }); const pending = await guest.next('pending');
    await host.next('join-request'); host.send({ type: 'approve', peerId: pending.selfId });
    const admitted = await guest.next('welcome');
    assert.equal(admitted.relayEnabled, true); assert.equal(providerCalls, 1);
    assert.equal(admitted.iceServers[0].credential, 'fixture-password');
  } finally { for (const socket of sockets) try { socket.close(); } catch {} await runtime.close(); }
});
