'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');
const { EventEmitter } = require('node:events');

const defer = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function fixture(options = {}) {
  const handlers = new Map(); let window; let permissionRequest, permissionCheck, displayRequest; let revocations = 0;
  const displayEvents = new EventEmitter();
  class Window extends EventEmitter {
    constructor() { super(); window = this; this.webContents = new EventEmitter(); this.webContents.mainFrame = { url: pathToFileURL(path.resolve(__dirname, '../src/renderer/index.html')).href }; this.webContents.getURL = () => this.webContents.mainFrame.url; this.webContents.setWindowOpenHandler = () => {}; this.webContents.send = () => {}; }
    isDestroyed() { return false; } show() {} async loadFile() {}
  }
  const app = new EventEmitter(); app.setName = () => {}; app.whenReady = () => Promise.resolve(); app.getVersion = () => '0.3.0';
  const session = { defaultSession: { setCertificateVerifyProc() {}, setPermissionRequestHandler(handler) { permissionRequest = handler; }, setPermissionCheckHandler(handler) { permissionCheck = handler; }, setDisplayMediaRequestHandler(handler) { displayRequest = handler; } } };
  const electron = { app, BrowserWindow: Window, ipcMain: { handle(name, handler) { handlers.set(name, handler); } }, session,
    desktopCapturer: { getSources: options.sources || (async () => []) }, screen: displayEvents, dialog: {}, globalShortcut: { register() {}, unregisterAll() {} }, clipboard: {}, systemPreferences: { getMediaAccessStatus: () => 'granted', ...options.systemPreferences }, shell: {} };
  class Gate { async revoke() { revocations++; } }
  const mainFile = path.resolve(__dirname, '../src/main.cjs');
  const dependencies = {
    electron, selfsigned: { generate: options.generate || (async () => ({ private: 'fixture-key', cert: 'fixture-cert' })) },
    './core/invite.cjs': { fingerprint: () => 'a'.repeat(64) },
    './core/broker.cjs': { createBroker: options.createBroker || (async () => ({ port: 4459, roomKey: 'k'.repeat(32), hostToken: 'h'.repeat(32), async stop() {} })) },
    './native/control.cjs': { ControlGate: Gate, createAdapter: () => ({ available: false }) },
    './core/internet-client.cjs': {},
    './core/app-invitation.cjs': require('../src/core/app-invitation.cjs'),
  };
  vm.runInNewContext(fs.readFileSync(mainFile, 'utf8'), { require: name => Object.hasOwn(dependencies, name) ? dependencies[name] : require(name), __dirname: path.dirname(mainFile), process: { ...process, platform: options.platform || process.platform }, URL, Map, Set, Date, String, Number, Boolean }, { filename: mainFile });
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(window, 'Production native IPC registered');
  return {
    invoke(name, args) { return handlers.get(`auralink:${name}`)({ sender: window.webContents, senderFrame: window.webContents.mainFrame }, args); },
    permission(mediaTypes, isMainFrame=true) { return new Promise(resolve => permissionRequest(window.webContents, 'media', resolve, { mediaTypes, isMainFrame })); },
    capture() { return new Promise(resolve => displayRequest({frame:window.webContents.mainFrame},resolve)); },
    checkCamera() { return permissionCheck(window.webContents, 'media', '', { mediaType: 'video', isMainFrame: true }); },
    displayEvents, revocations: () => revocations
  };
}

test('canceling native host preparation prevents late certificate work from opening a room', async () => {
  const pending = defer(); let generated = 0, opened = 0;
  const native = await fixture({ generate: () => ++generated === 1 ? pending.promise : Promise.resolve({ private: 'key', cert: 'cert' }), createBroker: async () => { opened++; return { port: 4459, roomKey: 'r', hostToken: 'h', async stop() {} }; } });
  const oldRoom = native.invoke('host', { name: 'Canceled' }); const rejected = assert.rejects(oldRoom, /canceled/);
  await new Promise(resolve => setImmediate(resolve));
  await native.invoke('stop'); const replacement = await native.invoke('host', { name: 'Replacement' });
  pending.resolve({ private: 'old-key', cert: 'old-cert' }); await rejected;
  assert.equal(replacement.name, 'Replacement'); assert.equal(opened, 1);
});

test('a broker finishing after cancellation is stopped without replacing the active room', async () => {
  const pending = defer(); let opened = 0, staleStopped = 0, currentStopped = 0;
  const native = await fixture({ createBroker: () => ++opened === 1 ? pending.promise : Promise.resolve({ port: 4460, roomKey: 'new', hostToken: 'h', async stop() { currentStopped++; } }) });
  const oldRoom = native.invoke('host', { name: 'Canceled' }); const rejected = assert.rejects(oldRoom, /canceled/);
  await new Promise(resolve => setImmediate(resolve)); await native.invoke('stop');
  const replacement = await native.invoke('host', { name: 'Replacement' });
  pending.resolve({ port: 4459, async stop() { staleStopped++; } }); await rejected;
  assert.equal(staleStopped, 1); assert.equal(replacement.port, 4460); assert.equal(currentStopped, 0);
  await native.invoke('stop'); assert.equal(currentStopped, 1);
});

test('screen enumeration finishing after room teardown cannot authorize a stale source', async () => {
  const pending = defer(); const native = await fixture({ sources: () => pending.promise });
  const enumeration = native.invoke('sources'); const rejected = assert.rejects(enumeration, /canceled/);
  await native.invoke('stop');
  pending.resolve([{ id: 'screen:old', name: 'Old display', display_id: '1', thumbnail: { toDataURL: () => 'data:image/png;base64,' } }]);
  await rejected; await assert.rejects(native.invoke('choose-screen', 'screen:old'), /available screen/);
});

test('screen-only desktop refuses camera capture while microphone remains an explicit option', async () => {
  const native = await fixture();
  assert.equal(await native.permission(['audio']), true);
  assert.equal(await native.permission(['video']), false);
  assert.equal(await native.permission(['audio', 'video']), false);
  assert.equal(await native.permission([]), false);
  assert.equal(native.checkCamera(), false);
  await assert.rejects(native.invoke('request-media', 'camera'), /Only microphone/);
});

test('display geometry changes revoke input and invalidate pending screen selection', async () => {
  const source = { id: 'screen:1', name: 'Display', display_id: '1', thumbnail: { toDataURL: () => 'data:image/png;base64,' } };
  const pending = defer(); let enumerations = 0;
  const native = await fixture({ sources: () => ++enumerations === 1 ? Promise.resolve([source]) : pending.promise });
  await native.invoke('sources'); await native.invoke('choose-screen', source.id);
  const before = native.revocations();
  native.displayEvents.emit('display-metrics-changed', {}, {}, ['workArea']);
  assert.equal(native.revocations(), before, 'Work area alone does not change display coordinates');
  const enumeration = native.invoke('sources'); const rejected = assert.rejects(enumeration, /canceled/);
  native.displayEvents.emit('display-metrics-changed', {}, {}, ['bounds', 'scaleFactor']);
  assert.equal(native.revocations(), before + 1);
  pending.resolve([source]); await rejected;
  await assert.rejects(native.invoke('choose-screen', source.id), /available screen/);
  native.displayEvents.emit('display-removed', {}, {});
  native.displayEvents.emit('display-added', {}, {});
  assert.equal(native.revocations(), before + 3);
});

test('legacy empty-device screen permission needs a selected source and cannot authorize camera capture', async () => {
  const source={id:'screen:1',name:'Display',display_id:'1',thumbnail:{toDataURL:()=>''}};
  const native=await fixture({sources:async()=>[source]});
  assert.equal(await native.permission([]),false);
  await native.invoke('sources');await native.invoke('choose-screen',source.id);
  assert.equal(await native.permission([],false),false,'Subframes cannot use the selection');
  assert.equal(await native.permission(undefined),false,'Unspecified device requests cannot use the selection');
  assert.equal(await native.permission(['video']),false);
  assert.equal(await native.permission(['audio','video']),false);
  assert.equal(native.checkCamera(),false);
  assert.equal(await native.permission([]),true);
  assert.equal((await native.capture()).video.id,source.id);
  assert.equal(await native.permission([]),false,'Capture consumes the one-shot source selection');
  await native.invoke('choose-screen',source.id);
  native.displayEvents.emit('display-removed',{},{});
  assert.equal(await native.permission([]),false,'Display changes invalidate that selection');
});

test('Mac microphone refusal remains denied even before TCC updates its cached status', async () => {
  let prompts=0;
  const native=await fixture({platform:'darwin',systemPreferences:{getMediaAccessStatus:()=> 'not-determined',askForMediaAccess:async type=>{assert.equal(type,'microphone');prompts++;return false;}}});
  const result=await native.invoke('request-media','microphone');
  assert.equal(result.ok,false);assert.equal(result.status,'denied');assert.match(result.reason,/System Settings/);
  assert.equal(await native.permission(['audio']),false);
  assert.equal(prompts,2);
});

test('Mac overlapping microphone requests share one prompt and preserve its native decision', async () => {
  const pending=defer();let prompts=0;
  const native=await fixture({platform:'darwin',systemPreferences:{getMediaAccessStatus:()=> 'not-determined',askForMediaAccess:()=>{prompts++;return pending.promise;}}});
  const first=native.invoke('request-media','microphone');const browser=native.permission(['audio']);
  await new Promise(resolve=>setImmediate(resolve));assert.equal(prompts,1);
  pending.resolve(true);assert.equal((await first).ok,true);assert.equal(await browser,true);
});

test('Mac denied, restricted and unknown microphone access cannot report ready to capture', async () => {
  for(const status of ['denied','restricted','unknown']) {
    const native=await fixture({platform:'darwin',systemPreferences:{getMediaAccessStatus:()=>status,askForMediaAccess:()=>{throw new Error('Must not prompt');}}});
    assert.equal((await native.invoke('request-media','microphone')).ok,false);
    assert.equal(await native.permission(['audio']),false);
  }
});

test('Mac screen permission revoked after selection cannot authorize native display capture', async () => {
  let status='granted';const source={id:'screen:1',name:'Display',display_id:'1',thumbnail:{toDataURL:()=>''}};
  const native=await fixture({platform:'darwin',sources:async()=>[source],systemPreferences:{getMediaAccessStatus:()=>status}});
  await native.invoke('sources');await native.invoke('choose-screen',source.id);
  status='denied';assert.equal((await native.capture()).video,undefined);
  assert.equal(await native.permission([]),false,'Refused display selection is consumed');
});

test('a failed source refresh invalidates the earlier chooser selection', async () => {
  const source={id:'screen:1',name:'Display',display_id:'1',thumbnail:{toDataURL:()=>''}};let calls=0;
  const native=await fixture({sources:async()=>{if(++calls===1)return[source];throw new Error('Native enumeration refused');}});
  await native.invoke('sources');await native.invoke('choose-screen',source.id);
  await assert.rejects(native.invoke('sources'),/enumeration refused/);
  assert.equal(await native.permission([]),false);
  await assert.rejects(native.invoke('choose-screen',source.id),/available screen/);
});
