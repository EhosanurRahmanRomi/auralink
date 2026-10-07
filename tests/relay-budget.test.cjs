const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
let modulePromise;
const rtcModule = () => modulePromise ||= import('data:text/javascript;base64,' + fs.readFileSync(require('node:path').join(__dirname, '../src/renderer/rtc.js')).toString('base64'));

test('direct traffic does not consume relay allowance and route changes count only new traffic', async () => {
  const { RelayBudget } = await rtcModule(); const budget = new RelayBudget({ bytes: 100 });
  assert.equal(budget.observe('peer', { relay: false, bytes: 10000, now: 0 }), false);
  assert.equal(budget.observe('peer', { relay: true, bytes: 10060, now: 1000 }), false);
  assert.equal(budget.bytes, 60);
  assert.equal(budget.observe('peer', { relay: true, bytes: 10110, now: 2000 }), true);
  assert.equal(budget.bytes, 110);
});
test('relay time accumulates across viewers and cannot reset by removing a participant', async () => {
  const { RelayBudget } = await rtcModule(); const budget = new RelayBudget({ seconds: 10 });
  budget.observe('a', { relay: true, bytes: 0, now: 0 }); budget.observe('b', { relay: true, bytes: 0, now: 0 });
  budget.observe('a', { relay: true, bytes: 10, now: 5000 });
  assert.equal(budget.observe('b', { relay: true, bytes: 10, now: 5000 }), true);
  budget.peers.delete('a'); assert.equal(budget.seconds, 10);
  assert.equal(budget.observe('c', { relay: false, bytes: 0, now: 6000 }), true);
});
test('a relay allowance violation closes actual RTC transports and media before its notification', async () => {
  const { RoomRTC } = await rtcModule(); const rtc = new RoomRTC({ selfId: 'self', signal() {}, relayBytesLimit: 100 });
  const stats = new Map([
    ['transport', { type: 'transport', selectedCandidatePairId: 'pair' }],
    ['pair', { type: 'candidate-pair', state: 'succeeded', nominated: true, localCandidateId: 'local', remoteCandidateId: 'remote', bytesSent: 60, bytesReceived: 60 }],
    ['local', { candidateType: 'host' }], ['remote', { candidateType: 'relay' }],
  ]);
  let transportClosed = false; let trackStopped = false; let event;
  rtc.peers.set('peer', { info: { name: 'Peer' }, pc: { connectionState: 'connected', getStats: async () => stats, close() { transportClosed = true; } }, channel: null });
  rtc.localTracks.set('audio', { track: { stop() { trackStopped = true; } } });
  rtc.addEventListener('relay-budget', value => { assert.equal(transportClosed, true); assert.equal(trackStopped, true); event = value.detail; });
  const report = await rtc.stats();
  assert.equal(report[0].route, 'Relay'); assert.equal(rtc.closed, true); assert.equal(event.usedBytes, 120);
});
