'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const moduleReady = import('data:text/javascript;base64,' + fs.readFileSync(path.join(__dirname, '../src/renderer/rtc.js')).toString('base64'));

class CaptureTrack extends EventTarget {
  constructor(kind = 'audio') { super(); this.kind = kind; this.enabled = true; this.muted = false; this.readyState = 'live'; }
  stop() { this.readyState = 'ended'; }
  end() { this.readyState = 'ended'; this.dispatchEvent(new Event('ended')); }
}
function peerEntry(id, sender) {
  return { info: { id }, senders: new Map([['audio', sender]]), remoteTracks: new Map(), inactiveRemoteTracks: new Map(),
    pc: { connectionState: 'connected', close() { this.connectionState = 'closed'; } } };
}

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

test('a pending direct microphone replacement cannot delay starting an existing relay microphone', async () => {
  const { RoomRTC } = await moduleReady; let release; let entered; let relayStarts = 0;
  const pending = new Promise(resolve => { release = resolve; }); const started = new Promise(resolve => { entered = resolve; });
  const rtc = new RoomRTC({ selfId: 'owner', signal() {} }); rtc.relayMedia = { state() { relayStarts++; }, close() {}, removePeer() {} };
  rtc.peers.set('direct', peerEntry('direct', { track: null, async replaceTrack() { entered(); await pending; } }));
  const replacing = rtc.setTrack('audio', new CaptureTrack(), {}); await started;
  try { assert.equal(relayStarts, 1, 'The relay source must start before a direct sender settles'); }
  finally { release(); await replacing; rtc.close(); }
});

test('one rejected direct sender falls back without rejecting microphone capture for healthy peers', async () => {
  const { RoomRTC } = await moduleReady; const errors = []; const activated = []; const track = new CaptureTrack();
  const rtc = new RoomRTC({ selfId: 'owner', signal() {} });
  const media = { state() {}, activate(id) { activated.push(id); }, close() {}, removePeer() {} };
  rtc.websocketRelayEnabled = true; rtc.relayMedia = media; rtc.relayReady = Promise.resolve(media);
  const broken = peerEntry('broken', { track: null, async replaceTrack() { throw new Error('Microphone encoder unavailable'); } });
  const healthySender = { track: null, async replaceTrack(next) { this.track = next; } };
  rtc.peers.set('broken', broken); rtc.peers.set('healthy', peerEntry('healthy', healthySender));
  rtc.addEventListener('error', event => errors.push(event.detail));
  try {
    await assert.doesNotReject(rtc.setTrack('audio', track, {}));
    assert.equal(healthySender.track, track); assert.deepEqual(activated, ['broken']); assert.equal(broken.relayActive, true);
    assert.equal(errors.length, 1); assert.equal(errors[0].peerId, 'broken');
  } finally { rtc.close(); }
});

test('an ended microphone stops advertised media and relay capture without waiting for a UI handler', async () => {
  const { RoomRTC } = await moduleReady; const sent = []; const states = []; const captureEvents = [];
  const rtc = new RoomRTC({ selfId: 'owner', signal: (_, data) => sent.push(data) });
  rtc.relayMedia = { state() { states.push(rtc.mediaState()); }, close() {}, removePeer() {} };
  rtc.peers.set('guest', peerEntry('guest', { track: null, async replaceTrack(next) { this.track = next; } }));
  rtc.addEventListener('capture-state', event => captureEvents.push(event.detail));
  const track = new CaptureTrack(); await rtc.setTrack('audio', track, {}); track.end();
  await rtc.peers.get('guest').mediaQueue;
  assert.equal(rtc.localTracks.has('audio'), false); assert.equal(sent.at(-1).mediaState.audio, false);
  assert.equal(states.at(-1).audio, false); assert.equal(captureEvents.at(-1).state, 'ended'); rtc.close();
});

test('temporary source mute reports a paused capture and a retired source cannot remove its replacement', async () => {
  const { RoomRTC } = await moduleReady; const events = [];
  const rtc = new RoomRTC({ selfId: 'owner', signal() {} }); rtc.addEventListener('capture-state', event => events.push(event.detail));
  const old = new CaptureTrack(); await rtc.setTrack('audio', old, {});
  old.muted = true; old.dispatchEvent(new Event('mute')); assert.equal(events.at(-1).state, 'paused'); assert.equal(rtc.mediaState().audio, true);
  old.muted = false; old.dispatchEvent(new Event('unmute')); assert.equal(events.at(-1).state, 'live');
  const current = new CaptureTrack(); await rtc.setTrack('audio', current, {}); old.end();
  assert.equal(rtc.localTracks.get('audio').track, current); assert.equal(rtc.mediaState().audio, true); rtc.close();
});

test('explicit secure relay retry replaces a connected RTC route and preserves the live microphone', async () => {
  const { RoomRTC } = await moduleReady; const activated = [];
  const rtc = new RoomRTC({ selfId: 'owner', signal() {} }); const track = new CaptureTrack(); await rtc.setTrack('audio', track, {});
  const media = { state() {}, activate(id) { activated.push(id); }, close() {}, removePeer() {} };
  rtc.websocketRelayEnabled = true; rtc.relayMedia = media; rtc.relayReady = Promise.resolve(media);
  rtc.peers.set('guest', peerEntry('guest', { track: null }));
  try {
    assert.equal(await rtc.useSecureRelay(), 1); assert.deepEqual(activated, ['guest']);
    assert.equal(rtc.peers.get('guest').pc.connectionState, 'closed'); assert.equal(rtc.localTracks.get('audio').track, track);
    assert.equal(await rtc.useSecureRelay(), 0, 'An already active relay must not duplicate sources or playback');
  } finally { rtc.close(); }
});

test('secure relay retry fails clearly when this room has no available relay transport', async () => {
  const { RoomRTC } = await moduleReady; const rtc = new RoomRTC({ selfId: 'owner', signal() {} });
  try { await assert.rejects(rtc.useSecureRelay(), /relay.*unavailable/i); }
  finally { rtc.close(); }
});

test('overlapping relay retries switch each connection only once while support is loading', async () => {
  const { RoomRTC } = await moduleReady; const rtc = new RoomRTC({ selfId: 'owner', signal() {} });
  const activated = []; let release; const media = { activate(id) { activated.push(id); }, close() {}, removePeer() {} };
  rtc.websocketRelayEnabled = true; rtc.relayReady = new Promise(resolve => { release = resolve; }); rtc.relayMedia = media;
  rtc.peers.set('guest', peerEntry('guest', { track: null }));
  const first = rtc.useSecureRelay(); const second = rtc.useSecureRelay(); release(media);
  try { const counts = await Promise.all([first, second]); assert.deepEqual(activated, ['guest']); assert.equal(counts[0] + counts[1], 1); }
  finally { rtc.close(); }
});

test('microphone diagnostics use the current capture rather than a retired source stats row', async () => {
  const { RoomRTC } = await moduleReady; const rtc = new RoomRTC({ selfId: 'owner', signal() {} });
  const track = new CaptureTrack(); track.id = 'current-input'; await rtc.setTrack('audio', track, {});
  const report = new Map([
    ['current-source', { id: 'current-source', type: 'media-source', kind: 'audio', trackIdentifier: track.id, audioLevel: .25, totalSamplesDuration: 2, totalAudioEnergy: .5 }],
    ['retired-source', { id: 'retired-source', type: 'media-source', kind: 'audio', trackIdentifier: 'retired-input', audioLevel: 0, totalSamplesDuration: 20, totalAudioEnergy: 0 }],
    ['sent-audio', { type: 'outbound-rtp', kind: 'audio', mediaSourceId: 'current-source', packetsSent: 25, bytesSent: 1000 }],
    ['received-audio', { type: 'inbound-rtp', kind: 'audio', packetsReceived: 30, bytesReceived: 1200, totalAudioEnergy: .4 }],
  ]);
  rtc.peers.set('guest', { info: { id: 'guest' }, pc: { connectionState: 'connected', async getStats() { return report; }, close() {} } });
  try {
    const [stats] = await rtc.stats(); assert.equal(stats.microphoneState, 'live'); assert.equal(stats.microphoneLevel, .25);
    assert.equal(stats.capturedAudioDuration, 2); assert.equal(stats.capturedAudioEnergy, .5);
    assert.equal(stats.sentAudioBytes, 1000); assert.equal(stats.receivedAudioBytes, 1200);
    await rtc.setTrack('audio', null); const [off] = await rtc.stats();
    assert.equal(off.microphoneState, 'off'); assert.equal(off.microphoneLevel, null); assert.equal(off.capturedAudioEnergy, null);
  } finally { rtc.close(); }
});

test('secure relay diagnostics retain native capture and PCM processing evidence', async () => {
  const { RoomRTC } = await moduleReady; const rtc = new RoomRTC({ selfId: 'owner', signal() {} });
  rtc.peers.set('guest', { relayActive: true, info: { id: 'guest' }, pc: { close() {} } });
  rtc.relayMedia = { peers: new Map([['guest', { audioPackets: 10, frames: 15, received: 400, sent: 500 }]]),
    sources: new Map([['screen', { captureBackend: 'Video element', capturedFrames: 27, captureError: null }]]),
    audioDiagnostics() { return { sentAudioPackets: 9, capturedAudioPackets: 11, capturedAudioSamples: 52800, capturedAudioEnergy: .04, microphoneLevel: .2, captureContextState: 'running', playbackContextState: 'suspended' }; },
    close() {}, removePeer() {} };
  try {
    const [stats] = await rtc.stats(); assert.equal(stats.route, 'Secure relay'); assert.equal(stats.captureBackend, 'Video element'); assert.equal(stats.capturedFrames, 27);
    assert.equal(stats.captureError, null); assert.equal(stats.sentAudioPackets, 9); assert.equal(stats.receivedAudioPackets, 10);
    assert.equal(stats.capturedAudioSamples, 52800); assert.equal(stats.microphoneLevel, .2); assert.equal(stats.captureContextState, 'running'); assert.equal(stats.playbackContextState, 'suspended');
  } finally { rtc.close(); }
});
