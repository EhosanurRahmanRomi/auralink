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
  const handlers = new Map(); let window;
  class Window extends EventEmitter {
    constructor() { super(); window = this; this.webContents = new EventEmitter(); this.webContents.mainFrame = { url: pathToFileURL(path.resolve(__dirname, '../src/renderer/index.html')).href }; this.webContents.getURL = () => this.webContents.mainFrame.url; this.webContents.setWindowOpenHandler = () => {}; this.webContents.send = () => {}; }
    isDestroyed() { return false; } show() {} async loadFile() {}
  }
  const app = new EventEmitter(); app.setName = () => {}; app.whenReady = () => Promise.resolve(); app.getVersion = () => '0.3.0';
  const session = { defaultSession: { setCertificateVerifyProc() {}, setPermissionRequestHandler() {}, setPermissionCheckHandler() {}, setDisplayMediaRequestHandler() {} } };
  const electron = { app, BrowserWindow: Window, ipcMain: { handle(name, handler) { handlers.set(name, handler); } }, session,
    desktopCapturer: { getSources: options.sources || (async () => []) }, screen: {}, dialog: {}, globalShortcut: { register() {}, unregisterAll() {} }, clipboard: {}, systemPreferences: { getMediaAccessStatus: () => 'granted' }, shell: {} };
  class Gate { async revoke() {} }
  const mainFile = path.resolve(__dirname, '../src/main.cjs');
  const dependencies = {
    electron, selfsigned: { generate: options.generate || (async () => ({ private: 'fixture-key', cert: 'fixture-cert' })) },
    './core/invite.cjs': { fingerprint: () => 'a'.repeat(64) },
    './core/broker.cjs': { createBroker: options.createBroker || (async () => ({ port: 4459, roomKey: 'k'.repeat(32), hostToken: 'h'.repeat(32), async stop() {} })) },
    './native/control.cjs': { ControlGate: Gate, createAdapter: () => ({ available: false }) },
    './core/internet-client.cjs': {},
  };
  vm.runInNewContext(fs.readFileSync(mainFile, 'utf8'), { require: name => Object.hasOwn(dependencies, name) ? dependencies[name] : require(name), __dirname: path.dirname(mainFile), process, URL, Map, Set, Date, String, Number, Boolean }, { filename: mainFile });
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(window, 'Production native IPC registered');
  return { invoke(name, args) { return handlers.get(`auralink:${name}`)({ sender: window.webContents, senderFrame: window.webContents.mainFrame }, args); } };
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
