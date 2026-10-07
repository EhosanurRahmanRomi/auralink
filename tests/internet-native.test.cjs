'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { internetOrigin, probeInternetService, InternetMembership, NativeInternetClient } = require('../src/core/internet-client.cjs');

test('Internet service uses standard HTTPS with a credential-free fixed socket path', () => {
  assert.equal(internetOrigin('https://auralink.example/'), 'https://auralink.example');
  for (const url of ['http://host/', 'https://name:secret@host/', 'https://host/other', 'https://host/?token=secret', 'https://host/#secret', 'https://host/\n', 'https://host/a/..', 'https://host/?', 'https://host/#', 'https://host\\']) assert.throws(() => internetOrigin(url));
});

test('directory pairing and presence cannot authorize native control', () => {
  const membership = new InternetMembership();
  membership.observe({ type: 'registered', deviceId: 'paired-device' });
  membership.observe({ type: 'presence', devices: [{ id: 'remote-device', online: true }] });
  membership.observe({ type: 'control-granted', peerId: 'remote-device', targetId: 'paired-device', sessionId: 'valid-session-123456' });
  assert.equal(membership.isAcceptedPeer('remote-device'), false);
  assert.equal(membership.isGrantConfirmed('remote-device', 'valid-session-123456'), false);
});

test('native input requires an admitted participant and exact server-confirmed owner grant', () => {
  const revocations = []; const membership = new InternetMembership(value => revocations.push(value));
  membership.observe({ type: 'welcome', selfId: 'owner', room: { id: 'room' }, peers: [{ id: 'guest' }] });
  assert.equal(membership.isAcceptedPeer('guest'), true);
  assert.equal(membership.isGrantConfirmed('guest', 'session-123456789'), false);
  membership.observe({ type: 'control-granted', targetId: 'other-owner', peerId: 'guest', sessionId: 'session-123456789' });
  assert.equal(membership.isGrantConfirmed('guest', 'session-123456789'), false);
  membership.observe({ type: 'control-granted', targetId: 'owner', peerId: 'intruder', sessionId: 'session-123456789' });
  assert.equal(membership.isGrantConfirmed('intruder', 'session-123456789'), false);
  membership.observe({ type: 'control-granted', targetId: 'owner', peerId: 'guest', sessionId: 'session-123456789' });
  assert.equal(membership.isGrantConfirmed('guest', 'session-123456789'), true);
  assert.equal(membership.isGrantConfirmed('guest', 'stale-session-12345'), false);
  membership.observe({ type: 'peer-left', peerId: 'guest' });
  assert.equal(membership.isGrantConfirmed('guest', 'session-123456789'), false);
  assert.equal(revocations.at(-1).kind, 'control');
});

test('room leave and server interruption clear authorization before asynchronous cleanup', () => {
  let callbackState; const membership = new InternetMembership(() => { callbackState = membership.isAcceptedPeer('guest'); });
  membership.observe({ type: 'welcome', selfId: 'owner', room: { id: 'room' }, peers: [{ id: 'guest' }] });
  membership.observe({ type: 'room-left' });
  assert.equal(callbackState, false); assert.equal(membership.roomId, null);
  membership.observe({ type: 'welcome', selfId: 'owner', room: { id: 'other-room' }, peers: [{ id: 'different-guest' }] });
  assert.equal(membership.isAcceptedPeer('guest'), false);
  membership.clear('Service lost'); assert.equal(membership.isAcceptedPeer('different-guest'), false);
});

test('native transport validates TLS by default and never exposes identity in URLs', () => {
  class Socket extends EventEmitter {
    constructor(url, options) { super(); this.url = url; this.options = options; this.readyState = 1; }
    send(data) { this.sent = data; } close() { this.emit('close', 1000, 'Closed'); } terminate() {}
  }
  const events = []; const client = new NativeInternetClient('https://service.example', 'internet-1', message => events.push(message), () => {}, { Socket });
  assert.equal(client.ws.url, 'wss://service.example/internet/ws');
  assert.equal(client.ws.options.rejectUnauthorized, true);
  assert.equal(client.ws.options.perMessageDeflate, false);
  client.send(JSON.stringify({ type: 'join', roomId: 'room', roomKey: 'fixture' }));
  client.ws.emit('message', Buffer.from(JSON.stringify({ type: 'welcome', selfId: 'owner', room: { id: 'room' }, peers: [{ id: 'guest' }] })), false);
  assert.equal(client.membership.isAcceptedPeer('guest'), true);
  client.send(JSON.stringify({ type: 'leave' }));
  assert.equal(client.membership.isAcceptedPeer('guest'), false);
  assert.throws(() => client.send('secret=not-json'));
  client.close(); assert.equal(events.at(-1).type, 'close');
});

test('HTTP success must identify the supported Auralink health protocol', async () => {
  const transport = body => ({ get(url, options, callback) {
    assert.equal(options.rejectUnauthorized, true);
    const request = new EventEmitter(); request.destroy = () => {};
    queueMicrotask(() => {
      const response = new EventEmitter(); response.statusCode = 200;
      callback(response); response.emit('data', Buffer.from(body)); response.emit('end');
    });
    return request;
  } });
  await assert.rejects(probeInternetService('https://service.example', transport('<html>Other website</html>')));
  await assert.rejects(probeInternetService('https://service.example', transport('{"service":"auralink-internet","protocol":2,"status":"ok"}')));
  const result = await probeInternetService('https://service.example', transport('{"service":"auralink-internet","protocol":1,"status":"ok"}'));
  assert.equal(result.socketUrl, 'wss://service.example/internet/ws');
});

test('a silent half-open native connection revokes admission before terminating', async () => {
  let client; let admittedAtTermination = true;
  let terminated; const completion = new Promise(resolve => { terminated = resolve; });
  class Socket extends EventEmitter {
    constructor() { super(); this.readyState = 1; } ping() {}
    close() { this.emit('close', 1000, 'Closed'); }
    terminate() { admittedAtTermination = client.membership.isAcceptedPeer('guest'); this.emit('close', 1006, 'Unresponsive'); terminated(); }
  }
  client = new NativeInternetClient('https://service.example', 'internet-timeout', () => {}, () => {}, { Socket, heartbeatMs: 10 });
  client.ws.send = () => {};
  client.send(JSON.stringify({ type: 'join', roomId: 'room', roomKey: 'fixture' }));
  client.ws.emit('message', Buffer.from(JSON.stringify({ type: 'welcome', selfId: 'owner', room: { id: 'room' }, peers: [{ id: 'guest' }] })), false);
  const deadline = setTimeout(() => terminated('timeout'), 5000);
  try { assert.notEqual(await completion, 'timeout'); } finally { clearTimeout(deadline); client.close(); }
  assert.equal(admittedAtTermination, false); assert.equal(client.closed, true);
});

test('late native welcome after local leave cannot restore membership or a grant', () => {
  const events = [];
  class Socket extends EventEmitter { constructor() { super(); this.readyState = 1; } send() {} ping() {} close() { this.emit('close', 1000, 'Closed'); } terminate() {} }
  const client = new NativeInternetClient('https://service.example', 'internet-canceled', event => events.push(event), () => {}, { Socket });
  const deliver = value => client.ws.emit('message', Buffer.from(JSON.stringify(value)), false);
  try {
    client.send(JSON.stringify({ type: 'join-device', deviceId: 'owner-device' }));
    deliver({ type: 'pending', selfId: 'guest', room: { id: 'room' } });
    client.send(JSON.stringify({ type: 'leave' }));
    deliver({ type: 'welcome', selfId: 'guest', room: { id: 'room' }, peers: [{ id: 'owner' }] });
    deliver({ type: 'control-granted', targetId: 'guest', peerId: 'owner', sessionId: 'stale-session-123456' });
    assert.equal(client.membership.isAcceptedPeer('owner'), false); assert.equal(client.membership.grant, null);
    assert.equal(events.filter(event => event.type === 'message' && JSON.parse(event.data).type === 'welcome').length, 0);
    deliver({ type: 'room-left' });
    client.send(JSON.stringify({ type: 'join', roomId: 'replacement', roomKey: 'fixture' }));
    deliver({ type: 'pending', selfId: 'new-guest', room: { id: 'replacement' } });
    deliver({ type: 'welcome', selfId: 'old-guest', room: { id: 'replacement' }, peers: [{ id: 'owner' }] });
    assert.equal(client.membership.isAcceptedPeer('owner'), false);
    deliver({ type: 'welcome', selfId: 'new-guest', room: { id: 'replacement' }, peers: [{ id: 'owner' }] });
    assert.equal(client.membership.isAcceptedPeer('owner'), true);
  } finally { client.close(); }
});

test('malformed parsed service messages close native transport before reaching privileged listeners', () => {
  class Socket extends EventEmitter { constructor() { super(); this.readyState = 1; } close(code) { this.emit('close', code, 'Invalid'); } terminate() {} }
  for (const payload of ['null', '[]', '"hello"', '{"type":null}']) {
    const events = []; const client = new NativeInternetClient('https://service.example', 'internet-invalid', event => events.push(event), () => {}, { Socket });
    client.ws.emit('message', Buffer.from(payload), false);
    assert.equal(client.closed, true); assert.equal(events.some(event => event.type === 'message'), false); assert.equal(events.at(-1).code, 1008);
  }
});
