'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const moduleReady = import('data:text/javascript;base64,' + fs.readFileSync(path.join(__dirname, '../src/renderer/relay-media.js')).toString('base64'));
test('relay encryption authenticates membership/direction and rejects tampering and replay', async () => {
  const { RelayCipher, validRelayEnvelope } = await moduleReady; const key = randomBytes(32).toString('base64url');
  const a = new RelayCipher(key, 'owner', 'guest'), b = new RelayCipher(key, 'guest', 'owner');
  const plain = new TextEncoder().encode('private synthetic media'); const first = await a.seal(plain);
  assert.equal(validRelayEnvelope(first), true); assert.ok(!JSON.stringify(first).includes('private synthetic media'));
  const tampered = { ...first, ciphertext: (first.ciphertext[0] === 'A' ? 'B' : 'A') + first.ciphertext.slice(1) };
  assert.equal(await b.open(tampered), null); assert.deepEqual(await b.open(first), plain); assert.equal(await b.open(first), null);
  const second = await a.seal(plain); const unrelated = new RelayCipher(key, 'guest', 'unrelated');
  assert.equal(await unrelated.open(second), null); assert.equal(await a.open(second), null);
  assert.equal(await b.open({ ...second, counter: second.counter + 1 }), null); assert.deepEqual(await b.open(second), plain);
  a.close(); b.close(); unrelated.close();
});
test('relay rekey retires earlier epochs and teardown cannot finish late encryption/decryption', async () => {
  const { RelayCipher } = await moduleReady; const key = randomBytes(32).toString('base64url');
  const a = new RelayCipher(key, 'owner', 'guest'), fresh = new RelayCipher(key, 'owner', 'guest'), b = new RelayCipher(key, 'guest', 'owner');
  const plain = new Uint8Array([1, 2, 3]); const old1 = await a.seal(plain), old2 = await a.seal(plain);
  assert.deepEqual(await b.open(old1), plain); assert.deepEqual(await b.open(await fresh.seal(plain)), plain); assert.equal(await b.open(old2), null);
  const pending = fresh.seal(plain); fresh.close(); assert.equal(await pending, null);
  const receiver = new RelayCipher(key, 'guest', 'owner'); const opening = receiver.open(old2); receiver.close(); assert.equal(await opening, null);
  a.close(); b.close();
});
test('only bounded ciphertext envelopes are accepted and plaintext has a strict ceiling', async () => {
  const { RelayCipher, validRelayEnvelope, MAX_RELAY_PLAIN_BYTES } = await moduleReady;
  const a = new RelayCipher(randomBytes(32).toString('base64url'), 'owner', 'guest'); const packet = await a.seal(new Uint8Array(24));
  for (const mutation of [{ ...packet, plaintext: 'unauthorized' }, { ...packet, counter: 0 }, { ...packet, counter: Number.MAX_SAFE_INTEGER + 1 },
    { ...packet, nonce: 'short' }, { ...packet, ciphertext: 'A'.repeat(240001) }, { ...packet, epoch: '$'.repeat(16) }]) assert.equal(validRelayEnvelope(mutation), false);
  assert.equal(await a.seal(new Uint8Array(MAX_RELAY_PLAIN_BYTES + 1)), null); a.close(); assert.equal(await a.seal(new Uint8Array(1)), null);
});
