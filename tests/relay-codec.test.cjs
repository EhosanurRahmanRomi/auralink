'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const ready = import('data:text/javascript;base64,' + fs.readFileSync(path.join(__dirname, '../src/renderer/relay-media.js')).toString('base64'));
function rtc() {
  const calls = [];
  return { selfId: 'owner', closed: false, peers: new Map([['guest', { remoteState: { screen: true }, remoteTracks: new Map(), inactiveRemoteTracks: new Map() }]]),
    localTracks: new Map(), signal: (id, data) => { calls.push({ id, data }); return true; }, emit: () => {}, calls };
}
function vp8(width, height, length = 10) {
  const bytes = new Uint8Array(length); bytes.set([0, 0, 0, 0x9d, 1, 0x2a, width & 255, width >> 8, height & 255, height >> 8]); return bytes;
}
function baselineSPS(width, height) {
  let bits = ''; const fixed = (value, length) => { bits += value.toString(2).padStart(length, '0'); };
  const ue = value => { const encoded = (value + 1).toString(2); bits += '0'.repeat(encoded.length - 1) + encoded; };
  fixed(66, 8); fixed(0, 8); fixed(51, 8); ue(0); ue(0); ue(0); ue(0); ue(1); fixed(0, 1);
  ue(Math.ceil(width / 16) - 1); ue(Math.ceil(height / 16) - 1); fixed(1, 1); fixed(1, 1); fixed(1, 1);
  ue(0); ue((Math.ceil(width / 16) * 16 - width) / 2); ue(0); ue((Math.ceil(height / 16) * 16 - height) / 2); fixed(0, 1); fixed(1, 1);
  bits += '0'.repeat((8 - bits.length % 8) % 8);
  const bytes = []; let zeros = 0;
  for (let offset = 0; offset < bits.length; offset += 8) { const byte = parseInt(bits.slice(offset, offset + 8), 2);
    if (zeros >= 2 && byte <= 3) { bytes.push(3); zeros = 0; } bytes.push(byte); zeros = byte === 0 ? zeros + 1 : 0;
  }
  return new Uint8Array([0, 0, 0, 1, 0x67, ...bytes, 0, 0, 1, 0x65, 1, 1]);
}
test('relay ciphertext rejects noncanonical trailing bits and impossible base64 lengths without decoding payload', async () => {
  const { RelayCipher, validRelayEnvelope } = await ready;
  const cipher = new RelayCipher(randomBytes(32).toString('base64url'), 'owner', 'guest');
  const envelope = await cipher.seal(new Uint8Array(24));
  assert.equal(validRelayEnvelope(envelope), true);
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const last = alphabet.indexOf(envelope.ciphertext.at(-1));
  assert.equal(validRelayEnvelope({ ...envelope, ciphertext: envelope.ciphertext.slice(0, -1) + alphabet[last | 1] }), false);
  assert.equal(validRelayEnvelope({ ...envelope, ciphertext: 'A'.repeat(25) }), false);
  assert.equal(validRelayEnvelope({ ...envelope, ciphertext: 'A'.repeat(239999) + 'B' }), true); // divisible by 4: all bits carry data
  cipher.close();
});
test('large encoded frames are encrypted in bounded fragments, admitted atomically, and queue at most two frames', async () => {
  const { RelayMedia, RelayCipher, MAX_RELAY_PLAIN_BYTES } = await ready;
  const transport = rtc(), key = randomBytes(32).toString('base64url'); const media = new RelayMedia(transport, key);
  const peer = media.addPeer('guest'); peer.active = true;
  const bytes = Uint8Array.from({ length: 400003 }, (_, index) => index % 251);
  const header = { type: 'video-chunk', kind: 'screen', stream: 'AAAAAAAAAAAAAAAA', sequence: 1, codec: 'vp8', width: 2560, height: 1440, chunkType: 'key', timestamp: 1000 };
  assert.equal(media.sendVideo('guest', header, bytes), true);
  assert.equal(media.sendVideo('guest', { ...header, sequence: 2, chunkType: 'delta' }, new Uint8Array(4000)), true);
  assert.equal(media.sendVideo('guest', { ...header, sequence: 3 }, bytes), false);
  assert.equal(peer.pendingVideo, 2);
  await peer.sendQueue;
  assert.equal(peer.pendingVideo, 0);
  const receiver = new RelayCipher(key, 'guest', 'owner'); const decoded = [];
  for (const item of transport.calls) {
    assert.equal(Object.keys(item.data).join(','), 'relay');
    const plain = await receiver.open(item.data.relay); assert.ok(plain.length <= MAX_RELAY_PLAIN_BYTES);
    const length = new DataView(plain.buffer, plain.byteOffset, plain.byteLength).getUint16(0);
    decoded.push({ header: JSON.parse(new TextDecoder().decode(plain.slice(2, length + 2))), bytes: plain.slice(length + 2) });
  }
  assert.deepEqual(decoded.slice(0, 3).map(item => [item.header.index, item.header.count, item.header.total]), [[0, 3, 400003], [1, 3, 400003], [2, 3, 400003]]);
  assert.deepEqual(new Uint8Array(Buffer.concat(decoded.slice(0, 3).map(item => Buffer.from(item.bytes)))), bytes);
  assert.equal(decoded[3].header.sequence, 2);
  media.close(); receiver.close();
});
test('fragment loss requests a key frame, rejects dependent frames, and releases decoder resources on removal', async () => {
  const { RelayMedia } = await ready;
  const originalDecoder = global.VideoDecoder, originalChunk = global.EncodedVideoChunk;
  const decoders = [];
  class Decoder {
    static async isConfigSupported(config) { return { supported: true, config }; }
    constructor() { this.state = 'unconfigured'; this.decodeQueueSize = 0; this.chunks = []; decoders.push(this); }
    configure(config) { this.config = config; this.state = 'configured'; }
    decode(chunk) { this.chunks.push(chunk); }
    close() { this.state = 'closed'; }
  }
  global.VideoDecoder = Decoder; global.EncodedVideoChunk = class { constructor(config) { Object.assign(this, config); } };
  try {
    const transport = rtc(), media = new RelayMedia(transport, randomBytes(32).toString('base64url'));
    const peer = media.addPeer('guest'); peer.active = true;
    const header = { type: 'video-chunk', kind: 'screen', stream: 'AAAAAAAAAAAAAAAA', sequence: 1, codec: 'vp8', width: 2560, height: 1440, chunkType: 'key', timestamp: 1000, index: 0, count: 1, total: 10 };
    await media.videoChunk('guest', peer, header, vp8(2560, 1440));
    assert.equal(decoders.length, 1); assert.equal(decoders[0].chunks.length, 1);
    const delta = new Uint8Array(10); delta[0] = 1;
    await media.videoChunk('guest', peer, { ...header, sequence: 3, chunkType: 'delta' }, delta);
    assert.equal(decoders[0].chunks.length, 1); assert.equal(peer.decoderNeedsKey, true);
    peer.lastDecoderConfig -= 300;
    await media.videoChunk('guest', peer, { ...header, sequence: 4 }, vp8(2560, 1440));
    assert.equal(decoders[0].state, 'closed'); assert.equal(decoders[1].chunks.length, 1);
    await media.videoChunk('guest', peer, { ...header, sequence: 4 }, vp8(2560, 1440));
    assert.equal(decoders[1].chunks.length, 1, 'Reused frame sequence cannot be decoded twice');
    media.removeOutput('guest', 'screen'); peer.lastDecoderConfig -= 300;
    await media.videoChunk('guest', peer, { ...header, sequence: 5 }, vp8(2560, 1440));
    assert.equal(decoders.length, 2, 'A retired capture stream cannot revive after stop/restart');
    header.stream = 'BBBBBBBBBBBBBBBB';
    await media.videoChunk('guest', peer, { ...header, sequence: 1 }, vp8(2560, 1440));
    assert.equal(decoders.length, 3); assert.equal(decoders[2].chunks.length, 1);
    await media.videoChunk('guest', peer, { ...header, sequence: 5, total: 160004, count: 2 }, vp8(2560, 1440, 160000));
    assert.ok(peer.assembly);
    await media.videoChunk('guest', peer, { ...header, sequence: 6, chunkType: 'delta' }, delta);
    assert.equal(peer.assembly, null); assert.equal(peer.decoderNeedsKey, true);
    assert.equal(decoders[2].chunks.length, 1);
    await peer.sendQueue; assert.equal(transport.calls.length, 1, 'Recovery requests are rate bounded');
    media.removePeer('guest'); assert.equal(decoders[2].state, 'closed'); assert.equal(media.peers.size, 0); media.close();
  } finally { global.VideoDecoder = originalDecoder; global.EncodedVideoChunk = originalChunk; }
});
test('encrypted codec rejection removes the failed negotiated codec and requests fresh source keyframe', async () => {
  const { RelayMedia, RelayCipher } = await ready;
  const transport = rtc(), key = randomBytes(32).toString('base64url'), media = new RelayMedia(transport, key);
  const peer = media.addPeer('guest'); peer.active = true; peer.videoCodecs = ['avc1.420033', 'vp8'];
  const source = { forceKey: false }; media.sources.set('screen', source);
  const metadata = new TextEncoder().encode(JSON.stringify({ type: 'codec-reject', codec: 'avc1.420033' }));
  const packet = new Uint8Array(2 + metadata.length); new DataView(packet.buffer).setUint16(0, metadata.length); packet.set(metadata, 2);
  const sender = new RelayCipher(key, 'guest', 'owner'); media.receive('guest', await sender.seal(packet)); await peer.receiveQueue;
  assert.deepEqual(peer.videoCodecs, ['vp8']); assert.equal(source.forceKey, true);
  media.sources.delete('screen'); sender.close(); media.close();
});
test('VP8 dimensions and keyframe type are checked against encrypted metadata before decode', async () => {
  const { validEncodedVideo } = await ready;
  assert.equal(validEncodedVideo('vp8', vp8(2560, 1440), 2560, 1440, true), true);
  assert.equal(validEncodedVideo('vp8', vp8(8192, 8192), 2560, 1440, true), false);
  assert.equal(validEncodedVideo('vp8', vp8(2560, 1440), 2560, 1440, false), false);
  assert.equal(validEncodedVideo('avc1.420033', new Uint8Array([0, 0, 1, 0x67, 0]), 2560, 1440, true), false);
  assert.equal(validEncodedVideo('avc1.420033', baselineSPS(2560, 1440), 2560, 1440, true), true);
  assert.equal(validEncodedVideo('avc1.420033', baselineSPS(1920, 1080), 1920, 1080, true), true, 'Cropped1088-pixelcodedheight must remain1080 displayedpixels');
  assert.equal(validEncodedVideo('avc1.420033', baselineSPS(8192, 8192), 2560, 1440, true), false);
});
test('late JPEG decode or audio worklet startup cannot revive a remotely muted track', async () => {
  const { RelayMedia } = await ready;
  const transport = rtc(), media = new RelayMedia(transport, randomBytes(32).toString('base64url'));
  const peer = media.addPeer('guest'); peer.active = true;
  const oldBitmap = global.createImageBitmap, oldContext = global.AudioContext;
  let finishBitmap, finishAudio, bitmapClosed = false, contextClosed = false;
  global.createImageBitmap = () => new Promise(resolve => { finishBitmap = resolve; });
  global.AudioContext = class { constructor() { this.state = 'suspended'; } async close() { contextClosed = true; } };
  media.audioModule = () => new Promise(resolve => { finishAudio = resolve; });
  try {
    const jpeg = new Uint8Array([255, 216, 255, 192, 0, 11, 8, 1, 104, 2, 128, 1, 1, 17, 0, 255, 218]);
    const decoding = media.video('guest', peer, { kind: 'screen', width: 640, height: 360 }, jpeg);
    transport.peers.get('guest').remoteState.screen = false;
    finishBitmap({ width: 640, height: 360, close: () => { bitmapClosed = true; } }); await decoding;
    assert.equal(bitmapClosed, true); assert.equal(peer.outputs.size, 0);
    const startingAudio = media.audio('guest', peer, { sampleRate: 24000 }, new Uint8Array(2));
    transport.peers.get('guest').remoteState.audio = false; finishAudio(); await startingAudio;
    assert.equal(contextClosed, true); assert.equal(media.audioContexts.size, 0); assert.equal(peer.outputs.size, 0);
  } finally { global.createImageBitmap = oldBitmap; global.AudioContext = oldContext; media.close(); }
});
test('a late failed audio module from an old source cannot tear down its replacement', async () => {
  const { RelayMedia } = await ready;
  const transport = rtc(), media = new RelayMedia(transport, randomBytes(32).toString('base64url'));
  const peer = media.addPeer('guest'); peer.active = true;
  const oldContext = global.AudioContext; let rejectModule;
  global.AudioContext = class { constructor() { this.state = 'suspended'; } async close() {} };
  media.audioModule = () => new Promise((resolve, reject) => { rejectModule = reject; });
  try {
    transport.localTracks.set('audio', { track: { enabled: true } });
    const starting = media.syncSource('audio'); const replacement = { track: { enabled: true }, active: true };
    media.sources.set('audio', replacement); rejectModule(new Error('Old module stopped')); await starting;
    assert.equal(media.sources.get('audio'), replacement); assert.equal(replacement.active, true);
  } finally { global.AudioContext = oldContext; media.close(); }
});
test('a failed preferred hardware backend retries explicit software when supported, otherwise default acceleration', async () => {
  const { RelayMedia } = await ready;
  const originalEncoder = global.VideoEncoder, originalDecoder = global.VideoDecoder, originalFrame = global.VideoFrame;
  const configurations = [], frameClones = [];
  global.VideoDecoder = class { static async isConfigSupported(config) { return { supported: true, config }; } };
  global.VideoFrame = class { constructor(frame) { this.displayWidth = frame.displayWidth; this.displayHeight = frame.displayHeight; this.closed = false; frameClones.push(this); } close() { this.closed = true; } };
  global.VideoEncoder = class {
    static async isConfigSupported(config) { return { supported: true, config }; }
    constructor(callbacks) { this.callbacks = callbacks; this.state = 'unconfigured'; this.encodeQueueSize = 0; }
    configure(config) { this.config = config; this.state = 'configured'; configurations.push(config); }
    encode() { if (this.config.hardwareAcceleration === 'prefer-hardware') queueMicrotask(() => this.callbacks.error(new Error('Fixture hardware backend unavailable'))); }
    close() { this.state = 'closed'; }
  };
  let media, softwareSupported = true;
  global.VideoEncoder.isConfigSupported = async config => ({ supported: config.hardwareAcceleration !== 'prefer-software' || softwareSupported, config });
  try {
    for (const support of [true, false]) {
    softwareSupported = support; const beforeConfigurations = configurations.length, beforeFrames = frameClones.length;
    const transport = rtc(); transport.quality = '1440'; media = new RelayMedia(transport, randomBytes(32).toString('base64url'));
    await media.capabilities; const peer = media.addPeer('guest'); peer.active = true;
    const track = { enabled: true }; transport.localTracks.set('screen', { track });
    const source = { track, active: true, targetFPS: 30, forceKey: true, sequence: 0, lastKey: 0, lastAdapt: performance.now() };
    media.sources.set('screen', source);
    const frame = new global.VideoFrame({ displayWidth: 2560, displayHeight: 1440 });
    await media.encodeCompressed(source, frame, 2560, 1440, 'avc1.420033', () => true); await Promise.resolve();
    assert.equal(source.encoder.state, 'closed'); assert.equal(source.failedHardware.has('avc1.420033'), true);
    assert.ok((await media.capabilities).includes('avc1.420033'), 'Hardware failure must preserve a possible default codec backend');
    await media.encodeCompressed(source, frame, 2560, 1440, 'avc1.420033', () => true);
    assert.deepEqual(configurations.slice(beforeConfigurations).map(config => config.hardwareAcceleration), ['prefer-hardware', support ? 'prefer-software' : 'no-preference']);
    assert.equal(frame.closed, false); assert.ok(frameClones.slice(beforeFrames + 1).every(clone => clone.closed));
    media.close(); media = null; frame.close();
    }
  } finally { media?.close(); global.VideoEncoder = originalEncoder; global.VideoDecoder = originalDecoder; global.VideoFrame = originalFrame; }
});
test('removing a peer while encryption is queued cannot forward encoded media', async () => {
  const { RelayMedia } = await ready; const transport = rtc(), media = new RelayMedia(transport, randomBytes(32).toString('base64url'));
  const peer = media.addPeer('guest'); peer.active = true;
  assert.equal(media.sendVideo('guest', { type: 'video-chunk', chunkType: 'key' }, new Uint8Array(160000)), true);
  media.removePeer('guest'); transport.peers.delete('guest'); await peer.sendQueue; assert.equal(transport.calls.length, 0); media.close();
});
test('four ordered input events survive a full media queue and the independent input ceiling fails closed', async () => {
  const { RelayMedia, RelayCipher } = await ready;
  const transport = rtc(), key = randomBytes(32).toString('base64url'), media = new RelayMedia(transport, key);
  const peer = media.addPeer('guest'); peer.active = true;
  const events = ['ShiftDown', 'KeyDown', 'KeyUp', 'ShiftUp'];
  for (let index = 0; index < 3; index++) assert.equal(media.send('guest', { type: 'audio', sampleRate: 24000 }, new Uint8Array(20)), true);
  for (const event of events) assert.equal(media.send('guest', { type: 'data', data: { type: 'input', event } }), true, event + ' must have its own bounded queue allowance');
  for (let index = 4; index < 16; index++) assert.equal(media.send('guest', { type: 'data', data: { type: 'input', index } }), true);
  assert.equal(media.send('guest', { type: 'data', data: { type: 'input', index: 16 } }), false);
  assert.equal(media.send('guest', { type: 'data', data: { type: 'input', payload: 'A'.repeat(4097) } }), false);
  await peer.sendQueue;
  const receiver = new RelayCipher(key, 'guest', 'owner'), decoded = [];
  for (const item of transport.calls) {
    const plain = await receiver.open(item.data.relay); assert.ok(plain);
    const length = new DataView(plain.buffer, plain.byteOffset, plain.byteLength).getUint16(0);
    decoded.push(JSON.parse(new TextDecoder().decode(plain.slice(2, length + 2))));
  }
  assert.deepEqual(decoded.filter(item => item.type === 'data').slice(0, 4).map(item => item.data.event), events);
  assert.equal(peer.pending, 0); assert.equal(peer.pendingData, 0);
  assert.equal(media.send('guest', { type: 'data', data: { type: 'input', event: 'late' } }), true);
  const sent = transport.calls.length; media.removePeer('guest'); transport.peers.delete('guest'); await peer.sendQueue;
  assert.equal(transport.calls.length, sent); receiver.close(); media.close();
});
test('an asynchronously refused encrypted input emits channel closure before another input can proceed', async () => {
  const { RelayMedia } = await ready;
  const transport = rtc(), emitted = []; transport.emit = (type, detail) => emitted.push({ type, detail }); transport.signal = () => false;
  const media = new RelayMedia(transport, randomBytes(32).toString('base64url')), peer = media.addPeer('guest'); peer.active = true;
  assert.equal(media.send('guest', { type: 'data', data: { type: 'input', event: { type: 'keyup' } } }), true);
  await peer.sendQueue;
  assert.deepEqual(emitted, [{ type: 'channel', detail: { peerId: 'guest', open: false } }]);
  assert.equal(media.send('guest', { type: 'data', data: { type: 'input', event: { type: 'keydown' } } }), false);
  assert.equal(peer.active, true, 'Control failure leaves media running'); media.close();
});
test('receive queue overflow revokes the input channel before discarding a possible release', async () => {
  const { RelayMedia, RelayCipher } = await ready;
  const transport = rtc(), emitted = []; transport.emit = (type, detail) => emitted.push({ type, detail });
  const key = randomBytes(32).toString('base64url'), media = new RelayMedia(transport, key), peer = media.addPeer('guest'); peer.active = true; peer.receiving = 32;
  const sender = new RelayCipher(key, 'guest', 'owner'); media.receive('guest', await sender.seal(new Uint8Array(4)));
  assert.deepEqual(emitted, [{ type: 'channel', detail: { peerId: 'guest', open: false } }]);
  assert.equal(peer.receiving, 32); assert.equal(peer.active, true); sender.close(); media.close();
});
test('async input encryption and forwarding exceptions revoke once, while stale failures after teardown cannot notify', async () => {
  const { RelayMedia } = await ready;
  for (const failure of ['seal-null', 'seal-throw', 'signal-throw', 'stale-seal-throw']) {
    const transport = rtc(), emitted = []; transport.emit = (type, detail) => emitted.push({ type, detail });
    const media = new RelayMedia(transport, randomBytes(32).toString('base64url')), peer = media.addPeer('guest'); peer.active = true;
    let started, reject; const pending = new Promise(resolve => { started = resolve; });
    if (failure === 'seal-null') peer.cipher.seal = async () => null;
    if (failure === 'seal-throw') peer.cipher.seal = async () => { throw new Error('Fixture encryption failed'); };
    if (failure === 'signal-throw') transport.signal = () => { throw new Error('Fixture forward failed'); };
    if (failure === 'stale-seal-throw') peer.cipher.seal = () => { started(); return new Promise((resolve, rejectFailure) => { reject = rejectFailure; }); };
    assert.equal(media.send('guest', { type: 'data', data: { type: 'input', event: { type: 'keyup' } } }), true);
    if (failure === 'stale-seal-throw') { await pending; media.removePeer('guest'); transport.peers.delete('guest'); reject(new Error('Old encryption failed')); }
    await peer.sendQueue;
    assert.deepEqual(emitted, failure === 'stale-seal-throw' ? [] : [{ type: 'channel', detail: { peerId: 'guest', open: false } }], failure);
    assert.equal(peer.pendingData, 0); media.close();
  }
});
test('a dynamic FPS reduction after long uptime resumes capture within the new frame interval', async () => {
  const { RelayMedia } = await ready;
  const oldPerformance = Object.getOwnPropertyDescriptor(global, 'performance'), oldProcessor = global.MediaStreamTrackProcessor;
  let now = 1000000, push, canceled = false; const encodedAt = [], closed = [];
  Object.defineProperty(global, 'performance', { configurable: true, value: { now: () => now } });
  global.MediaStreamTrackProcessor = class { constructor() { this.readable = { getReader: () => ({ read: () => new Promise(resolve => { push = resolve; }), cancel: async () => { canceled = true; push?.({ done: true }); } }) }; } };
  const transport = rtc(), media = new RelayMedia(transport, randomBytes(32).toString('base64url')), peer = media.addPeer('guest'); peer.active = true;
  const track = { enabled: true, clone: () => ({ stop: () => {} }) }; transport.localTracks.set('screen', { track });
  media.encodeVideo = async () => { encodedAt.push(now); };
  const settle = () => new Promise(resolve => setImmediate(resolve));
  const frame = async time => { now = time; push({ done: false, value: { close: () => closed.push(time) } }); await settle(); };
  try {
    await media.syncSource('screen'); await frame(1000000);
    media.sources.get('screen').targetFPS = 12;
    await frame(1000040); await frame(1000084);
    assert.deepEqual(encodedAt, [1000000, 1000084], 'FPS changes use elapsed time rather than a slot tied to the old absolute FPS');
    assert.equal(closed.length, 3, 'Dropped and encoded input frames are both released');
    media.sources.get('screen').targetFPS = 30; const initialCount = encodedAt.length;
    for (let index = 1; index <= 10; index++) await frame(1000084 + Math.floor(index / 2) * 66 + (index % 2 ? 32 : 0));
    assert.ok(encodedAt.length - initialCount >= 9, 'Alternating32/34ms source jitter must retain at least9of10frames rather than halve capture');
    media.sources.get('screen').targetFPS = 27; const beforeAdapted = encodedAt.length;
    for (let index = 1; index <= 90; index++) await frame(1000414 + index * 1000 / 30);
    assert.equal(encodedAt.length - beforeAdapted, 81, '30fps source paced to27fps must preserve fractional deadlines instead of quantizing to15fps');
    const beforeQuiet = encodedAt.length; await frame(2000000); await frame(2000010);
    assert.equal(encodedAt.length - beforeQuiet, 1, 'A source returning late cannot catch up with a burst');
  } finally { media.close(); await settle(); assert.equal(canceled, true); global.MediaStreamTrackProcessor = oldProcessor; Object.defineProperty(global, 'performance', oldPerformance); }
});
test('a stalled encoder downgrades hardware then retires the stalled default codec without misclassifying quiet or congested sources', async () => {
  const { RelayMedia } = await ready;
  const oldPerformance = Object.getOwnPropertyDescriptor(global, 'performance'), oldEncoder = global.VideoEncoder, oldDecoder = global.VideoDecoder, oldFrame = global.VideoFrame;
  let now = 10000; const encoders = [], frameClones = [];
  Object.defineProperty(global, 'performance', { configurable: true, value: { now: () => now } });
  global.VideoDecoder = class { static async isConfigSupported(config) { return { supported: true, config }; } };
  global.VideoFrame = class { constructor(frame) { this.displayWidth = frame.displayWidth; this.displayHeight = frame.displayHeight; this.closed = false; frameClones.push(this); } close() { this.closed = true; } };
  global.VideoEncoder = class {
    static async isConfigSupported(config) { return { supported: true, config }; }
    constructor() { this.state = 'unconfigured'; this.encodeQueueSize = 0; encoders.push(this); }
    configure(config) { this.config = config; this.state = 'configured'; }
    encode() { this.encodeQueueSize++; } // A native backend accepts but never outputs.
    close() { this.state = 'closed'; }
  };
  let media;
  try {
    const transport = rtc(); transport.quality = '1440'; media = new RelayMedia(transport, randomBytes(32).toString('base64url'));
    await media.capabilities; const peer = media.addPeer('guest'); peer.active = true;
    const track = { enabled: true }; transport.localTracks.set('screen', { track });
    const source = { track, active: true, targetFPS: 30, forceKey: true, sequence: 0, lastKey: 0, lastAdapt: now }; media.sources.set('screen', source);
    const frame = new global.VideoFrame({ displayWidth: 2560, displayHeight: 1440 });
    const encode = async time => { now = time; await media.encodeCompressed(source, frame, 2560, 1440, 'avc1.420033', () => true); };
    await encode(10000); await encode(10040); assert.equal(encoders[0].encodeQueueSize, 2);
    await encode(18000); assert.equal(encoders[0].state, 'configured', 'A quiet source returning after seconds cannot cause an immediate backend downgrade');
    for (let time = 18300; time <= 19800; time += 300) await encode(time);
    assert.equal(encoders[0].state, 'closed'); assert.equal(source.failedHardware.has('avc1.420033'), true);
    await encode(19840); assert.equal(encoders[1].config.hardwareAcceleration, 'prefer-software'); await encode(19880);
    for (let time = 20180; time <= 21980; time += 300) await encode(time);
    assert.equal(encoders[1].state, 'closed'); assert.equal(source.failedSoftware.has('avc1.420033'), true);
    await encode(22020); assert.equal(encoders[2].config.hardwareAcceleration, 'no-preference'); await encode(22060);
    for (let time = 22360; time <= 24160; time += 300) await encode(time);
    assert.equal(encoders[2].state, 'closed'); assert.ok(!(await media.capabilities).includes('avc1.420033'));
    assert.equal(frame.closed, false); assert.ok(frameClones.slice(1).every(clone => clone.closed));
    // Pending encryption/forwarding with an empty encoder queue is not a native codec stall.
    const active = { state: 'configured', encodeQueueSize: 0, close: () => { throw new Error('Network congestion must not close the encoder'); } };
    source.encoder = active; peer.pendingVideo = 2; now = 40000;
    await media.encodeCompressed(source, frame, 2560, 1440, 'vp8', () => true); assert.equal(source.encoder, active);
    media.sources.delete('screen');
  } finally { media?.close(); global.VideoEncoder = oldEncoder; global.VideoDecoder = oldDecoder; global.VideoFrame = oldFrame; Object.defineProperty(global, 'performance', oldPerformance); }
});
