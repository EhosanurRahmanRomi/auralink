import test from 'node:test';
import assert from 'node:assert/strict';
import { createLocalCoordinator } from './local-runtime.mjs';

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
