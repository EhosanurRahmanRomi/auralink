'use strict';

// A dedicated local QA application, separate from the room application. It
// contains only one textarea and one button. It cannot load external content.
const { app, BrowserWindow, screen } = require('electron');
const { ControlGate, createAdapter } = require('../src/native/control.cjs');

if (process.platform !== 'win32') throw new Error('This isolated native input test supports Windows only');
app.setName('Glance-Port isolated input verification');
let window;
let adapter;
let gate;
let sequence = 0;
let original;
let display;
const peerId = 'isolated-local-qa';
const sessionId = 'isolated-local-qa-session';

function physical(point) { return screen.dipToScreenPoint(point); }
function inDisplay(point) {
  return point.x >= display.x && point.y >= display.y && point.x < display.x + display.width && point.y < display.y + display.height;
}
function focused() {
  if (!window || window.isDestroyed() || !window.isFocused()) throw new Error('Isolated QA window lost focus; input was stopped');
}

app.whenReady().then(async () => {
  display = screen.dipToScreenRect(null, screen.getPrimaryDisplay().bounds);
  original = physical(screen.getCursorScreenPoint());
  const work = screen.getPrimaryDisplay().workArea;
  window = new BrowserWindow({
    title: 'Glance-Port isolated input verification', width: 620, height: 390,
    x: Math.round(work.x + Math.max(0, (work.width - 620) / 2)),
    y: Math.round(work.y + Math.max(0, (work.height - 390) / 2)),
    resizable: false, show: false, autoHideMenuBar: true,
    backgroundColor: '#101827', webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  const native = createAdapter();
  const handle = window.getNativeWindowHandle();
  const windowId = handle.length >= 8 ? handle.readBigUInt64LE(0).toString() : String(handle.readUInt32LE(0));
  adapter = {
    available: native.available, supports: native.supports,
    ready: () => native.ready(),
    releaseAll: () => native.releaseAll(),
    setFailureHandler: (fn) => native.setFailureHandler(fn),
    send(event) { focused(); return native.send({ ...event, windowId }); },
    dispose: () => native.dispose(),
  };
  gate = new ControlGate(adapter);
  globalThis.nativeQA = {
    info() { return { original, display, pointerRestorable: inDisplay(original), nativeAvailable: adapter.available }; },
    focus() { window.show(); window.focus(); return window.isFocused(); },
    async grant() { focused(); if (!inDisplay(original)) throw new Error('Original pointer is outside the primary display; test skipped to preserve its position'); sequence = 0; return gate.grant({ peerId, sessionId, display }); },
    apply(event) { focused(); return gate.apply({ peerId, sessionId, event: { ...event, seq: ++sequence } }); },
    point(viewport) {
      const bounds = window.getContentBounds();
      const point = physical({ x: Math.round(bounds.x + viewport.x), y: Math.round(bounds.y + viewport.y) });
      if (!inDisplay(point)) throw new Error('QA pointer target is outside the approved display');
      return { x: (point.x - display.x) / (display.width - 1), y: (point.y - display.y) / (display.height - 1) };
    },
    restore() {
      focused();
      if (!gate.active) return { ok: false, reason: 'Control already revoked' };
      return gate.apply({ peerId, sessionId, event: { type: 'move', seq: ++sequence,
        x: (original.x - display.x) / (display.width - 1), y: (original.y - display.y) / (display.height - 1) } });
    },
    revoke: () => gate.revoke(),
    status: () => gate.status,
    pointer: () => physical(screen.getCursorScreenPoint()),
    async dispose() { await gate.revoke(); await adapter.dispose(); },
  };
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'"><title>Glance-Port isolated input verification</title><style>body{font:16px system-ui;background:#101827;color:#eff5ff;padding:24px}h1{font-size:22px}p{color:#a8b5c9}textarea{width:95%;height:76px;padding:10px;font-size:20px}button{padding:12px 24px;margin-top:16px;font-size:16px}#result{margin-left:16px}</style></head><body><h1>Isolated native input verification</h1><p>Only plain test characters and this local button are exercised.</p><textarea id="input" aria-label="Native input test"></textarea><br><button id="target">QA click target</button><span id="result">0 native clicks</span><script>window.qa={keys:[],clicks:[]};document.getElementById('input').addEventListener('keydown',event=>window.qa.keys.push({key:event.key,code:event.code,trusted:event.isTrusted}));document.getElementById('target').addEventListener('click',event=>{window.qa.clicks.push({trusted:event.isTrusted});document.getElementById('result').textContent=window.qa.clicks.length+' native clicks';});</script></body></html>`;
  await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  window.show();
  window.focus();
});

app.on('before-quit', () => { if (gate) void gate.revoke(); if (adapter) void adapter.dispose(); });
app.on('window-all-closed', () => app.quit());
