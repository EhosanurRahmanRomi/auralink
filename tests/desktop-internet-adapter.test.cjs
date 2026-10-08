'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const internetURL = `data:text/javascript;base64,${fs.readFileSync(path.join(__dirname, '../src/renderer/internet.js')).toString('base64')}`;
const source = fs.readFileSync(path.join(__dirname, '../src/renderer/desktop-internet.js'), 'utf8').replace("from './internet.js'", `from '${internetURL}'`);
const moduleReady = import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);

test('desktop adapter retains its text ceiling except for an exact encrypted relay envelope', async () => {
  const { createDesktopInternetSocket } = await moduleReady; let listener; let socketId; const sent = [];
  const bridge = {
    onInternetEvent(callback) { listener = callback; return () => { listener = null; }; },
    async internetOpen(args) { socketId = args.socketId; queueMicrotask(() => listener?.({ socketId, type: 'open' })); },
    async internetSend(args) { sent.push(args.data); },
    async internetClose() { queueMicrotask(() => listener?.({ socketId, type: 'close', code: 1000 })); },
  };
  const socket = createDesktopInternetSocket(bridge, 'wss://service.example/internet/ws');
  await new Promise(resolve => socket.addEventListener('open', resolve, { once: true }));
  const relay = { version: 1, epoch: 'a'.repeat(16), counter: 1, nonce: 'b'.repeat(16), ciphertext: Buffer.alloc(80000, 3).toString('base64url') };
  const packet = { type: 'signal', to: 'room-peer', data: { relay } }; const raw = JSON.stringify(packet);
  socket.send(raw); assert.deepEqual(sent, [raw]);
  for (const invalid of [JSON.stringify({ type: 'join', padding: 'a'.repeat(80000) }), JSON.stringify({ ...packet, extra: true }), JSON.stringify({ ...packet, data: { relay, description: 'forbidden' } }), JSON.stringify({ ...packet, data: { relay: { ...relay, ciphertext: Buffer.alloc(180001).toString('base64url') } } })]) assert.throws(() => socket.send(invalid), /64 KB/);
  socket.close(); await new Promise(resolve => socket.addEventListener('close', resolve, { once: true })); assert.equal(socket.readyState, 3);
});
