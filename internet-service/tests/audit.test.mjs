import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import worker, { invitationCode } from '../src/worker.mjs';
import { canonicalBase64url, validRelaySignal } from '../src/coordinator.mjs';
const { NativeInternetClient } = createRequire(import.meta.url)('../../src/core/internet-client.cjs');

test('native desktop transport permits video cadence independently of normal-command abuse limits', () => {
  class Socket extends EventEmitter { constructor() { super(); this.readyState = 1; } send() {} ping() {} terminate() {} close(code) { this.emit('close', code, 'Finished'); } }
  const client = new NativeInternetClient('https://example.workers.dev', 'cadence-test', () => {}, () => {}, { Socket });
  try {
    client.send('{"type":"join","roomId":"room"}');
    client.ws.emit('message', Buffer.from(JSON.stringify({ type: 'welcome', selfId: 'owner', room: { id: 'room' }, peers: [{ id: 'guest' }],
      websocketRelayEnabled: true, relayKey: randomBytes(32).toString('base64url') })), false);
    for (let i = 1; i <= 600; i++) client.send(JSON.stringify({ type: 'signal', to: 'guest', data: { relay: {
      version: 1, epoch: 'A'.repeat(16), nonce: 'A'.repeat(16), counter: i, ciphertext: 'A'.repeat(22) } } }));
    assert.throws(() => client.send(JSON.stringify({ type: 'signal', to: 'guest', data: { relay: {
      version: 1, epoch: 'A'.repeat(16), nonce: 'A'.repeat(16), counter: 601, ciphertext: 'A'.repeat(22) } } })), /Too many encrypted media/);
    for (let i = 0; i < 149; i++) client.send('{"type":"ping"}');
    assert.throws(() => client.send('{"type":"ping"}'), /Too many internet/);
  } finally { client.close(); }
});

test('allocation-free base64url validation agrees with canonical binary encoding at boundaries', () => {
  for (const bytes of [15, 16, 17, 18, 31, 32, 33, 65535, 179999, 180000, 180001]) {
    const value = randomBytes(bytes).toString('base64url');
    assert.equal(canonicalBase64url(value, 16, 180000), bytes >= 16 && bytes <= 180000);
    if (value.length % 4) {
      const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
      const last = alphabet.indexOf(value.at(-1));
      const noncanonical = value.slice(0, -1) + alphabet[last + 1];
      assert.equal(Buffer.from(noncanonical, 'base64url').toString('base64url'), value);
      assert.equal(canonicalBase64url(noncanonical, 16, 180000), false);
    }
  }
  for (const value of ['A'.repeat(21), 'A'.repeat(25), 'A'.repeat(22) + '=', 'A'.repeat(21) + '+', 'A'.repeat(21) + '/', '', null]) {
    assert.equal(canonicalBase64url(value, 16, 180000), false);
  }
  const signal = { type: 'signal', to: 'peer', data: { relay: { version: 1, epoch: 'A'.repeat(16), nonce: 'A'.repeat(16), counter: 1, ciphertext: 'A'.repeat(22) } } };
  assert.equal(validRelaySignal(signal), true);
  signal.data.relay.ciphertext = 'A'.repeat(21) + 'B'; assert.equal(validRelaySignal(signal), false);
});

test('landing accepts exactly one canonical invitation and rejects ambiguity or oversized fields', () => {
  const room = '00000000-0000-0000-0000-000000000001', key = randomBytes(32).toString('base64url');
  const fragment = `#internet=1&room=${room}&key=${key}`;
  assert.equal(invitationCode(fragment), `A1.${room}.${key}`);
  const invalid = [fragment + '&key=' + key, fragment + '&room=' + room, fragment + '&internet=1', fragment + '&extra=1',
    fragment.replace('internet=1', 'internet=0'), fragment.replace(key, key.slice(0, -1) + '_'),
    fragment.replace(room, room.toUpperCase().replace('00000000', 'AAAAAAAA')), fragment + ' ', '#'.repeat(2049), null];
  for (const value of invalid) assert.equal(invitationCode(value), null);
});

test('actual nonce-protected landing script uses the canonical parser and never navigates malformed fragments', async () => {
  const response = await worker.fetch(new Request('https://example.workers.dev/'), {});
  const html = await response.text(), script = html.match(/<script nonce="[a-f0-9]+">([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script); assert.equal(response.headers.get('Referrer-Policy'), 'no-referrer');
  assert.match(response.headers.get('Content-Security-Policy'), /connect-src 'none'/);
  const room = '00000000-0000-0000-0000-000000000001', key = randomBytes(32).toString('base64url');
  for (const [fragment, valid] of [[`#internet=1&room=${room}&key=${key}`, true], [`#internet=1&room=${room}&key=${key}&key=${key}`, false]]) {
    const elements = new Map();
    const document = { getElementById(id) { if (!elements.has(id)) elements.set(id, { classList: { remove() {} }, removeAttribute() {}, addEventListener() {} }); return elements.get(id); } };
    vm.runInNewContext(script, { document, location: { hash: fragment }, URLSearchParams });
    assert.equal(elements.get('open').href, valid ? `auralink://join#code=A1.${room}.${key}` : undefined);
  }
});
