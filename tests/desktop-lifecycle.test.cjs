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
  const sentEvents = [], fullscreenCalls = [], powerStarts = [], powerStops = [];
  let windowOptions, fullscreen = false, pendingFullscreen = null, destroyed = false, adapterDisposals = 0;
  const displayEvents = new EventEmitter();
  class Window extends EventEmitter {
    constructor(settings) { super(); window = this; windowOptions = settings; this.webContents = new EventEmitter(); this.webContents.mainFrame = { url: pathToFileURL(path.resolve(__dirname, '../src/renderer/index.html')).href }; this.webContents.getURL = () => this.webContents.mainFrame.url; this.webContents.setWindowOpenHandler = () => {}; this.webContents.send = (name, value) => sentEvents.push({ name, value }); }
    isDestroyed() { return destroyed; }
    setFullScreen(active) {
      fullscreenCalls.push(active);
      if (!options.delayedFullscreen) { fullscreen = active; return; }
      // Model macOS finishing its current animation before accepting another
      // state change. Requesting the opposite during that animation is lost.
      if (pendingFullscreen === null && active !== fullscreen) pendingFullscreen = active;
    }
    isFullScreen() { return fullscreen; }
    show() {} async loadFile() {}
  }
  const app = new EventEmitter(); app.setName = () => {}; app.whenReady = () => Promise.resolve(); app.getVersion = () => '0.3.0';
  const session = { defaultSession: { setCertificateVerifyProc() {}, setPermissionRequestHandler(handler) { permissionRequest = handler; }, setPermissionCheckHandler(handler) { permissionCheck = handler; }, setDisplayMediaRequestHandler(handler) { displayRequest = handler; } } };
  const electron = { app, BrowserWindow: Window, ipcMain: { handle(name, handler) { handlers.set(name, handler); } }, session,
    desktopCapturer: { getSources: options.sources || (async () => []) }, screen: displayEvents, dialog: {}, globalShortcut: { register() {}, unregisterAll() {} }, clipboard: {}, systemPreferences: { getMediaAccessStatus: () => 'granted', ...options.systemPreferences }, shell: {},
    powerSaveBlocker: { start(type) { powerStarts.push(type); return powerStarts.length; }, stop(id) { powerStops.push(id); } } };
  class Gate { async revoke() { revocations++; } }
  const mainFile = path.resolve(__dirname, '../src/main.cjs');
  const dependencies = {
    electron, selfsigned: { generate: options.generate || (async () => ({ private: 'fixture-key', cert: 'fixture-cert' })) },
    './core/invite.cjs': { fingerprint: () => 'a'.repeat(64) },
    './core/broker.cjs': { createBroker: options.createBroker || (async () => ({ port: 4459, roomKey: 'k'.repeat(32), hostToken: 'h'.repeat(32), async stop() {} })) },
    './native/control.cjs': { ControlGate: Gate, createAdapter: () => ({ available: false, dispose() { adapterDisposals++; } }) },
    './core/internet-client.cjs': {},
    './core/app-invitation.cjs': require('../src/core/app-invitation.cjs'),
  };
  vm.runInNewContext(fs.readFileSync(mainFile, 'utf8'), { require: name => Object.hasOwn(dependencies, name) ? dependencies[name] : require(name), __dirname: path.dirname(mainFile), process: { ...process, platform: options.platform || process.platform }, URL, Map, Set, Date, String, Number, Boolean }, { filename: mainFile });
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(window, 'Production native IPC registered');
  return {
    invoke(name, args) { return handlers.get(`auralink:${name}`)({ sender: window.webContents, senderFrame: window.webContents.mainFrame }, args); },
    invokeAs(name, args, event) { return handlers.get(`auralink:${name}`)(event, args); },
    permission(mediaTypes, isMainFrame=true) { return new Promise(resolve => permissionRequest(window.webContents, 'media', resolve, { mediaTypes, isMainFrame })); },
    permissionFor(name, contents = window.webContents, details = { isMainFrame: true }) { return new Promise(resolve => permissionRequest(contents, name, resolve, details)); },
    checkPermission(name, contents = window.webContents, details = { isMainFrame: true }) { return permissionCheck(contents, name, '', details); },
    capture() { return new Promise(resolve => displayRequest({frame:window.webContents.mainFrame},resolve)); },
    checkCamera() { return permissionCheck(window.webContents, 'media', '', { mediaType: 'video', isMainFrame: true }); },
    app, window, windowOptions, sentEvents, fullscreenCalls, powerStarts, powerStops,
    pendingFullscreen: () => pendingFullscreen,
    finishFullscreenTransition() {
      assert.ok(options.delayedFullscreen && pendingFullscreen !== null, 'An OS fullscreen animation must be pending');
      fullscreen = pendingFullscreen; pendingFullscreen = null;
      window.emit(fullscreen ? 'enter-full-screen' : 'leave-full-screen');
    },
    markDestroyed() { destroyed = true; }, adapterDisposals: () => adapterDisposals,
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

test('fullscreen permission belongs only to the bundled main page and leaves unrelated permissions denied', async () => {
  const native = await fixture();
  assert.equal(await native.permissionFor('fullscreen'), true);
  assert.equal(native.checkPermission('fullscreen'), true);
  assert.equal(await native.permissionFor('fullscreen', native.window.webContents, { isMainFrame: false }), false);
  assert.equal(native.checkPermission('fullscreen', native.window.webContents, { isMainFrame: false }), false);
  const otherContents = { getURL: () => native.window.webContents.getURL() };
  assert.equal(await native.permissionFor('fullscreen', otherContents), false, 'A different WebContents cannot borrow the bundled URL');
  assert.equal(native.checkPermission('fullscreen', otherContents), false);
  for (const permission of ['notifications', 'geolocation', 'local-network-access']) {
    assert.equal(await native.permissionFor(permission), false, `${permission} stays denied on the trusted main page`);
    assert.equal(native.checkPermission(permission), false);
  }
  native.window.webContents.mainFrame.url = 'https://untrusted.example/';
  assert.equal(await native.permissionFor('fullscreen'), false);
  assert.equal(native.checkPermission('fullscreen'), false);
  assert.equal(await native.permissionFor('notifications'), false);
  assert.equal(native.checkPermission('notifications'), false);
});

test('native presentation fullscreen validates booleans and reports actual enter and leave events', async () => {
  const native = await fixture({ platform: 'win32' });
  assert.equal(native.windowOptions.titleBarStyle, 'hidden');
  assert.equal(native.windowOptions.titleBarOverlay.color, '#00000000');
  assert.equal(native.windowOptions.titleBarOverlay.height, 44);
  assert.equal(native.windowOptions.webPreferences.backgroundThrottling, false);
  for (const value of [undefined, null, 'true', 'false', 1, 0, {}, []]) {
    await assert.rejects(native.invoke('presentation-fullscreen', value), /Invalid fullscreen state/);
  }
  assert.deepEqual(native.fullscreenCalls, []);
  assert.equal((await native.invoke('presentation-fullscreen', true)).fullscreen, true);
  assert.deepEqual(native.fullscreenCalls, [true]);
  assert.equal(native.sentEvents.length, 0, 'The asynchronous OS event confirms the native transition');
  native.window.emit('enter-full-screen');
  assert.equal((await native.invoke('presentation-fullscreen', false)).fullscreen, false);
  native.window.emit('leave-full-screen');
  assert.deepEqual(native.fullscreenCalls, [true, false]);
  assert.deepEqual(native.sentEvents.map(({ name, value }) => ({ name, fullscreen: value.fullscreen })), [
    { name: 'auralink:presentation-fullscreen', fullscreen: true },
    { name: 'auralink:presentation-fullscreen', fullscreen: false },
  ]);
  native.markDestroyed(); native.window.emit('enter-full-screen');
  assert.equal(native.sentEvents.length, 2, 'A destroyed view receives no native fullscreen event');
});

test('presentation and activity IPC cannot be called by other content or a subframe', async () => {
  const native = await fixture();
  const trusted = native.window.webContents;
  const main = trusted.mainFrame;
  for (const name of ['presentation-fullscreen', 'session-active']) {
    for (const event of [
      { sender: new EventEmitter(), senderFrame: main },
      { sender: trusted, senderFrame: { url: main.url } },
      { sender: trusted, senderFrame: undefined },
    ]) await assert.rejects(native.invokeAs(name, true, event), /untrusted content/);
  }
  assert.deepEqual(native.fullscreenCalls, []);
  assert.deepEqual(native.powerStarts, []);
});

test('a delayed Mac fullscreen entry cannot overrule an immediate request to exit', async () => {
  const native = await fixture({ platform: 'darwin', delayedFullscreen: true });
  await native.invoke('presentation-fullscreen', true);
  assert.equal(native.pendingFullscreen(), true);
  assert.equal(native.window.isFullScreen(), false, 'Entry has not finished natively');
  await native.invoke('presentation-fullscreen', false);
  assert.equal(native.pendingFullscreen(), true, 'The OS ignored exit while its entry animation was pending');
  native.finishFullscreenTransition();
  assert.equal(native.window.isFullScreen(), true);
  assert.equal(native.pendingFullscreen(), false, 'Production reconciles the latest exit request after the late entry');
  assert.deepEqual(native.fullscreenCalls, [true, false, false]);
  assert.equal(native.sentEvents.length, 0, 'The stale enter event cannot reopen presentation in the renderer');
  native.finishFullscreenTransition();
  assert.equal(native.window.isFullScreen(), false);
  assert.equal(native.pendingFullscreen(), null);
  assert.deepEqual(native.sentEvents.map(({ name, value }) => ({ name, fullscreen: value.fullscreen })), [
    { name: 'auralink:presentation-fullscreen', fullscreen: false },
  ]);
});

test('a new Mac fullscreen entry request survives a delayed exit confirmation', async () => {
  const native = await fixture({ platform: 'darwin', delayedFullscreen: true });
  await native.invoke('presentation-fullscreen', true); native.finishFullscreenTransition();
  assert.equal(native.window.isFullScreen(), true);
  await native.invoke('presentation-fullscreen', false);
  assert.equal(native.pendingFullscreen(), false);
  await native.invoke('presentation-fullscreen', true);
  assert.equal(native.pendingFullscreen(), false, 'The OS ignored re-entry while its exit animation was pending');
  native.finishFullscreenTransition();
  assert.equal(native.window.isFullScreen(), false);
  assert.equal(native.pendingFullscreen(), true, 'Production re-applies the newest entry intent after the stale exit');
  assert.deepEqual(native.fullscreenCalls, [true, false, true, true]);
  assert.deepEqual(native.sentEvents.map(({ value }) => value.fullscreen), [true], 'No stale exit is published to collapse the reopened presentation');
  native.finishFullscreenTransition();
  assert.equal(native.window.isFullScreen(), true);
  assert.equal(native.pendingFullscreen(), null);
  assert.deepEqual(native.sentEvents.map(({ name, value }) => ({ name, fullscreen: value.fullscreen })), [
    { name: 'auralink:presentation-fullscreen', fullscreen: true },
    { name: 'auralink:presentation-fullscreen', fullscreen: true },
  ]);
  // Once the latest requested state is confirmed, subsequent native changes
  // (for example the Mac window control) must still reach the renderer.
  native.window.setFullScreen(false); native.finishFullscreenTransition();
  assert.equal(native.sentEvents.at(-1).value.fullscreen, false);
  assert.equal(native.pendingFullscreen(), null);
});

test('desktop sleep prevention starts only for explicit active room state and stops once on leave', async () => {
  const native = await fixture();
  assert.deepEqual(native.powerStarts, [], 'Opening the app alone cannot retain a power blocker');
  await native.invoke('host', { name: 'Waiting for admission' });
  assert.deepEqual(native.powerStarts, [], 'Preparing a room alone cannot retain a power blocker');
  for (const value of [undefined, null, 'true', 1, 0, {}, []]) await assert.rejects(native.invoke('session-active', value), /Invalid room activity state/);
  assert.equal((await native.invoke('session-active', false)).active, false);
  assert.deepEqual(native.powerStarts, []);
  assert.equal((await native.invoke('session-active', true)).active, true);
  assert.equal((await native.invoke('session-active', true)).active, true);
  assert.deepEqual(native.powerStarts, ['prevent-app-suspension']);
  assert.equal((await native.invoke('session-active', false)).active, false);
  assert.equal((await native.invoke('session-active', false)).active, false);
  assert.deepEqual(native.powerStops, [1]);
  assert.equal((await native.invoke('session-active', true)).active, true);
  assert.deepEqual(native.powerStarts, ['prevent-app-suspension', 'prevent-app-suspension']);
  await native.invoke('stop');
  assert.deepEqual(native.powerStops, [1, 2], 'Native room teardown also releases the active blocker');
});

test('window close, renderer failure and app quit release active room sleep prevention', async () => {
  for (const reason of ['closed', 'render-process-gone', 'before-quit']) {
    const native = await fixture();
    await native.invoke('session-active', true);
    const target = reason === 'closed' ? native.window : reason === 'render-process-gone' ? native.window.webContents : native.app;
    target.emit(reason); target.emit(reason);
    assert.deepEqual(native.powerStops, [1], `${reason} releases the blocker exactly once`);
    if (reason === 'before-quit') assert.ok(native.adapterDisposals() >= 1, 'Normal quit continues native adapter cleanup');
    if (reason !== 'closed') assert.equal((await native.invoke('session-active', false)).active, false);
    else await assert.rejects(native.invoke('session-active', true), /untrusted content/);
  }
});
