'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function processors(sampleRate = 24000) {
  const registered = new Map();
  class AudioWorkletProcessor { constructor() { this.port = { messages: [], postMessage(message) { this.messages.push(message); } }; } }
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/renderer/audio-worklet.js'), 'utf8'),
    { AudioWorkletProcessor, sampleRate, Int16Array, ArrayBuffer, Math, Number, registerProcessor: (name, Processor) => registered.set(name, Processor) });
  return registered;
}

test('captured PCM reports actual sample energy and never monitors the microphone locally', () => {
  const Capture = processors().get('auralink-relay-capture'); const capture = new Capture();
  const input = new Float32Array(4800).fill(.5); const output = new Float32Array(4800).fill(1);
  assert.equal(capture.process([[input]], [[output]]), true);
  const message = capture.port.messages[0]; assert.equal(message.sampleRate, 24000);
  assert.equal(message.sampleCount, 4800); assert.equal(message.meanSquareEnergy, .25);
  assert.equal(new Int16Array(message.buffer)[0], 16384); assert.equal(output.every(sample => sample === 0), true);
});

test('capture energy resets per packet and includes only finite clipped input samples', () => {
  const Capture = processors(48000).get('auralink-relay-capture'); const capture = new Capture();
  const clipping = new Float32Array(9600).fill(2); capture.process([[clipping]], []);
  const silence = new Float32Array(9600); silence[0] = NaN; silence[1] = Infinity; capture.process([[silence]], []);
  assert.equal(capture.port.messages[0].meanSquareEnergy, 1); assert.equal(capture.port.messages[1].meanSquareEnergy, 0);
  assert.equal(new Int16Array(capture.port.messages[1].buffer).every(sample => sample === 0), true);
});
test('40 ms high-quality PCM preserves distinct stereo channels and bounded packet size',()=>{
  const Capture=processors(48000).get('auralink-relay-capture');const capture=new Capture({processorOptions:{channels:2,frameMillis:40}});
  const left=new Float32Array(1920).fill(.25),right=new Float32Array(1920).fill(-.5);capture.process([[left,right]],[]);
  const message=capture.port.messages[0];assert.equal(message.channels,2);assert.equal(message.frames,1920);assert.equal(message.buffer.byteLength,7680);assert.equal(message.meanSquareEnergy,.15625);
  const samples=new Int16Array(message.buffer);assert.equal(samples[0],8192);assert.equal(samples[1],-16383);assert.equal(samples[3839],-16383);
  const Playback=processors(48000).get('auralink-relay-playback');const playback=new Playback();playback.port.onmessage({data:{buffer:message.buffer,channels:2}});const outLeft=new Float32Array(1920),outRight=new Float32Array(1920);playback.process([],[[outLeft,outRight]]);assert.equal(outLeft[0],.25);assert.equal(outRight[0],-16383/32768);assert.equal(playback.queue.length,0);
});

test('invalid PCM cannot terminate the output processor or prevent the next valid packet', () => {
  const Playback = processors().get('auralink-relay-playback'); const playback = new Playback();
  for (const buffer of [new ArrayBuffer(0), new ArrayBuffer(3), new ArrayBuffer(24002)]) assert.doesNotThrow(() => playback.port.onmessage({ data: { buffer } }));
  assert.equal(playback.queue.length, 0);
  const samples = new Int16Array([16384, -16384]); playback.port.onmessage({ data: { buffer: samples.buffer } });
  const output = new Float32Array(3); assert.equal(playback.process([], [[output]]), true);
  assert.deepEqual([...output], [.5, -.5, 0]);
});

test('playback drops the oldest buffered PCM on congestion and stops without residual samples', () => {
  const Playback = processors().get('auralink-relay-playback'); const playback = new Playback();
  for (const value of [1000, 2000, 3000, 4000]) playback.port.onmessage({ data: { buffer: new Int16Array([value]).buffer } });
  assert.equal(playback.queue.length, 3); const output = new Float32Array(3); playback.process([], [[output]]);
  assert.deepEqual([...output], [2000, 3000, 4000].map(value => value / 32768));
  playback.port.onmessage({ data: 'stop' }); assert.equal(playback.process([], [[output]]), false); assert.equal(playback.queue.length, 0);
});
