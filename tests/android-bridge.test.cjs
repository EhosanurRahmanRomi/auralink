'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../src/renderer/android-bridge.js'), 'utf8');
const flush = () => new Promise(resolve => setImmediate(resolve));

function setup({ android = true, existing, reject } = {}) {
  const messages = [];
  const window = existing ? { auralink: existing } : {};
  if (android) window.AuralinkNative = { postMessage(raw) {
    const message = JSON.parse(raw); messages.push(message);
    queueMicrotask(() => window.__auralinkNativeReceive?.(JSON.stringify({ requestId: message.requestId,
      ok: !reject?.(message), result: message.method === 'getInfo' ? { platform: 'android', nativeControl: false } : { ok: true },
      error: 'Native permission declined.' })));
  } };
  vm.runInNewContext(source, { window, EventTarget, Event, MessageEvent, DOMException, TextEncoder, URL, setTimeout, clearTimeout, queueMicrotask });
  return { window, messages, bridge: window.auralink, receive: data => window.__auralinkNativeReceive(JSON.stringify(data)) };
}

test('ordinary browser and Electron retain their original transport and privileged API', () => {
  assert.equal(setup({ android: false }).bridge, undefined);
  const desktop = { platform: 'win32', hostRoom: () => {} };
  assert.equal(setup({ existing: desktop }).bridge, desktop);
});

test('Android bridge exposes attended screen/input RPCs without desktop room hosting', async () => {
  const { bridge, messages } = setup({ reject: message => message.method === 'copyText' });
  assert.equal(bridge.platform, 'android');
  for (const unavailable of ['hostRoom', 'sources', 'chooseScreen']) assert.equal(bridge[unavailable], undefined);
  for (const available of ['startScreenShare','stopScreenShare','ackScreenFrame','grantControl','applyInput','revokeControl','setAudioRoute']) assert.equal(typeof bridge[available], 'function');
  const info = await bridge.getInfo(); assert.equal(info.platform, 'android'); assert.equal(info.nativeControl, false);
  const invitation = 'https://192.168.1.2:4443/#key=test&fp=test';
  await bridge.trustInvite(invitation);
  assert.equal(messages.find(message => message.method === 'trustInvite').args, invitation);
  await assert.rejects(bridge.copyText('hello'), /declined/);
  await assert.rejects(bridge.trustInvite('x'.repeat(4097)), /Invalid room invitation/);
});

test('Android capture events reject oversized, malformed and replayed frames and support unsubscribe', async () => {
  const { bridge, receive, messages } = setup();
  const frames = []; const stops = [];
  const remove = bridge.onScreenFrame(frame => frames.push(frame.seq));
  const removeStop = bridge.onScreenStopped(reason => stops.push(reason));
  const frame = {event:'screen',type:'frame',seq:1,width:720,height:1280,data:'data:image/jpeg;base64,YQ=='};
  receive(frame); receive(frame);
  receive({...frame,seq:2,width:2048}); receive({...frame,seq:3,data:'javascript:bad'});
  receive({...frame,seq:4,data:'data:image/jpeg;base64,'+'a'.repeat(4000000)});
  assert.deepEqual(frames,[1]);
  await bridge.ackScreenFrame({seq:1});
  assert.equal(messages.at(-1).method,'ackScreenFrame');
  receive({event:'screen',type:'stopped',reason:'Owner stopped sharing.'});
  assert.deepEqual(stops,['Owner stopped sharing.']);
  receive({...frame,seq:0}); assert.deepEqual(frames,[1,0]);
  remove(); removeStop(); receive({...frame,seq:5});
  receive({event:'screen',type:'stopped'}); assert.deepEqual(frames,[1,0]); assert.equal(stops.length,1);
  await bridge.setAudioRoute({active:true,speaker:true});
  assert.deepEqual({...messages.at(-1).args},{active:true,speaker:true});
});

test('pinned native signaling preserves WebSocket event order and ignores stale traffic after close', async () => {
  const { bridge, receive, messages } = setup();
  for (const url of ['ws://host/ws', 'wss://host/other', 'wss://host/ws?key=secret', 'wss://user:pass@host/ws']) assert.throws(() => bridge.createSocket(url), /pinned HTTPS/);
  const socket = bridge.createSocket('wss://192.168.1.2:4443/ws');
  const events = [];
  for (const type of ['open', 'message', 'error', 'close']) socket.addEventListener(type, event => events.push({ type, data: event.data, code: event.code }));
  assert.equal(socket.readyState, 0); assert.throws(() => socket.send('{}'), /not open/);
  await flush();
  const socketId = messages.find(message => message.method === 'openSocket').args.socketId;
  receive({ event: 'socket', socketId, type: 'open' });
  assert.equal(socket.readyState, 1); socket.send('{"type":"join"}'); await flush();
  assert.equal(messages.find(message => message.method === 'sendSocket').args.data, '{"type":"join"}');
  assert.throws(() => socket.send('x'.repeat(65537)), /64 KB/);
  receive({ event: 'socket', socketId, type: 'message', data: '{"type":"pending"}' });
  socket.close(); assert.equal(socket.readyState, 2);
  receive({ event: 'socket', socketId, type: 'open' }); assert.equal(socket.readyState, 2);
  receive({ event: 'socket', socketId, type: 'message', data: 'late' });
  receive({ event: 'socket', socketId, type: 'close', code: 1000, reason: 'Closed.' });
  receive({ event: 'socket', socketId, type: 'open' });
  assert.equal(socket.readyState, 3);
  assert.deepEqual(events.map(event => event.type), ['open', 'message', 'close']);
  assert.equal(events[1].data, '{"type":"pending"}');
  await flush();
});

test('native TLS/signaling failures and lifecycle stops close every room socket', async () => {
  const { bridge, receive, messages } = setup();
  const socket = bridge.createSocket('wss://host:4443/ws'); const events = [];
  socket.addEventListener('error', () => events.push('error')); socket.addEventListener('close', () => events.push('close'));
  await flush(); const socketId = messages.find(message => message.method === 'openSocket').args.socketId;
  receive({ event: 'socket', socketId, type: 'error', message: 'Certificate fingerprint mismatch.' });
  assert.equal(socket.readyState, 3); assert.deepEqual(events, ['error', 'close']);
  await flush();
  const second = bridge.createSocket('wss://host:4443/ws'); await flush();
  let stopped = 0; const remove = bridge.onSessionStop(() => stopped++);
  receive({ event: 'session-stop', reason: 'App backgrounded.' });
  assert.equal(second.readyState, 3); assert.equal(stopped, 1);
  remove(); await flush();
  receive({ event: 'session-resume' });
  const third = bridge.createSocket('wss://host:4443/ws'); await flush();
  assert.equal(third.readyState, 0);
  third.close(); receive({ event: 'socket', socketId: third.id, type: 'close', code: 1000 }); await flush();
});
