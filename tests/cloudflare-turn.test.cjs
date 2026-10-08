'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const policy = import('../internet-service/src/coordinator.mjs');
const servers = () => [{ urls: ['stun:stun.cloudflare.com:3478'] }, { urls: [
  'turn:turn.cloudflare.com:3478?transport=udp', 'turn:turn.cloudflare.com:3478?transport=tcp',
  'turns:turn.cloudflare.com:5349?transport=tcp', 'turns:turn.cloudflare.com:443?transport=tcp',
  'turn:turn.cloudflare.com:53?transport=udp', 'turn:turn.cloudflare.com:53?transport=tcp',
], username: 'ephemeral-user', credential: 'ephemeral-credential' }];
const response = (body = { iceServers: servers() }, options = {}) => new Response(JSON.stringify(body), {
  status: 201, headers: { 'content-type': 'application/json' }, ...options });
class Store {
  constructor() { this.rooms = new Map(); this.budget = { daily: 0, monthly: 0 }; }
  loadDevices() { return []; } loadRooms() { return [...this.rooms.values()].map(value => structuredClone(value)); }
  saveRoom(room) { this.rooms.set(room.id, structuredClone(room)); } deleteRoom(id) { this.rooms.delete(id); }
  loadBudget() { return structuredClone(this.budget); } saveBudget(budget) { this.budget = structuredClone(budget); }
}
async function fixture(overrides = {}) {
  const { Coordinator } = await policy; const store = new Store(); let time = Date.parse('2026-10-08T15:00:00Z'), calls = 0;
  const env = { PAIRING_KEY: 'test-secret-abcdefghijklmnopqrstuvwxyz123456', RELAY_ENABLED: 'true', TURN_PROVIDER: 'cloudflare',
    CLOUDFLARE_TURN_FREE_ONLY_CONFIRMED: 'true', CLOUDFLARE_TURN_KEY_ID: '0123456789abcdef0123456789abcdef',
    CLOUDFLARE_TURN_API_TOKEN: 'test-backend-token-not-for-clients', RELAY_SESSION_SECONDS: '600', ...overrides };
  const fetcher = async () => { calls++; return response(); };
  const engine = new Coordinator({ store, env, now: () => time, fetcher });
  const room = { id: '11111111-1111-4111-8111-111111111111', createdAt: time, name: 'Test room' };
  engine.rooms.set(room.id, room); store.saveRoom(room);
  return { engine, env, room, store, now: () => time, advance: ms => { time += ms; }, calls: () => calls, fetcher };
}
test('Cloudflare credential exchange sends a backend token only to the official endpoint and filters browser-blocked ports', async () => {
  const { requestCloudflareIce } = await policy; let request;
  const result = await requestCloudflareIce(async (url, init) => { request = { url, init }; return response(); }, 'test-key-01234567', 'backend-only-token', 600);
  assert.equal(request.url, 'https://rtc.live.cloudflare.com/v1/turn/keys/test-key-01234567/credentials/generate-ice-servers');
  assert.equal(request.init.method, 'POST'); assert.equal(request.init.redirect, 'manual');
  assert.equal(request.init.headers.Authorization, 'Bearer backend-only-token'); assert.deepEqual(JSON.parse(request.init.body), { ttl: 600 });
  assert.ok(result.some(entry => entry.urls.includes('turns:turn.cloudflare.com:443?transport=tcp')));
  assert.ok(result.every(entry => entry.urls.every(url => !url.includes(':53?')))); assert.ok(!JSON.stringify(result).includes('backend-only-token'));
});
test('Cloudflare ICE refuses untrusted hosts, mixed protocols, missing credentials and unexpected fields', async () => {
  const { validatedCloudflareIce } = await policy;
  for (const change of [v => { v[1].urls[0] = 'turn:turn.cloudflare.com.attacker.example:3478?transport=udp'; },
    v => { v[1].urls[0] = 'turn:attacker.example:3478?transport=udp'; }, v => { v[1].urls.push('stun:stun.cloudflare.com:3478'); },
    v => { delete v[1].credential; }, v => { v[1].credential = 'invalid\ncredential'; }, v => { v[1].secret = 'extra'; }]) {
    const value = servers(); change(value); assert.equal(validatedCloudflareIce(value), null);
  }
});
test('Cloudflare provider refuses redirects, errors, oversized replies and long-lived token echo', async () => {
  const { requestCloudflareIce } = await policy;
  for (const fetcher of [async () => response({}, { status: 302, headers: { location: 'https://attacker.example' } }),
    async () => response({}, { status: 403 }), async () => response({}, { headers: { 'content-type': 'text/html' } }),
    async () => response({ iceServers: servers(), extra: 'x'.repeat(17000) }),
    async () => { const value = servers(); value[1].credential = 'backend-only-token'; return response({ iceServers: value }); }]) {
    assert.equal(await requestCloudflareIce(fetcher, 'test-key-01234567', 'backend-only-token', 600), null);
  }
});
test('disabled or unconfirmed Cloudflare TURN cannot fetch or reuse credentials', async () => {
  for (const flag of [{ RELAY_ENABLED: 'false' }, { CLOUDFLARE_TURN_FREE_ONLY_CONFIRMED: 'false' }, { CLOUDFLARE_TURN_KEY_ID: '' }]) {
    const s = await fixture(flag); const config = await s.engine.ice(s.room); assert.equal(config.relayEnabled, false); assert.equal(s.calls(), 0);
  }
  const s = await fixture(); assert.equal((await s.engine.ice(s.room)).relayEnabled, true); assert.equal(s.calls(), 1);
  s.env.CLOUDFLARE_TURN_FREE_ONLY_CONFIRMED = 'false'; assert.equal((await s.engine.ice(s.room)).relayEnabled, false); assert.equal(s.calls(), 1);
});
test('Cloudflare short-lived room credentials are encrypted, reused after restoration and never extend their original deadline', async () => {
  const { Coordinator } = await policy; const s = await fixture(); const first = await s.engine.ice(s.room); assert.equal(first.relayEnabled, true);
  assert.equal(first.relaySecondsLimit, 600); const deadline = first.relayExpiresAt; assert.equal(s.calls(), 1);
  const persisted = JSON.stringify([...s.store.rooms.values()]);
  assert.ok(!persisted.includes('ephemeral-credential')); assert.ok(!persisted.includes(s.env.CLOUDFLARE_TURN_API_TOKEN));
  s.advance(60000); const restored = new Coordinator({ store: s.store, env: s.env, now: s.now, fetcher: s.fetcher });
  const cached = await restored.ice(restored.rooms.get(s.room.id)); assert.equal(cached.relaySecondsLimit, 540); assert.equal(cached.relayExpiresAt, deadline); assert.equal(s.calls(), 1);
  s.advance(540000); assert.equal((await restored.ice(restored.rooms.get(s.room.id))).relayEnabled, false); assert.equal(s.calls(), 1);
});
