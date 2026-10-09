'use strict';

// Run production main-process handlers with explicit macOS API fixtures. These
// checks do not obtain, bypass, or change the owner's real TCC permissions.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');
const { EventEmitter } = require('node:events');

const mainFile = path.resolve(__dirname, '../src/main.cjs');
const localPage = pathToFileURL(path.resolve(__dirname, '../src/renderer/index.html')).href;
const source = { id: 'screen:qa', name: 'Fixture Mac display', display_id: '1', thumbnail: { toDataURL: () => 'data:image/png;base64,' } };
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }

async function fixture(options = {}) {
  const handlers = new Map(), enumeration = [], settings = [], prompts = [];
  let displayRequest, permissionRequest, window;
  const app = new EventEmitter();
  Object.assign(app, { setName() {}, whenReady: () => Promise.resolve(), getVersion: () => '0.6.1',
    commandLine: { hasSwitch: () => false, appendSwitch() {} }, isPackaged: false });
  class Window extends EventEmitter {
    constructor() { super(); window = this; this.webContents = new EventEmitter(); this.webContents.mainFrame = { url: localPage };
      this.webContents.getURL = () => localPage; this.webContents.setWindowOpenHandler = () => {}; this.webContents.send = () => {}; }
    isDestroyed() { return false; } show() {} async loadFile() {} setFullScreen() {} isFullScreen() { return false; }
  }
  const electron = { app, BrowserWindow: Window,
    ipcMain: { handle(name, handler) { handlers.set(name, handler); } },
    session: { defaultSession: { setCertificateVerifyProc() {}, setPermissionCheckHandler() {},
      setPermissionRequestHandler(handler) { permissionRequest = handler; }, setDisplayMediaRequestHandler(handler) { displayRequest = handler; } } },
    desktopCapturer: { async getSources(value) { enumeration.push(value); return options.sources ? options.sources(value, enumeration.length) : [source]; } },
    screen: new EventEmitter(), dialog: {}, globalShortcut: { register() {}, unregisterAll() {} }, clipboard: {},
    systemPreferences: { getMediaAccessStatus: type => type === 'screen' ? (options.status?.() || 'granted') : 'denied',
      askForMediaAccess: async type => { prompts.push(type); return false; }, isTrustedAccessibilityClient: () => false },
    shell: { async openExternal(value) { settings.push(value); } },
    powerSaveBlocker: { start: () => 1, stop() {} } };
  class Gate { async revoke() {} }
  const dependencies = { electron, selfsigned: {}, './core/invite.cjs': {}, './core/broker.cjs': {},
    './native/control.cjs': { ControlGate: Gate, createAdapter: () => ({ available: false }) },
    './core/internet-client.cjs': {}, './core/app-invitation.cjs': require('../src/core/app-invitation.cjs'),
    './core/screen-sources.cjs': require('../src/core/screen-sources.cjs') };
  vm.runInNewContext(fs.readFileSync(mainFile, 'utf8'), { require: name => Object.hasOwn(dependencies, name) ? dependencies[name] : require(name),
    __dirname: path.dirname(mainFile), process: { ...process, platform: 'darwin', argv: ['node', mainFile] },
    URL, Map, Set, Date, String, Number, Boolean, Promise, setTimeout, clearTimeout }, { filename: mainFile });
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(window, 'The production native handlers and window must initialize');
  const event = { sender: window.webContents, senderFrame: window.webContents.mainFrame };
  return { enumeration, prompts, settings,
    invoke(name, value) { const handler = handlers.get(`glance-port:${name}`); assert.ok(handler, `Production IPC ${name} must exist`); return handler(event, value); },
    invokeAs(name, value, sender) { return handlers.get(`glance-port:${name}`)(sender, value); },
    capture() { return new Promise(resolve => displayRequest({ frame: window.webContents.mainFrame }, resolve)); },
    permission() { return new Promise(resolve => permissionRequest(window.webContents, 'media', resolve, { mediaTypes: [], isMainFrame: true })); },
    window };
}
function unavailable(result) {
  assert.equal(result.ok, false); assert.equal(typeof result.code, 'string'); assert.ok(result.code.length);
  assert.equal(typeof result.reason, 'string'); assert.ok(result.reason.length > 15);
  assert.doesNotMatch(result.reason, /auralink:|Error invoking remote method|Failed to get sources\./i);
  assert.ok(!result.sources?.length, 'Failure must not hand back usable stale sources');
}

test('Mac denied, restricted and unknown screen permission returns useful recovery before enumeration', async () => {
  for (const status of ['denied', 'restricted', 'unknown']) {
    const native = await fixture({ status: () => status }); const result = await native.invoke('sources');
    unavailable(result); assert.equal(result.status, status); assert.match(result.reason, /Glance-Port/);
    assert.equal(native.enumeration.length, 0, 'Known TCC refusal must not repeatedly enumerate');
    assert.deepEqual(native.prompts, []); assert.deepEqual(native.settings, []);
    assert.equal(await native.permission(), false);
  }
});
test('Mac first screen consent refusal returns recovery after exactly one native request', async () => {
  const native = await fixture({ status: () => 'not-determined' });
  const result = await native.invoke('sources'); unavailable(result); assert.equal(result.status, 'not-determined');
  assert.equal(native.enumeration.length, 1); assert.deepEqual(Array.from(native.enumeration[0].types), ['screen']);
  assert.deepEqual(native.prompts, []); assert.equal(await native.permission(), false);
});
test('Mac first consent attempt can become granted and supplies only explicit chooser sources', async () => {
  let status = 'not-determined';
  const native = await fixture({ status: () => status, sources: async () => { status = 'granted'; return [source]; } });
  const result = await native.invoke('sources'); assert.equal(result.ok, true); assert.equal(result.status, 'granted');
  assert.equal(result.sources[0].id, source.id); assert.equal(result.sources[0].canControl, true);
  assert.equal(await native.permission(), false, 'Enumeration alone must never authorize capture');
  await native.invoke('choose-screen', source.id); assert.equal((await native.capture()).video.id, source.id);
  assert.deepEqual(native.prompts, [], 'Screen consent must not ask for microphone access');
});
test('Mac failed combined enumeration recovers with a display-only source without thumbnails', async () => {
  const native = await fixture({ sources: async (value, call) => { if (call === 1) throw 'Failed to get sources.'; return [source]; } });
  const result = await native.invoke('sources'); assert.equal(result.ok, true); assert.ok(result.fallback);
  assert.equal(native.enumeration.length, 2);
  assert.deepEqual(Array.from(native.enumeration[1].types), ['screen']);
  assert.equal(native.enumeration[1].thumbnailSize.width, 0); assert.equal(native.enumeration[1].thumbnailSize.height, 0);
  await native.invoke('choose-screen', result.sources[0].id); assert.equal((await native.capture()).video.id, source.id);
});
test('Mac native enumeration errors return clean structured failure and next owner retry can succeed', async () => {
  let failed = true;
  const native = await fixture({ sources: async () => { if (failed) throw 'Failed to get sources.'; return [source]; } });
  unavailable(await native.invoke('sources')); assert.equal(await native.permission(), false);
  await assert.rejects(native.invoke('choose-screen', source.id), /available screen|screen selection/i);
  failed = false; const retry = await native.invoke('sources'); assert.equal(retry.ok, true); assert.equal(retry.sources[0].id, source.id);
  assert.deepEqual(native.prompts, []); assert.deepEqual(native.settings, []);
});
test('Mac empty source results are unavailable instead of reporting a usable capture', async () => {
  const native = await fixture({ sources: async () => [] }); unavailable(await native.invoke('sources'));
  assert.equal(await native.permission(), false); assert.equal((await native.capture()).video, undefined);
});
test('Mac failed refresh consumes the earlier chooser and grant cannot survive permission revocation', async () => {
  let status = 'granted', failed = false;
  const native = await fixture({ status: () => status, sources: async () => { if (failed) throw new Error('Native unavailable'); return [source]; } });
  await native.invoke('sources'); await native.invoke('choose-screen', source.id); failed = true;
  unavailable(await native.invoke('sources')); assert.equal(await native.permission(), false);
  await assert.rejects(native.invoke('choose-screen', source.id), /available screen|screen selection/i);
  failed = false; await native.invoke('sources'); await native.invoke('choose-screen', source.id); status = 'denied';
  assert.equal((await native.capture()).video, undefined); assert.equal(await native.permission(), false);
});
test('Mac pending enumeration cannot reinstall sources after native room teardown', async () => {
  const pending = deferred(); const native = await fixture({ sources: () => pending.promise });
  const result = native.invoke('sources').then(value => ({ value }), error => ({ error }));
  await new Promise(resolve => setImmediate(resolve)); await native.invoke('stop'); pending.resolve([source]);
  const settled = await result;
  if (settled.error) assert.match(settled.error.message, /cancel/i); else unavailable(settled.value);
  await assert.rejects(native.invoke('choose-screen', source.id), /available screen|screen selection/i);
  assert.equal(await native.permission(), false);
});
test('Mac recovery opens only the requested screen settings on trusted main-frame IPC', async () => {
  const native = await fixture(); await native.invoke('permission-settings', 'screen');
  assert.deepEqual(native.settings, ['x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture']);
  const sender = { sender: native.window.webContents, senderFrame: { url: localPage } };
  await assert.rejects(native.invokeAs('sources', undefined, sender), /untrusted/);
  await assert.rejects(native.invokeAs('permission-settings', 'screen', sender), /untrusted/);
  assert.equal(native.settings.length, 1); assert.equal(native.enumeration.length, 0);
});
test('Mac native information exposes the new product identity without requesting media', async () => {
  const native = await fixture(); const info = await native.invoke('info');
  assert.equal(info.profileName, 'Glance-Port'); assert.equal(info.applicationId, 'local.glanceport.desktop');
  assert.equal(info.platform, 'darwin'); assert.equal(info.permissions.microphone, 'denied');
  assert.equal(native.enumeration.length, 0); assert.deepEqual(native.prompts, []); assert.deepEqual(native.settings, []);
});
