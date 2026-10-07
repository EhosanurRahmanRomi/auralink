'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { performance } = require('node:perf_hooks');

// This module intentionally exposes no unattended grant or global input hook.
// The host's local approval handler is the only caller allowed to invoke grant.
const MODIFIERS = new Set(['ShiftLeft', 'ShiftRight', 'ControlLeft', 'ControlRight', 'AltLeft', 'AltRight', 'MetaLeft', 'MetaRight']);
const NAMED = new Set([
  ...MODIFIERS, 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Backspace',
  'Tab', 'Enter', 'Space', 'Escape', 'Delete', 'Insert', 'Home', 'End',
  'PageUp', 'PageDown', 'CapsLock', 'Minus', 'Equal', 'BracketLeft',
  'BracketRight', 'Backslash', 'Semicolon', 'Quote', 'Comma', 'Period', 'Slash', 'Backquote',
]);
const KEY_ALIASES = Object.freeze({
  ' ': 'Space', Spacebar: 'Space', Esc: 'Escape', Shift: 'ShiftLeft',
  Control: 'ControlLeft', Alt: 'AltLeft', '-': 'Minus', '=': 'Equal',
  '[': 'BracketLeft', ']': 'BracketRight', '\\': 'Backslash', ';': 'Semicolon',
  "'": 'Quote', ',': 'Comma', '.': 'Period', '/': 'Slash', '`': 'Backquote',
});

function canonicalKey(event) {
  const supplied = event.code ?? event.key;
  if (typeof supplied !== 'string' || supplied.length > 32) return null;
  if (/^[a-z]$/i.test(supplied)) return `Key${supplied.toUpperCase()}`;
  if (/^[0-9]$/.test(supplied)) return `Digit${supplied}`;
  if (/^Key[A-Z]$/.test(supplied) || /^Digit[0-9]$/.test(supplied) || NAMED.has(supplied)) return supplied;
  return KEY_ALIASES[supplied] || null;
}

function validIdentity(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\x00-\x1f\x7f]/.test(value);
}

function validateDisplay(display) {
  if (!display || typeof display !== 'object') return null;
  const { x, y, width, height } = display;
  if (![x, y, width, height].every(Number.isSafeInteger)) return null;
  if (width < 1 || height < 1 || width > 32768 || height > 32768) return null;
  if (Math.abs(x) > 262144 || Math.abs(y) > 262144 || Math.abs(x + width) > 262144 || Math.abs(y + height) > 262144) return null;
  return Object.freeze({ x, y, width, height });
}

function forbiddenChord(keys) {
  const ctrl = keys.has('ControlLeft') || keys.has('ControlRight');
  const alt = keys.has('AltLeft') || keys.has('AltRight');
  const shift = keys.has('ShiftLeft') || keys.has('ShiftRight');
  const meta = keys.has('MetaLeft') || keys.has('MetaRight');
  // OS switching, Task Manager and secure-attention are never synthesized.
  return (alt && (keys.has('Tab') || keys.has('Escape'))) ||
    (ctrl && keys.has('Escape')) || (ctrl && alt && keys.has('Delete')) ||
    (ctrl && shift && keys.has('Escape')) ||
    (meta && (keys.has('Tab') || keys.has('Escape')));
}

class ControlGate {
  constructor(adapter, options = {}) {
    if (!adapter || typeof adapter.send !== 'function') throw new TypeError('A native adapter is required');
    this.adapter = adapter;
    this._grant = null;
    this._generation = 0;
    this._keys = new Set();
    this._buttons = new Set();
    this._lastSeq = 0;
    this._clock = options.clock || (() => performance.now());
    this._tokens = 300;
    this._lastTick = this._clock();
    this._onFailure = options.onFailure || (() => {});
    this._expiryTimer = null;
    if (typeof adapter.setFailureHandler === 'function') {
      adapter.setFailureHandler((reason) => {
        // A failed helper closes the authorization boundary immediately.
        this._generation++;
        this._grant = null;
        clearTimeout(this._expiryTimer);
        this._expiryTimer = null;
        this._keys.clear();
        this._buttons.clear();
        this._lastSeq = 0;
        this._onFailure(reason);
      });
    }
  }

  get active() { return this._grant !== null; }
  get status() {
    return { available: !!this.adapter.available, active: this.active, supports: this.adapter.supports || [],
      peerId: this._grant?.peerId || null, sessionId: this._grant?.sessionId || null };
  }

  async grant({ peerId, sessionId, display } = {}) {
    const released = this.revoke();
    const generation = this._generation;
    await released;
    if (generation !== this._generation) return { ok: false, reason: 'Approval was superseded' };
    const bounds = validateDisplay(display);
    if (!validIdentity(peerId) || !validIdentity(sessionId) || !bounds) return { ok: false, reason: 'Invalid grant' };
    if (!this.adapter.available) return { ok: false, reason: this.adapter.reason || 'Native input is unavailable on this device' };
    try {
      if (typeof this.adapter.ready === 'function') await this.adapter.ready();
      if (generation !== this._generation) return { ok: false, reason: 'Approval was revoked while input was starting' };
      this._grant = Object.freeze({ peerId, sessionId, display: bounds, expiresAt: this._clock() + 15 * 60 * 1000 });
      this._expiryTimer = setTimeout(() => {
        void this.revoke();
        this._onFailure('Control approval expired; the host must approve again');
      }, 15 * 60 * 1000);
      this._expiryTimer.unref();
      this._tokens = 300;
      this._lastTick = this._clock();
      return { ok: true, ...this.status };
    } catch (error) {
      return { ok: false, reason: error.message || 'Native input could not start' };
    }
  }

  async revoke() {
    // Clear authorization synchronously, before any asynchronous release work.
    this._generation++;
    this._grant = null;
    clearTimeout(this._expiryTimer);
    this._expiryTimer = null;
    this._lastSeq = 0;
    this._keys.clear();
    this._buttons.clear();
    try { if (typeof this.adapter.releaseAll === 'function') await this.adapter.releaseAll(); } catch (_) { /* helper exit also releases */ }
    return { ok: true, active: false };
  }

  apply({ peerId, sessionId, event } = {}) {
    const grant = this._grant;
    if (!grant || peerId !== grant.peerId || sessionId !== grant.sessionId) return { ok: false, reason: 'Control is not approved for this peer and session' };
    if (this._clock() >= grant.expiresAt) {
      void this.revoke();
      this._onFailure('Control approval expired; the host must approve again');
      return { ok: false, reason: 'Control approval expired' };
    }
    if (!event || typeof event !== 'object' || Array.isArray(event)) return { ok: false, reason: 'Invalid input event' };
    if (!Number.isSafeInteger(event.seq) || event.seq < 1 || event.seq <= this._lastSeq) return { ok: false, reason: 'Invalid or replayed input sequence' };
    let next;
    const type = event.type;
    if (['move', 'down', 'up'].includes(type)) {
      if (![event.x, event.y].every(Number.isFinite) || Math.abs(event.x) > 1e6 || Math.abs(event.y) > 1e6) return { ok: false, reason: 'Invalid pointer coordinates' };
      if (type !== 'move' && ![0, 1, 2].includes(event.button)) return { ok: false, reason: 'Unsupported mouse button' };
      const { x, y, width, height } = grant.display;
      next = { type, x: x + Math.round(Math.min(1, Math.max(0, event.x)) * (width - 1)),
        y: y + Math.round(Math.min(1, Math.max(0, event.y)) * (height - 1)) };
      if (type !== 'move') next.button = event.button;
      if (type === 'down' && this._buttons.has(event.button)) return { ok: false, reason: 'Mouse button is already down' };
      if (type === 'up' && !this._buttons.has(event.button)) return { ok: false, reason: 'Mouse button is not down' };
    } else if (type === 'wheel') {
      const deltaX = event.deltaX ?? 0;
      const deltaY = event.deltaY ?? 0;
      if (![deltaX, deltaY].every(Number.isFinite) || Math.abs(deltaX) > 1200 || Math.abs(deltaY) > 1200) return { ok: false, reason: 'Invalid scroll delta' };
      next = { type, deltaX: Math.round(deltaX), deltaY: Math.round(deltaY) };
    } else if (type === 'keydown' || type === 'keyup') {
      const code = canonicalKey(event);
      if (!code) return { ok: false, reason: 'Unsupported key' };
      if (code.startsWith('Meta') && this.adapter.platform !== 'darwin') return { ok: false, reason: 'Command input is supported only on macOS' };
      const candidate = new Set(this._keys);
      if (type === 'keydown') {
        candidate.add(code);
        if (forbiddenChord(candidate)) return { ok: false, reason: 'Operating-system shortcut is not allowed' };
      } else if (!candidate.has(code)) return { ok: false, reason: 'Key is not down' };
      next = { type, code };
    } else return { ok: false, reason: 'Unsupported input event type' };

    const tick = this._clock();
    this._tokens = Math.min(300, this._tokens + Math.max(0, tick - this._lastTick) * 0.3);
    this._lastTick = tick;
    // Releases must still get through an exhausted input budget.
    if (this._tokens < 1 && type !== 'up' && type !== 'keyup') return { ok: false, reason: 'Input rate limit exceeded' };
    try {
      if (this.adapter.send(next) === false) {
        void this.revoke();
        return { ok: false, reason: 'Native input adapter is not ready' };
      }
    } catch (error) {
      void this.revoke();
      return { ok: false, reason: error.message || 'Native input failed' };
    }
    this._tokens = Math.max(0, this._tokens - 1);
    this._lastSeq = event.seq;
    if (type === 'keydown') this._keys.add(next.code);
    if (type === 'keyup') this._keys.delete(next.code);
    if (type === 'down') this._buttons.add(next.button);
    if (type === 'up') this._buttons.delete(next.button);
    return { ok: true };
  }
}

class HelperAdapter {
  constructor(platform, helperPath, options = {}) {
    this.platform = platform;
    this.helperPath = helperPath;
    this.available = true;
    this.supports = ['mouse', 'keyboard', 'wheel'];
    this._child = null;
    this._ready = null;
    this._readyDone = false;
    this._pending = new Map();
    this._counter = 0;
    this._onFailure = options.onError || (() => {});
    this._spawn = options.spawn || spawn;
    this._disposed = false;
  }

  setFailureHandler(callback) { this._onFailure = callback; }

  ready() {
    if (this._disposed) return Promise.reject(new Error('Native input adapter was disposed'));
    if (this._ready) return this._ready;
    this._ready = new Promise((resolve, reject) => {
      let settled = false;
      let failed = false;
      let buffer = '';
      const executable = this.platform === 'win32' ? 'powershell.exe' : this.helperPath;
      const args = this.platform === 'win32' ? ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', this.helperPath] : [];
      const child = this._spawn(executable, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      this._child = child;
      const timeout = setTimeout(() => {
        fail('Native input helper startup timed out');
        child.kill();
      }, 15000);
      const fail = (reason) => {
        if (failed || this._child !== child) return;
        failed = true;
        this._readyDone = false;
        this._ready = null;
        clearTimeout(timeout);
        if (!settled) { settled = true; reject(new Error(reason)); }
        for (const entry of this._pending.values()) { clearTimeout(entry.timer); entry.reject(new Error(reason)); }
        this._pending.clear();
        // An orderly stdin close lets the helper release its injected state in
        // its finally/EOF handler. A stale helper can never revoke a new one.
        if (!child.stdin.destroyed && !child.stdin.writableEnded) child.stdin.end();
        this._onFailure(reason);
      };
      child.once('error', (error) => fail(error.message));
      child.once('exit', (code) => {
        if (this._child !== child) return;
        if (!this._disposed) fail(`Native input helper stopped (${code ?? 'signal'})`);
        if (this._child === child) this._child = null;
      });
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        if (failed || this._child !== child) return;
        buffer += chunk;
        if (buffer.length > 65536) { fail('Invalid native helper output'); child.kill(); return; }
        let separator;
        while ((separator = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, separator).trim();
          buffer = buffer.slice(separator + 1);
          if (!line) continue;
          let packet;
          try { packet = JSON.parse(line); } catch (_) { fail('Invalid native helper response'); child.kill(); return; }
          if (packet.type === 'ready') {
            clearTimeout(timeout);
            if (packet.available !== true) { fail(packet.reason || 'Operating-system input permission is missing'); child.kill(); return; }
            this._readyDone = true;
            if (!settled) { settled = true; resolve(); }
          } else if (packet.type === 'ack') {
            const entry = this._pending.get(packet.id);
            if (entry) {
              clearTimeout(entry.timer);
              this._pending.delete(packet.id);
              if (packet.ok) entry.resolve(); else entry.reject(new Error(packet.reason || 'Input release failed'));
            }
            if (!packet.ok) fail(packet.reason || 'Native input was rejected');
          } else if (packet.type === 'error') fail(packet.reason || 'Native input failed');
        }
      });
      // Drain diagnostics without logging remote content or collecting screenshots.
      child.stderr.on('data', () => {});
      child.stdin.on('error', (error) => fail(error.message));
    });
    return this._ready;
  }

  send(event) {
    if (!this._readyDone || !this._child || this._child.stdin.destroyed) return false;
    if (this._child.stdin.writableLength > 32768) throw new Error('Native input queue is full');
    this._child.stdin.write(`${JSON.stringify(event)}\n`);
    return true;
  }

  releaseAll() {
    if (!this._readyDone || !this._child) return Promise.resolve();
    const id = ++this._counter;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(id);
        this._child?.kill();
        reject(new Error('Native input release timed out'));
      }, 1500);
      this._pending.set(id, { resolve, reject, timer });
      try { if (!this.send({ type: 'release', id })) throw new Error('Input helper is unavailable'); }
      catch (error) { clearTimeout(timer); this._pending.delete(id); reject(error); }
    });
  }

  async dispose() {
    await this.releaseAll().catch(() => {});
    this._disposed = true;
    this._readyDone = false;
    this._ready = null;
    const child = this._child;
    this._child = null;
    if (child) {
      child.stdin.end();
      const timer = setTimeout(() => child.kill(), 1000);
      timer.unref();
      child.once('exit', () => clearTimeout(timer));
    }
  }
}

function createAdapter(options = {}) {
  const platform = options.platform || process.platform;
  // Electron can read an ASAR virtual file but an external native helper cannot.
  // The packaging configuration must unpack this directory.
  const helperPath = (options.helperPath || path.join(__dirname, platform === 'win32' ? 'windows-input.ps1' : 'macos-input'))
    .replace(/([\\/]app\.asar)([\\/])/, '$1.unpacked$2');
  if ((platform === 'win32' || platform === 'darwin') && fs.existsSync(helperPath)) return new HelperAdapter(platform, helperPath, options);
  return { available: false, supports: [], reason: platform === 'darwin' ? 'Compile the macOS helper and grant Accessibility access on the Mac' : 'Native input is unsupported or the helper is missing',
    send() { return false; }, async releaseAll() {}, async dispose() {} };
}

module.exports = { ControlGate, createAdapter, canonicalKey, validateDisplay };
