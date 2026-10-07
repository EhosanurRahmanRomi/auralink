'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ControlGate, createAdapter, canonicalKey, validateDisplay } = require('../src/native/control.cjs');

// Every test uses a fake adapter. These tests never spawn a real helper, move
// the local pointer, type keys, or synthesize any operating-system input.
function harness(overrides = {}) {
  const calls = [];
  let tick = 0;
  const adapter = {
    available: true,
    supports: ['mouse', 'keyboard', 'wheel'],
    async ready() { calls.push({ type: 'ready' }); },
    send(event) { calls.push({ ...event }); return true; },
    async releaseAll() { calls.push({ type: 'release' }); },
    ...overrides,
  };
  const failures = [];
  const gate = new ControlGate(adapter, { clock: () => tick, onFailure: (reason) => failures.push(reason) });
  const identity = { peerId: 'trusted-peer', sessionId: 'approved-session' };
  const display = { x: -1920, y: 0, width: 1920, height: 1080 };
  return { gate, calls, failures, adapter, identity, display,
    grant: (changes = {}) => gate.grant({ ...identity, display, ...changes }),
    apply: (event, changes = {}) => gate.apply({ ...identity, event, ...changes }),
    setTick(value) { tick = value; } };
}

test('unapproved, different peer and different session input are rejected', async () => {
  const h = harness();
  assert.equal(h.apply({ type: 'move', seq: 1, x: 0.5, y: 0.5 }).ok, false);
  assert.equal((await h.grant()).ok, true);
  assert.equal(h.apply({ type: 'move', seq: 1, x: 0.5, y: 0.5 }, { peerId: 'intruder' }).ok, false);
  assert.equal(h.apply({ type: 'move', seq: 1, x: 0.5, y: 0.5 }, { sessionId: 'old-session' }).ok, false);
  assert.equal(h.calls.filter((c) => c.type === 'move').length, 0);
  await h.gate.revoke();
});

test('display coordinates are immutable, clamped and scoped to the approved display', async () => {
  const h = harness();
  await h.grant();
  h.display.x = 99999;
  assert.equal(h.apply({ type: 'move', seq: 1, x: -0.2, y: 1.2 }).ok, true);
  assert.deepEqual(h.calls.at(-1), { type: 'move', x: -1920, y: 1079 });
  assert.equal(h.apply({ type: 'move', seq: 2, x: 0.5, y: 0.5 }).ok, true);
  assert.deepEqual(h.calls.at(-1), { type: 'move', x: -960, y: 540 });
  await h.gate.revoke();
});

test('monotonic per-session sequence numbers reject replay and reordered packets', async () => {
  const h = harness();
  await h.grant();
  assert.equal(h.apply({ type: 'move', seq: 12, x: 0.1, y: 0.1 }).ok, true);
  for (const seq of [12, 11, 0, -1, 12.5, '13', undefined, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(h.apply({ type: 'move', seq, x: 0.2, y: 0.2 }).ok, false, String(seq));
  }
  assert.equal(h.apply({ type: 'move', seq: 13, x: 0.2, y: 0.2 }).ok, true);
  await h.gate.revoke();
});

test('invalid pointer, key, wheel and arbitrary command packets never reach native input', async () => {
  const h = harness();
  await h.grant();
  const invalid = [
    null, [], 'exec', { type: 'exec', command: 'powershell.exe' },
    { type: 'move', x: NaN, y: 0 }, { type: 'move', x: Infinity, y: 0 },
    { type: 'move', x: '0.5', y: 0 }, { type: 'move', x: 1e9, y: 0 },
    { type: 'down', x: 0, y: 0, button: 3 }, { type: 'up', x: 0, y: 0, button: 0 },
    { type: 'wheel', deltaY: 1201 }, { type: 'wheel', deltaY: '-120' },
    { type: 'keydown', code: 'MetaLeft' }, { type: 'keydown', key: 'Windows' },
    { type: 'keydown', code: 'Power' }, { type: 'keydown', code: 'F4' },
    { type: 'keydown', key: '$(evil)' }, { type: 'keyup', code: 'KeyA' },
  ];
  for (let i = 0; i < invalid.length; i++) {
    const event = invalid[i] && typeof invalid[i] === 'object' && !Array.isArray(invalid[i]) ? { ...invalid[i], seq: i + 1 } : invalid[i];
    assert.equal(h.apply(event).ok, false, JSON.stringify(event));
  }
  assert.deepEqual(h.calls.map((c) => c.type), ['release', 'ready']);
  await h.gate.revoke();
});

test('permitted buttons and keys release on disconnect and cannot resume with stale consent', async () => {
  const h = harness();
  await h.grant();
  assert.equal(h.apply({ type: 'keydown', code: 'ControlLeft', seq: 1 }).ok, true);
  assert.equal(h.apply({ type: 'keydown', code: 'KeyC', seq: 2 }).ok, true);
  assert.equal(h.apply({ type: 'down', button: 0, x: 0.1, y: 0.1, seq: 3 }).ok, true);
  assert.equal(h.apply({ type: 'down', button: 0, x: 0.1, y: 0.1, seq: 4 }).ok, false);
  const revoked = h.gate.revoke();
  assert.equal(h.gate.active, false, 'revocation is synchronous before release resolves');
  assert.equal(h.apply({ type: 'move', seq: 5, x: 0.2, y: 0.2 }).ok, false);
  await revoked;
  assert.equal(h.calls.at(-1).type, 'release');
  await h.grant({ sessionId: 'new-session' });
  assert.equal(h.apply({ type: 'move', seq: 1, x: 0.5, y: 0.5 }).ok, false);
  assert.equal(h.apply({ type: 'move', seq: 1, x: 0.5, y: 0.5 }, { sessionId: 'new-session' }).ok, true);
  await h.gate.revoke();
});

test('OS shortcut chords are blocked regardless of modifier ordering', async () => {
  for (const codes of [['AltLeft', 'Tab'], ['Tab', 'AltLeft'], ['ControlLeft', 'Escape'], ['ControlRight', 'AltLeft', 'Delete']]) {
    const h = harness();
    await h.grant();
    for (let i = 0; i < codes.length - 1; i++) assert.equal(h.apply({ type: 'keydown', code: codes[i], seq: i + 1 }).ok, true);
    assert.equal(h.apply({ type: 'keydown', code: codes.at(-1), seq: codes.length }).ok, false);
    await h.gate.revoke();
  }
});

test('release events remain allowed when the input budget is exhausted', async () => {
  const h = harness();
  await h.grant();
  assert.equal(h.apply({ type: 'keydown', code: 'ShiftLeft', seq: 1 }).ok, true);
  for (let seq = 2; seq <= 300; seq++) assert.equal(h.apply({ type: 'move', seq, x: 0.5, y: 0.5 }).ok, true);
  assert.equal(h.apply({ type: 'move', seq: 301, x: 0.5, y: 0.5 }).ok, false);
  assert.equal(h.apply({ type: 'keyup', code: 'ShiftLeft', seq: 302 }).ok, true);
  h.setTick(1000);
  assert.equal(h.apply({ type: 'wheel', seq: 303, deltaY: 120, deltaX: -120 }).ok, true);
  await h.gate.revoke();
});

test('approval expires after 15 minutes and releases held keys', async () => {
  const h = harness();
  await h.grant();
  h.apply({ type: 'keydown', seq: 1, code: 'KeyA' });
  h.setTick(15 * 60 * 1000);
  assert.equal(h.apply({ type: 'move', seq: 2, x: 0, y: 0 }).ok, false);
  assert.equal(h.gate.active, false);
  assert.equal(h.calls.at(-1).type, 'release');
  assert.match(h.failures[0], /expired/);
});

test('revoke while the helper is starting cannot re-enable control', async () => {
  let finish;
  let markStarted;
  const started = new Promise((resolve) => { markStarted = resolve; });
  const h = harness({ ready: () => new Promise((resolve) => { finish = resolve; markStarted(); }) });
  const start = h.grant();
  await started;
  assert.equal(h.gate.active, false);
  await h.gate.revoke();
  finish();
  assert.equal((await start).ok, false);
  assert.equal(h.gate.active, false);
});

test('overlapping grants allow only the newest locally approved session', async () => {
  const h = harness();
  const older = h.grant({ sessionId: 'older' });
  const newer = h.grant({ sessionId: 'newer' });
  assert.equal((await older).ok, false);
  assert.equal((await newer).ok, true);
  assert.equal(h.gate.status.sessionId, 'newer');
  await h.gate.revoke();
});

test('native helper failure or send failure closes the authorization boundary', async () => {
  let failed;
  const h = harness({ setFailureHandler(callback) { failed = callback; } });
  await h.grant();
  failed('Permission lost');
  assert.equal(h.gate.active, false);
  assert.equal(h.apply({ type: 'move', seq: 1, x: 0, y: 0 }).ok, false);
  const broken = harness({ send() { throw new Error('Helper pipe closed'); } });
  await broken.grant();
  assert.equal(broken.apply({ type: 'move', seq: 1, x: 0, y: 0 }).ok, false);
  assert.equal(broken.gate.active, false);
  assert.equal(broken.calls.at(-1).type, 'release');
});

test('grant validation rejects unavailable platforms and malformed identities/bounds', async () => {
  for (const changes of [
    { peerId: '' }, { sessionId: 'bad\nidentity' }, { peerId: 'x'.repeat(257) },
    { display: { x: 0, y: 0, width: 0, height: 1080 } },
    { display: { x: 0, y: 0, width: Infinity, height: 1080 } },
    { display: { x: 0.5, y: 0, width: 100, height: 100 } },
    { display: { x: 300000, y: 0, width: 100, height: 100 } },
  ]) {
    const h = harness();
    assert.equal((await h.grant(changes)).ok, false);
    assert.equal(h.gate.active, false);
  }
  const missing = harness({ available: false });
  assert.equal((await missing.grant()).ok, false);
  const bad = harness({ async ready() { throw new Error('Missing Accessibility permission'); } });
  assert.equal((await bad.grant()).ok, false);
  assert.equal(bad.gate.active, false);
  assert.equal(createAdapter({ platform: 'unsupported-platform' }).available, false);
  assert.equal(validateDisplay({ x: 0, y: 0, width: 1, height: 1 }).width, 1);
  assert.equal(canonicalKey({ key: 'a' }), 'KeyA');
  assert.equal(canonicalKey({ key: '7' }), 'Digit7');
  assert.equal(canonicalKey({ code: 'MetaRight' }), 'MetaRight');
});

test('macOS Command editing works while Command OS switching is blocked in either order', async () => {
  const h = harness({platform:'darwin'}); await h.grant();
  for (const [i, event] of [{type:'keydown',code:'MetaLeft'},{type:'keydown',code:'KeyC'},{type:'keyup',code:'KeyC'},{type:'keyup',code:'MetaLeft'}].entries()) assert.equal(h.apply({...event,seq:i+1}).ok,true);
  await h.gate.revoke();
  for(const codes of [['MetaLeft','Tab'],['Tab','MetaRight'],['MetaRight','Escape']]) {
    const guarded=harness({platform:'darwin'});await guarded.grant();
    assert.equal(guarded.apply({type:'keydown',code:codes[0],seq:1}).ok,true);
    assert.equal(guarded.apply({type:'keydown',code:codes[1],seq:2}).ok,false);
    await guarded.gate.revoke();
  }
});
