'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const https = require('node:https');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const WebSocket = require('ws');
const selfsigned = require('selfsigned');
const { createBroker, MAX_PARTICIPANTS } = require('../src/core/broker.cjs');

class Client {
  constructor(ws) {
    this.ws = ws; this.queue = []; this.waiters = []; this.closed = false;
    ws.on('message', raw => {
      const msg = JSON.parse(raw.toString());
      const index = this.waiters.findIndex(w => w.type === msg.type);
      if (index >= 0) { const [waiter] = this.waiters.splice(index, 1); clearTimeout(waiter.timer); waiter.resolve(msg); }
      else this.queue.push(msg);
    });
    ws.on('close', () => { this.closed = true; });
    ws.on('error', () => {});
  }
  send(message) { this.ws.send(JSON.stringify(message)); }
  take(type, timeout = 1200) {
    const index = this.queue.findIndex(msg => msg.type === type);
    if (index >= 0) return Promise.resolve(this.queue.splice(index, 1)[0]);
    return new Promise((resolve, reject) => {
      const waiter = { type, resolve, reject };
      waiter.timer = setTimeout(() => { this.waiters = this.waiters.filter(w => w !== waiter); reject(new Error(`Timed out waiting for ${type}.`)); }, timeout);
      this.waiters.push(waiter);
    });
  }
  async absent(type) {
    await assert.rejects(this.take(type, 70), /Timed out/);
  }
  close() { this.ws.close(); }
}

async function connect(broker, suffix = '/ws') {
  const ws = new WebSocket(broker.url.replace(/^http/, 'ws') + suffix, { rejectUnauthorized: false });
  const client = new Client(ws);
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  return client;
}
async function hostRoom(broker) {
  const host = await connect(broker);
  host.send({ type: 'join', name: 'Room host', roomKey: broker.roomKey, hostToken: broker.hostToken });
  const welcome = await host.take('welcome'); host.id = welcome.selfId;
  assert.equal(welcome.hostId, host.id); assert.deepEqual(welcome.peers, []);
  return host;
}
async function guestRoom(broker, host, name = 'Guest') {
  const client = await connect(broker);
  client.send({ type: 'join', name, roomKey: broker.roomKey });
  const request = await host.take('join-request');
  assert.equal((await client.take('pending')).selfId, request.peerId);
  client.id = request.peerId;
  return client;
}
async function approve(host, client) {
  host.send({ type: 'approve', peerId: client.id });
  const welcome = await client.take('welcome');
  assert.equal(welcome.selfId, client.id);
  assert.equal((await host.take('join-approved')).peerId, client.id);
  await host.take('peer-joined');
  return welcome;
}
async function plainRoom(t) {
  const broker = await createBroker({ host: '127.0.0.1', name: 'Test room' });
  t.after(() => broker.stop());
  return broker;
}
function get(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { rejectUnauthorized: false }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    }).on('error', reject);
  });
}

test('Non-loopback listeners require TLS; static HTTPS does not disclose invitation credentials', async t => {
  await assert.rejects(createBroker({ host: '0.0.0.0' }), /TLS is required/);
  await assert.rejects(createBroker({ host: '127.0.0.1', hostToken: 'weak' }), /at least 32/);
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'auralink-broker-'));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  await fs.writeFile(path.join(temp, 'index.html'), '<!doctype html><title>AuraLink</title>');
  await fs.writeFile(path.join(temp, 'private.cjs'), 'secret');
  const cert = await selfsigned.generate([{ name: 'commonName', value: 'localhost' }], { keySize: 2048, algorithm: 'sha256' });
  const broker = await createBroker({ host: '127.0.0.1', tls: { key: cert.private, cert: cert.cert }, assetsDir: temp });
  t.after(() => broker.stop());
  assert.match(broker.url, /^https:/);
  const index = await get(broker.url + '/');
  assert.equal(index.status, 200); assert.match(index.body, /AuraLink/);
  assert.match(index.headers['content-security-policy'], /frame-ancestors 'none'/);
  assert.equal(index.headers['x-content-type-options'], 'nosniff');
  const health = await get(broker.url + '/health');
  assert.deepEqual(JSON.parse(health.body), { status: 'waiting', participants: 0 });
  assert.ok(!health.body.includes(broker.roomKey) && !health.body.includes(broker.hostToken));
  assert.equal((await get(broker.url + '/private.cjs')).status, 404);
  assert.equal((await get(broker.url + '/index.html?roomKey=' + broker.roomKey)).status, 400);
  assert.equal((await get(broker.url + '/%5c..%5cprivate.cjs')).status, 400);
  await assert.rejects(connect(broker, '/ws?roomKey=' + broker.roomKey), /400/);
});

test('Invitation possession cannot impersonate the independently authenticated local host', async t => {
  const broker = await plainRoom(t);
  assert.ok(broker.roomKey.length >= 40 && broker.hostToken.length >= 40);
  assert.notEqual(broker.roomKey, broker.hostToken);
  const first = await connect(broker);
  first.send({ type: 'join', name: 'Impostor', roomKey: broker.roomKey, isHost: true, role: 'host' });
  assert.match((await first.take('error')).message, /waiting for its host/);
  const impostor = await connect(broker);
  impostor.send({ type: 'join', name: 'Impostor', roomKey: broker.roomKey, hostToken: broker.roomKey });
  assert.match((await impostor.take('error')).message, /Invalid invitation/);
  const host = await hostRoom(broker);
  const duplicate = await connect(broker);
  duplicate.send({ type: 'join', name: 'Duplicate host', roomKey: broker.roomKey, hostToken: broker.hostToken });
  assert.match((await duplicate.take('error')).message, /already has a host/);
  const invalid = await connect(broker);
  invalid.send({ type: 'join', name: 'Unknown', roomKey: 'invalid' });
  assert.match((await invalid.take('error')).message, /Invalid invitation/);
  assert.ok(host.id);
});

test('Host authority is rejected from a LAN-address socket even with the independent secret', async t => {
  const lanAddress = Object.values(os.networkInterfaces()).flat().find(address => address.family === 'IPv4' && !address.internal)?.address;
  if (!lanAddress) { t.skip('No LAN interface is present on this test machine.'); return; }
  const cert = await selfsigned.generate([{ name: 'commonName', value: 'localhost' }], { keySize: 2048, algorithm: 'sha256' });
  const broker = await createBroker({ host: '0.0.0.0', tls: { key: cert.private, cert: cert.cert } });
  t.after(() => broker.stop());
  const remote = await connect({ url: `https://${lanAddress}:${broker.port}` });
  remote.send({ type: 'join', name: 'LAN host claimant', roomKey: broker.roomKey, hostToken: broker.hostToken });
  assert.match((await remote.take('error')).message, /Invalid invitation/);
  assert.equal(broker.isAcceptedPeer('LAN host claimant'), false);
  await hostRoom({ ...broker, url: `https://127.0.0.1:${broker.port}` });
});

test('Pending guests cannot signal; only the host admits guests and names and sender IDs are sanitized', async t => {
  const broker = await plainRoom(t); const host = await hostRoom(broker);
  const pending = await guestRoom(broker, host, ' <Alice>\u202e  Browser ');
  pending.send({ type: 'signal', to: host.id, data: { sdp: 'never-forward' } });
  assert.match((await pending.take('error')).message, /approval is required/);
  await host.absent('signal');
  const welcome = await approve(host, pending);
  assert.equal(welcome.peers[0].role, 'host');
  const second = await guestRoom(broker, host, 'Bob');
  pending.send({ type: 'approve', peerId: second.id });
  assert.match((await pending.take('error')).message, /Only the host/);
  await second.absent('welcome');
  const secondWelcome = await approve(host, second);
  assert.equal(secondWelcome.peers.find(p => p.id === pending.id).name, 'Alice Browser');
  pending.send({ type: 'signal', to: host.id, from: second.id, data: { candidate: 'candidate:example' } });
  const signal = await host.take('signal');
  assert.equal(signal.from, pending.id); assert.deepEqual(signal.data, { candidate: 'candidate:example' });
  pending.send({ type: 'kick', peerId: host.id });
  assert.match((await pending.take('error')).message, /Only the host/);
});

test('Four participants is the admission limit and host rejection/kick removes access', async t => {
  const broker = await plainRoom(t); const host = await hostRoom(broker);
  const guests = [];
  for (let i = 0; i < MAX_PARTICIPANTS - 1; i++) { const guest = await guestRoom(broker, host, `Guest ${i}`); await approve(host, guest); guests.push(guest); }
  const extra = await connect(broker); extra.send({ type: 'join', name: 'Extra', roomKey: broker.roomKey });
  assert.match((await extra.take('error')).message, /room is full/);
  host.send({ type: 'kick', peerId: guests[0].id });
  assert.match((await guests[0].take('rejected')).reason, /ended your participation/);
  assert.equal((await host.take('peer-kicked')).peerId, guests[0].id);
  const rejected = await guestRoom(broker, host, 'Declined');
  host.send({ type: 'reject', peerId: rejected.id });
  assert.match((await rejected.take('rejected')).reason, /declined/);
  assert.equal((await host.take('join-rejected')).peerId, rejected.id);
});

test('Only the requested screen owner can issue one controller session and revoke it', async t => {
  const broker = await plainRoom(t); const host = await hostRoom(broker);
  const alice = await guestRoom(broker, host, 'Alice'); await approve(host, alice);
  const bob = await guestRoom(broker, host, 'Bob'); await approve(host, bob);
  alice.send({ type: 'control-request', to: host.id });
  const request = await host.take('control-request'); assert.equal(request.from, alice.id);
  bob.send({ type: 'control-response', to: alice.id, accepted: true, sessionId: 'forged-session-00000' });
  assert.match((await bob.take('error')).message, /not found or expired/);
  await alice.absent('control-response');
  host.send({ type: 'control-response', to: alice.id, accepted: true });
  assert.match((await host.take('error')).message, /owner-issued/);
  host.send({ type: 'control-response', to: alice.id, accepted: true, sessionId: 'owner-session-1234567890' });
  const grant = await alice.take('control-response');
  assert.equal(grant.from, host.id); assert.equal(grant.sessionId, 'owner-session-1234567890'); assert.equal(grant.accepted, true);
  bob.send({ type: 'grant-control', targetId: host.id, peerId: alice.id, sessionId: 'forged-session-00000' });
  assert.match((await bob.take('error')).message, /Only the screen owner/);
  bob.send({ type: 'control-revoke', to: alice.id });
  assert.match((await bob.take('error')).message, /not found/);
  host.send({ type: 'control-revoke', to: alice.id });
  assert.equal((await alice.take('control-revoke')).sessionId, 'owner-session-1234567890');
  host.send({ type: 'control-response', to: alice.id, accepted: true, sessionId: 'owner-session-1234567890' });
  assert.match((await host.take('error')).message, /not found or expired/);
  bob.send({ type: 'control-request', to: host.id }); await host.take('control-request');
  host.send({ type: 'control-response', to: bob.id, accepted: false });
  assert.deepEqual(await bob.take('control-response'), { type: 'control-response', from: host.id, accepted: false });
});

test('Owner disconnect revokes control and room host disconnect ends all sessions', async t => {
  const broker = await plainRoom(t); const host = await hostRoom(broker);
  const alice = await guestRoom(broker, host, 'Alice'); await approve(host, alice);
  const bob = await guestRoom(broker, host, 'Bob'); await approve(host, bob);
  bob.send({ type: 'control-request', to: alice.id }); await alice.take('control-request');
  alice.send({ type: 'control-response', to: bob.id, accepted: true, sessionId: 'alice-session-1234567890' }); await bob.take('control-response');
  alice.close();
  assert.match((await bob.take('control-revoke')).reason, /owner disconnected/);
  assert.equal((await host.take('peer-left')).peerId, alice.id);
  host.close(); assert.match((await bob.take('room-ended')).reason, /host disconnected/);
});

test('Malformed, binary, unauthenticated input and remote-input messages are rejected', async t => {
  const broker = await plainRoom(t); const host = await hostRoom(broker);
  const client = await connect(broker);
  client.ws.send('{'); assert.equal((await client.take('error')).message, 'Invalid JSON.');
  client.ws.send(Buffer.from('binary')); assert.match((await client.take('error')).message, /Only JSON/);
  client.send({ type: 'signal', to: host.id, data: {} }); assert.match((await client.take('error')).message, /Join the room first/);
  host.send({ type: 'input', data: { key: 'Enter' } }); assert.equal((await host.take('error')).message, 'Unsupported message type.');
  client.close();
});

test('Pending requests expire, disappear from the host list, and are excluded from public presence', async t => {
  const broker = await createBroker({ host: '127.0.0.1', admissionTimeoutMs: 150 });
  t.after(() => broker.stop());
  const host = await hostRoom(broker);
  const pending = await guestRoom(broker, host, 'Pending person');
  assert.equal(broker.isAcceptedPeer(host.id), true);
  assert.equal(broker.isAcceptedPeer(pending.id), false);
  const status = await new Promise((resolve, reject) => {
    require('node:http').get(broker.url + '/health', res => {
      let body = ''; res.on('data', chunk => { body += chunk; }); res.on('end', () => resolve(JSON.parse(body)));
    }).on('error', reject);
  });
  assert.deepEqual(status, { status: 'online', participants: 1 });
  assert.match((await pending.take('rejected')).reason, /expired/);
  assert.equal((await host.take('join-cancelled')).peerId, pending.id);
  host.send({ type: 'approve', peerId: pending.id });
  assert.match((await host.take('error')).message, /not found/);
});
