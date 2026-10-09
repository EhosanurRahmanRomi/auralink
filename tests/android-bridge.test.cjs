'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../src/renderer/android-bridge.js'), 'utf8');
const flush = () => new Promise(resolve => setImmediate(resolve));

function setup({ android = true, existing, reject, response } = {}) {
  const messages = [];
  const window = existing ? { glancePort: existing } : {};
  if (android) window.GlancePortNative = { postMessage(raw) {
    const message = JSON.parse(raw); messages.push(message);
    queueMicrotask(() => window.__glancePortNativeReceive?.(JSON.stringify({ requestId: message.requestId,
      ok: !reject?.(message), result: response ? response(message) : message.method === 'getInfo' ? { platform: 'android', nativeControl: false } : { ok: true },
      error: 'Native permission declined.' })));
  } };
  vm.runInNewContext(source, { window, EventTarget, Event, MessageEvent, DOMException, TextEncoder, URL, atob, setTimeout, clearTimeout, queueMicrotask });
  return { window, messages, bridge: window.glancePort, receive: data => window.__glancePortNativeReceive(JSON.stringify(data)) };
}

test('ordinary browser and Electron retain their original transport and privileged API', () => {
  assert.equal(setup({ android: false }).bridge, undefined);
  const desktop = { platform: 'win32', hostRoom: () => {} };
  assert.equal(setup({ existing: desktop }).bridge, desktop);
});
test('device audio requires an active exact projection and remains separate from microphone routing', async () => {
  const {bridge,messages,receive}=setup({response:message=>message.method==='startScreenShare'?{captureId:'current-screen'}:{ok:true}});
  for(const args of [{enabled:true,captureId:'missing'},{enabled:'true',captureId:'current-screen'},null]) await assert.rejects(bridge.setSystemAudio(args),/owner-approved/);
  assert.equal(messages.length,0);
  await bridge.startScreenShare({quality:'720p'});await bridge.setSystemAudio({enabled:true,captureId:'current-screen'});
  assert.deepEqual(messages.map(item=>item.method),['startScreenShare','setSystemAudio']);
  receive({event:'screen',type:'stopped',captureId:'current-screen'});
  await assert.rejects(bridge.setSystemAudio({enabled:true,captureId:'current-screen'}),/owner-approved/);
  assert.equal(messages.some(item=>item.method==='setAudioRoute'||item.method==='grantControl'),false);
});
test('live screen quality uses only supported ceilings and the exact active capture without restarting media', async () => {
  const {bridge,messages,receive}=setup({response:message=>message.method==='startScreenShare'?{captureId:'owned-screen'}:{ok:true,width:720,height:1280,maxEdge:1280,fps:12}});
  for(const args of [null,{captureId:'owned-screen',quality:'720p'}]) await assert.rejects(bridge.setScreenQuality(args),/owner-approved/);
  assert.equal(messages.length,0);
  await bridge.startScreenShare({quality:'720p'});
  for(const args of [{captureId:'stale-screen',quality:'1080p'},{captureId:'owned-screen',quality:'1440p'},{captureId:'owned-screen',quality:'auto'},{captureId:'owned-screen',quality:720}])
    await assert.rejects(bridge.setScreenQuality(args),/owner-approved/);
  assert.equal(messages.length,1,'Malformed or stale requests never reach the native capture');
  const result=await bridge.setScreenQuality({captureId:'owned-screen',quality:'1080p',untrusted:'discarded'});
  assert.equal(result.ok,true);
  assert.deepEqual({...messages.at(-1).args},{captureId:'owned-screen',quality:'1080p'});
  await bridge.setScreenQuality({captureId:'owned-screen',quality:'720p'});
  assert.deepEqual(messages.map(message=>message.method),['startScreenShare','setScreenQuality','setScreenQuality']);
  receive({event:'screen',type:'stopped',captureId:'owned-screen'});
  await assert.rejects(bridge.setScreenQuality({captureId:'owned-screen',quality:'1080p'}),/owner-approved/);
});
test('native refusal of live screen quality is surfaced without authorizing other media', async () => {
  const {bridge,messages}=setup({response:message=>message.method==='startScreenShare'?{captureId:'owned-screen'}:{ok:false,reason:'That screen share ended.'}});
  await bridge.startScreenShare({});
  await assert.rejects(bridge.setScreenQuality({captureId:'owned-screen',quality:'720p'}),/screen share ended/);
  assert.deepEqual(messages.map(message=>message.method),['startScreenShare','setScreenQuality']);
});
test('device PCM accepts only bounded 48 kHz stereo packets and acknowledges even a failing consumer', async () => {
  const {bridge,messages,receive}=setup({response:message=>message.method==='startScreenShare'?{captureId:'screen-a'}:{ok:true}});
  await bridge.startScreenShare({});await bridge.setSystemAudio({enabled:true,captureId:'screen-a'});
  const accepted=[];const remove=bridge.onSystemAudio(chunk=>accepted.push(chunk.seq));const removeThrowing=bridge.onSystemAudio(()=>{throw new Error('Fixture consumer failed');});
  const frame={event:'system-audio',type:'chunk',captureId:'screen-a',seq:1,frames:1920,sampleRate:48000,channels:2,data:'A'.repeat(10240)};
  for(const invalid of [{...frame,captureId:'old-screen'},{...frame,channels:1},{...frame,sampleRate:24000},{...frame,frames:1921},{...frame,data:'A'.repeat(10241)},{...frame,seq:NaN},{...frame,data:'$'.repeat(10240)}])receive(invalid);
  assert.equal(accepted.length,0);receive(frame);receive(frame);await flush();assert.deepEqual(accepted,[1]);
  const ack=messages.filter(item=>item.method==='ackSystemAudio');assert.equal(ack.length,1);assert.equal(ack[0].args.captureId,'screen-a');assert.equal(ack[0].args.seq,1);
  remove();removeThrowing();receive({...frame,seq:2});await flush();assert.deepEqual(accepted,[1]);assert.equal(messages.filter(item=>item.method==='ackSystemAudio').length,2,'Unsubscribed valid packets still release the single bounded native slot');
  await bridge.setSystemAudio({enabled:false,captureId:'screen-a'});receive({...frame,seq:3});await flush();assert.equal(messages.filter(item=>item.method==='ackSystemAudio').length,2);
});
test('old projection audio cannot enter a replacement room or revive after native session stop', async () => {
  let capture='first';const {bridge,receive,messages}=setup({response:message=>message.method==='startScreenShare'?{captureId:capture}:{ok:true}});
  const chunks=[];bridge.onSystemAudio(value=>chunks.push(value.seq));await bridge.startScreenShare({});await bridge.setSystemAudio({enabled:true,captureId:'first'});
  capture='second';await bridge.startScreenShare({});await bridge.setSystemAudio({enabled:true,captureId:'second'});
  const frame={event:'system-audio',type:'chunk',captureId:'first',seq:3,frames:1920,sampleRate:48000,channels:2,data:'A'.repeat(10240)};receive(frame);receive({...frame,captureId:'second'});await flush();assert.deepEqual(chunks,[3]);
  receive({event:'session-stop'});receive({...frame,captureId:'second',seq:4});await flush();assert.deepEqual(chunks,[3]);assert.equal(messages.filter(item=>item.method==='ackSystemAudio').length,1);
});

test('Android presentation fullscreen accepts only booleans and leaves media and control untouched', async () => {
  const { bridge, messages } = setup({ response: message => ({ fullscreen: message.args }) });
  for (const value of [undefined, null, 'true', 'false', 0, 1, {}, [], new Boolean(true)]) {
    await assert.rejects(bridge.setPresentationFullscreen(value), /Invalid fullscreen state/);
  }
  assert.equal(messages.length, 0, 'Invalid fullscreen values never cross the native bridge');
  assert.equal((await bridge.setPresentationFullscreen(true)).fullscreen, true);
  assert.equal((await bridge.setPresentationFullscreen(false)).fullscreen, false);
  assert.deepEqual(messages.map(({ method, args }) => ({ method, args })), [
    { method: 'setPresentationFullscreen', args: true },
    { method: 'setPresentationFullscreen', args: false },
  ], 'Entering presentation cannot start screen capture, microphone routing or input consent');
});

test('Android presentation state rejects malformed native events and honors unsubscribe', () => {
  const { bridge, receive, messages } = setup();
  const states = [];
  const removeThrowing = bridge.onPresentationFullscreenChanged(() => { throw new Error('Consumer failed'); });
  const remove = bridge.onPresentationFullscreenChanged(state => {
    assert.deepEqual(Object.keys(state), ['fullscreen'], 'Only the native boolean state is exposed');
    states.push(state.fullscreen);
  });
  const removeInvalid = bridge.onPresentationFullscreenChanged(null); assert.equal(typeof removeInvalid, 'function'); removeInvalid();
  for (const value of [undefined, null, 'true', 'false', 0, 1, {}, []]) receive({ event: 'presentation-fullscreen', fullscreen: value });
  receive({ event: 'fullscreen', fullscreen: true });
  assert.deepEqual(states, []);
  receive({ event: 'presentation-fullscreen', fullscreen: true, unexpected: 'discarded' });
  receive({ event: 'presentation-fullscreen', fullscreen: false });
  assert.deepEqual(states, [true, false], 'One failing subscriber cannot swallow confirmed native transitions');
  remove(); remove(); removeThrowing();
  receive({ event: 'presentation-fullscreen', fullscreen: true });
  assert.deepEqual(states, [true, false]);
  assert.equal(messages.length, 0, 'Passive native state observation never triggers another fullscreen or media action');
});

test('Android invitations use an explicit one-shot RPC and bounded live callback without media actions', async () => {
  const code = `A1.89bf3734-2920-41c1-bbce-439085f9037e.${'A'.repeat(43)}`;
  const { bridge, receive, messages } = setup({ response: message => message.method === 'getPendingInvitation' ? code : { ok: true } });
  const invitations = []; const remove = bridge.onInvitation(value => invitations.push(value));
  assert.equal(await bridge.getPendingInvitation(), code);
  assert.deepEqual(messages.map(message => message.method), ['getPendingInvitation']);
  receive({ event: 'app-invitation', code });
  receive({ event: 'app-invitation', code: 'https://example.com/' });
  receive({ event: 'app-invitation', code: code + '.extra' });
  assert.deepEqual(invitations, [code]);
  remove(); receive({ event: 'app-invitation', code }); assert.equal(invitations.length, 1);
  assert.deepEqual(messages.map(message => message.method), ['getPendingInvitation']);
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

test('closing the idle Internet socket posts native release before Nearby trust', async () => {
  const { bridge, receive, messages } = setup();
  const socket = bridge.createInternetSocket('wss://service.example/internet/ws'); await flush();
  receive({ event: 'socket', socketId: socket.id, type: 'open' });
  socket.close();
  await bridge.trustInvite('https://192.168.1.2:4443/#key=fixture&fp=fixture');
  assert.deepEqual(messages.map(message => message.method), ['openSocket', 'closeSocket', 'trustInvite'], 'Release and trust must reach the same native main-thread queue in order');
  receive({ event: 'socket', socketId: socket.id, type: 'close', code: 1000 });
  assert.equal(socket.readyState, 3); await flush();
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

test('Android capture cleanup preserves the opaque native session identifier', async () => {
  const { bridge, receive, messages } = setup();
  const captureId = 'capture-session-owned-by-native';
  await bridge.stopScreenShare({ captureId });
  assert.deepEqual({ ...messages.at(-1).args }, { captureId });
  await bridge.stopSharing({ captureId });
  assert.deepEqual({ ...messages.at(-1).args }, { captureId });
  await bridge.ackScreenFrame({ seq: 7, captureId });
  assert.deepEqual({ ...messages.at(-1).args }, { seq: 7, captureId });
  const stopped = [];
  bridge.onScreenStopped((reason, capture) => stopped.push({ reason, captureId: capture.captureId }));
  receive({ event: 'screen', type: 'stopped', reason: 'Owner stopped sharing.', captureId });
  assert.deepEqual(stopped, [{ reason: 'Owner stopped sharing.', captureId }]);
});

test('Android audio focus and route refusals reject instead of pretending the speaker is active', async () => {
  let available = false;
  const { bridge, messages } = setup({ response: message => message.method === 'setAudioRoute' ?
    { ok: available, reason: 'Android could not select the call speaker.' } : { ok: true } });
  await assert.rejects(bridge.setAudioRoute({ active: true, speaker: true }), /could not select the call speaker/);
  available = true;
  assert.equal((await bridge.setAudioRoute({ active: true, speaker: true })).ok, true);
  assert.deepEqual(messages.map(message => message.method), ['setAudioRoute', 'setAudioRoute']);
});

test('old Android projection events cannot poison or stop a replacement capture', async () => {
  let captureId = 'old-native-capture';
  const { bridge, receive } = setup({ response: message => message.method === 'startScreenShare' ? { captureId } : { ok: true } });
  const frames = [], stops = [];
  bridge.onScreenFrame(frame => frames.push([frame.captureId, frame.seq]));
  bridge.onScreenStopped(reason => stops.push(reason));
  const frame = { event: 'screen', type: 'frame', width: 720, height: 1280, data: 'data:image/jpeg;base64,YQ==' };
  await bridge.startScreenShare({});
  receive({ ...frame, captureId, seq: 1 });
  captureId = 'new-native-capture';
  await bridge.startScreenShare({});
  receive({ ...frame, captureId, seq: 1 });
  receive({ ...frame, captureId: 'old-native-capture', seq: 500 });
  receive({ event: 'screen', type: 'stopped', captureId: 'old-native-capture', reason: 'Old share stopped.' });
  receive({ ...frame, captureId, seq: 1 });
  receive({ ...frame, captureId, seq: 2 });
  assert.deepEqual(frames, [['old-native-capture', 1], ['new-native-capture', 1], ['new-native-capture', 2]]);
  assert.deepEqual(stops, []);
});

test('Internet service trust is explicit and accepts only a clean HTTPS origin', async () => {
  const { bridge, messages } = setup();
  for (const address of ['http://service.example', 'https://user:pass@service.example', 'https://service.example/internet/ws',
    'https://service.example/?token=secret', 'https://service.example/#fp=anything', 'https://service.example/?',
    'https://service.example/#', 'https://service.example/a/..', 'https://service.example\\other',
    'https://service.example\n', 'https://service.example/' + 'x'.repeat(2048)]) {
    await assert.rejects(bridge.trustInternetService(address), /Internet service|HTTPS root|Invalid URL/);
  }
  assert.equal(messages.length, 0, 'Invalid Internet addresses never reach the native bridge');
  await bridge.trustInternetService('HTTPS://SERVICE.EXAMPLE:443/');
  assert.equal(messages[0].method, 'trustInternetService');
  assert.equal(messages[0].args, 'https://service.example');
  assert.throws(() => bridge.createInternetSocket('wss://service.example/ws'), /Internet service socket/);
  const socket = bridge.createInternetSocket('wss://service.example/internet/ws');
  await flush();
  assert.equal(messages.at(-1).method, 'openSocket');
  assert.equal(messages.at(-1).args.url, 'wss://service.example/internet/ws');
  socket.close(); await flush();
});

test('native refusal of an unverified Internet socket prevents registration credentials from being sent', async () => {
  const { bridge, messages } = setup({ reject: message => message.method === 'openSocket' });
  const socket = bridge.createInternetSocket('wss://unverified.example/internet/ws');
  const events = [];
  socket.addEventListener('error', () => events.push('error'));
  socket.addEventListener('close', () => events.push('close'));
  await flush();
  assert.equal(socket.readyState, 3);
  assert.deepEqual(events, ['error', 'close']);
  assert.throws(() => socket.send('{"type":"register","deviceToken":"secret"}'), /not open/);
  assert.ok(!messages.some(message => message.method === 'sendSocket'));
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

test('only exact bounded encrypted Internet relay signals may exceed the normal native bridge size', async () => {
  const { bridge, receive, messages } = setup();
  const relay = { version: 1, epoch: 'a'.repeat(16), counter: 1, nonce: 'b'.repeat(16), ciphertext: Buffer.alloc(80000, 7).toString('base64url') };
  const packet = { type: 'signal', to: 'room-peer', data: { relay } }; const raw = JSON.stringify(packet);
  const socket = bridge.createInternetSocket('wss://service.example/internet/ws'); await flush(); receive({ event: 'socket', socketId: socket.id, type: 'open' });
  const received = []; socket.addEventListener('message', event => received.push(event.data));
  socket.send(raw); await flush(); assert.equal(messages.find(message => message.method === 'sendSocket').args.data, raw);
  for (const invalid of [{ ...packet, extra: true }, { ...packet, type: 'join' }, { ...packet, data: { relay, description: 'not-relay' } }, { ...packet, data: { relay: { ...relay, counter: 0 } } }, { ...packet, data: { relay: { ...relay, plaintext: 'forbidden' } } }, { ...packet, data: { relay: { ...relay, ciphertext: Buffer.alloc(180001).toString('base64url') } } }]) assert.throws(() => socket.send(JSON.stringify(invalid)), /64 KB/);
  const incoming = JSON.stringify({ type: 'signal', from: 'room-peer', data: { relay } });
  receive({ event: 'socket', socketId: socket.id, type: 'message', data: incoming });
  receive({ event: 'socket', socketId: socket.id, type: 'message', data: JSON.stringify({ type: 'signal', from: 'room-peer', data: { relay, screen: true } }) });
  assert.deepEqual(received, [incoming]);
  const nearby = bridge.createSocket('wss://host.example/ws'); await flush(); receive({ event: 'socket', socketId: nearby.id, type: 'open' });
  assert.throws(() => nearby.send(raw), /64 KB/);
  socket.close(); nearby.close(); receive({ event: 'socket', socketId: socket.id, type: 'close' }); receive({ event: 'socket', socketId: nearby.id, type: 'close' }); await flush();
});
