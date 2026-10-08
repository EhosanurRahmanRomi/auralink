'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const moduleReady = import('data:text/javascript;base64,' + fs.readFileSync(path.join(__dirname, '../src/renderer/rtc.js')).toString('base64'));

test('a capture permission completing after room teardown cannot leak its track', async () => {
  const { RoomRTC } = await moduleReady; const rtc = new RoomRTC({ selfId: 'owner', signal() {} });
  rtc.close(); let stopped = false;
  await rtc.setTrack('screen', { kind: 'video', stop() { stopped = true; } }, {});
  assert.equal(stopped, true); assert.equal(rtc.localTracks.size, 0);
});

test('pending negotiation cannot answer a peer removed while the remote description is applying', async () => {
  const { RoomRTC } = await moduleReady; const sent = []; let release; let started; let answered = false;
  const pending = new Promise(resolve => { release = resolve; });
  const entered = new Promise(resolve => { started = resolve; });
  const rtc = new RoomRTC({ selfId: 'owner', signal: (...values) => sent.push(values) });
  const entry = { queue: Promise.resolve(), polite: true, makingOffer: false, info: { id: 'guest' }, pc: {
    signalingState: 'stable', setRemoteDescription: async () => { started(); await pending; },
    setLocalDescription: async () => { answered = true; }, close() {},
  } };
  rtc.peers.set('guest', entry);
  rtc.receive('guest', { description: { type: 'offer', sdp: 'test' } }); await entered;
  rtc.removePeer('guest'); release(); await entry.queue;
  assert.equal(answered, false); assert.deepEqual(sent, []); rtc.close();
});

test('overlapping diagnostics share a snapshot and discard results of a removed connection', async () => {
  const { RoomRTC } = await moduleReady; let release; let calls = 0;
  const pending = new Promise(resolve => { release = resolve; });
  const rtc = new RoomRTC({ selfId: 'owner', signal() {} });
  rtc.peers.set('guest', { info: { name: 'Guest' }, pc: { connectionState: 'connected', getStats() { calls++; return pending; }, close() {} } });
  const first = rtc.stats(); const second = rtc.stats(); assert.equal(first, second); assert.equal(calls, 1);
  rtc.removePeer('guest'); release(new Map());
  assert.deepEqual(await first, []); assert.equal(rtc.previousStats.size, 0); rtc.close();
});

test('capture teardown during source replacement stops media and cannot attach the remaining sources', async () => {
  const { RoomRTC } = await moduleReady; let release; let entered; const pending = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; }); let screenAttached = false, stopped = 0;
  const audio = { kind: 'audio', stop() { stopped++; } }; const screen = { kind: 'video', stop() { stopped++; } };
  const rtc = new RoomRTC({ selfId: 'owner', signal() {} });
  const entry = { info: { id: 'guest' }, senders: new Map([
    ['audio', { track: null, async replaceTrack() { entered(); await pending; } }],
    ['screen', { track: null, async replaceTrack() { screenAttached = true; } }],
  ]), pc: { close() {} } };
  rtc.peers.set('guest', entry); rtc.localTracks.set('screen', { track: screen });
  const replacement = rtc.setTrack('audio', audio, {}); await started; rtc.close(); release(); await replacement;
  assert.equal(stopped, 2); assert.equal(screenAttached, false); assert.equal(rtc.peers.size, 0);
});
