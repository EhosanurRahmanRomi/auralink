'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { listScreenSources, resolveScreenSource } = require('../src/core/screen-sources.cjs');

const screen = { id: 'screen:1:0', name: 'Display 1', display_id: '1', thumbnail: {} };
const windowSource = { id: 'window:12:0', name: 'Editor', thumbnail: {} };
const defer = () => { let resolve; let reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const mac = extra => ({ platform: 'darwin', getStatus: () => 'granted', isCurrent: () => true, ...extra });

test('denied, restricted, unknown and unreadable Mac permission do not enumerate or authorize sources', async () => {
  for (const status of ['denied', 'restricted', 'unknown', 'unexpected']) {
    let calls = 0;
    const options = mac({ getStatus: () => status, getSources: () => { calls++; return [screen]; } });
    const listed = await listScreenSources(options), resolved = await resolveScreenSource({ ...options, id: screen.id });
    assert.equal(listed.ok, false); assert.equal(listed.code, 'SCREEN_PERMISSION_REQUIRED');
    assert.equal(resolved.code, 'SCREEN_PERMISSION_REQUIRED'); assert.equal(calls, 0);
    assert.match(listed.reason, /System Settings/); assert.match(listed.reason, /Glance-Port/);
  }
  const result = await listScreenSources(mac({ getStatus: () => { throw new Error('TCC unavailable'); }, getSources: () => { throw new Error('Must not enumerate'); } }));
  assert.equal(result.status, 'unknown'); assert.equal(result.code, 'SCREEN_PERMISSION_REQUIRED');
});

test('fresh Mac identity makes one owner screen-only request then requires actual granted status', async () => {
  let status = 'not-determined'; const requests = [];
  const result = await listScreenSources(mac({ getStatus: kind => { assert.equal(kind, 'screen'); return status; }, getSources: async request => { requests.push(request); status = 'granted'; return [screen]; } }));
  assert.equal(result.ok, true); assert.equal(result.status, 'granted'); assert.equal(result.fallback, true); assert.equal(result.sources[0], screen);
  assert.deepEqual(requests, [{ types: ['screen'], thumbnailSize: { width: 0, height: 0 }, fetchWindowIcons: false }]);
  const blocked = await resolveScreenSource(mac({ id: screen.id, getStatus: () => 'not-determined', getSources: () => { throw new Error('Resolver cannot request consent'); } }));
  assert.equal(blocked.code, 'SCREEN_PERMISSION_REQUIRED');
});

test('refused first consent request gives settings guidance rather than native exception', async () => {
  for (const rejectNative of [false, true]) {
    let status = 'not-determined', calls = 0;
    const result = await listScreenSources(mac({ getStatus: () => status, getSources: async () => { calls++; status = 'denied'; if (rejectNative) throw new Error('Failed to get sources.'); return [screen]; } }));
    assert.equal(calls, 1); assert.equal(result.ok, false); assert.equal(result.code, 'SCREEN_PERMISSION_REQUIRED'); assert.equal(result.status, 'denied');
    assert.doesNotMatch(result.reason, /Failed to get sources/);
  }
});

test('unchanged not-determined status cannot authorize a native-returned screen', async () => {
  const result = await listScreenSources(mac({ getStatus: () => 'not-determined', getSources: async () => [screen] }));
  assert.equal(result.code, 'SCREEN_PERMISSION_REQUIRED'); assert.equal(result.status, 'not-determined');
});

test('granted mixed enumeration preserves actual screen and window objects without fallback', async () => {
  const requests = [];
  const result = await listScreenSources(mac({ getSources: async request => { requests.push(request); return [screen, windowSource]; } }));
  assert.equal(result.ok, true); assert.equal(result.fallback, false); assert.equal(result.sources[0], screen); assert.equal(result.sources[1], windowSource);
  assert.deepEqual(requests, [{ types: ['screen', 'window'], thumbnailSize: { width: 320, height: 180 }, fetchWindowIcons: false }]);
});

test('granted mixed failure or empty list retries real screen-only sources without thumbnails', async () => {
  for (const failure of ['reject', 'empty']) {
    const requests = [];
    const result = await listScreenSources(mac({ getSources: async request => { requests.push(request); if (requests.length === 1) { if (failure === 'reject') throw new Error('Failed to get sources.'); return []; } return [screen, windowSource, { id: 'fabricated', name: 'Unsafe' }]; } }));
    assert.equal(result.ok, true); assert.equal(result.fallback, true); assert.deepEqual(result.sources, [screen]);
    assert.deepEqual(requests[1], { types: ['screen'], thumbnailSize: { width: 0, height: 0 }, fetchWindowIcons: false });
    assert.equal(requests.length, 2);
  }
});

test('revocation during primary enumeration blocks fallback and returned sources', async () => {
  let status = 'granted', calls = 0;
  const result = await listScreenSources(mac({ getStatus: () => status, getSources: async () => { calls++; status = 'denied'; throw new Error('Native refused'); } }));
  assert.equal(result.code, 'SCREEN_PERMISSION_REQUIRED'); assert.equal(calls, 1);
});

test('revocation during fallback refuses the real source and keeps original consent decision', async () => {
  let status = 'granted', calls = 0;
  const result = await listScreenSources(mac({ getStatus: () => status, getSources: async () => { if (++calls === 1) throw new Error('Windows failed'); status = 'restricted'; return [screen]; } }));
  assert.equal(result.ok, false); assert.equal(result.code, 'SCREEN_PERMISSION_REQUIRED'); assert.equal(result.status, 'restricted'); assert.equal(calls, 2);
});

test('double native failure returns a safe unavailable result without raw exception text', async () => {
  const result = await listScreenSources(mac({ getSources: async () => { throw new Error('Private OS diagnostics'); } }));
  assert.equal(result.code, 'SCREEN_SOURCES_UNAVAILABLE'); assert.equal(result.status, 'granted'); assert.doesNotMatch(result.reason, /Private OS/);
});

test('source timeout never accepts a late granted status or late screen list', async () => {
  let status = 'not-determined', calls = 0; const pending = defer();
  const result = await listScreenSources(mac({ timeoutMs: 15, getStatus: () => status, getSources: () => { calls++; return pending.promise; } }));
  assert.equal(result.code, 'SCREEN_SOURCES_TIMEOUT'); assert.equal(result.ok, false); assert.equal(calls, 1);
  status = 'granted'; pending.resolve([screen]); await new Promise(resolve => setImmediate(resolve));
  assert.equal(result.ok, false); assert.equal(result.code, 'SCREEN_SOURCES_TIMEOUT'); assert.equal(calls, 1);
});

test('native rejection after a timeout is handled without a second request', async () => {
  const pending = defer(); let calls = 0;
  const result = await listScreenSources(mac({ timeoutMs: 15, getSources: () => { calls++; return pending.promise; } }));
  assert.equal(result.code, 'SCREEN_SOURCES_TIMEOUT'); pending.reject(new Error('Late native rejection')); await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 1);
});

test('overdue native completion cannot beat the deadline when it blocks the timer task', async () => {
  const blockingNative = () => {
    const until = Date.now() + 25;
    // Simulate a stalled native call: promise microtasks run before the overdue
    // timer task, so Promise.race alone would incorrectly accept this result.
    while (Date.now() < until) {}
    return [screen];
  };
  const listed = await listScreenSources(mac({ timeoutMs: 5, getSources: blockingNative }));
  assert.equal(listed.code, 'SCREEN_SOURCES_TIMEOUT'); assert.equal(listed.ok, false);
  const resolved = await resolveScreenSource(mac({ id: screen.id, timeoutMs: 5, getSources: blockingNative }));
  assert.equal(resolved.code, 'SCREEN_SOURCES_TIMEOUT'); assert.equal(resolved.ok, false);
});

test('room cancellation during native enumeration rejects the late list before authorization', async () => {
  let active = true; const pending = defer();
  const listing = listScreenSources(mac({ isCurrent: () => active, getSources: () => pending.promise }));
  await new Promise(resolve => setImmediate(resolve)); active = false; pending.resolve([screen]);
  assert.equal((await listing).code, 'SCREEN_SELECTION_CANCELED');
  let calls = 0; const canceled = await listScreenSources(mac({ isCurrent: () => false, getSources: () => { calls++; return [screen]; } }));
  assert.equal(canceled.code, 'SCREEN_SELECTION_CANCELED'); assert.equal(calls, 0);
});

test('cancellation before the queued native request prevents even enumeration', async () => {
  let active = true, calls = 0;
  const listing = listScreenSources(mac({ isCurrent: () => active, getSources: () => { calls++; return [screen]; } }));
  active = false;
  assert.equal((await listing).code, 'SCREEN_SELECTION_CANCELED'); assert.equal(calls, 0);
});

test('room cancellation during fallback rejects late native screen-only sources', async () => {
  let active = true, calls = 0; const started = defer(), pending = defer();
  const listing = listScreenSources(mac({ isCurrent: () => active, getSources: async () => { if (++calls === 1) throw new Error('Window list unavailable'); started.resolve(); return pending.promise; } }));
  await started.promise; active = false; pending.resolve([screen]);
  assert.equal((await listing).code, 'SCREEN_SELECTION_CANCELED'); assert.equal(calls, 2);
});

test('fallback timeout shares the original deadline and cannot authorize late sources', async () => {
  const pending = defer(); let calls = 0;
  const result = await listScreenSources(mac({ timeoutMs: 20, getSources: async () => { if (++calls === 1) throw new Error('Mixed refused'); return pending.promise; } }));
  assert.equal(result.code, 'SCREEN_SOURCES_TIMEOUT'); assert.equal(calls, 2); pending.resolve([screen]); await new Promise(resolve => setImmediate(resolve));
  assert.equal(result.ok, false);
});

test('resolver enumerates only the selected source type with zero thumbnails and exact ID', async () => {
  for (const source of [screen, windowSource]) {
    const requests = [];
    const result = await resolveScreenSource(mac({ id: source.id, getSources: async request => { requests.push(request); return [screen, windowSource]; } }));
    assert.equal(result.ok, true); assert.equal(result.source, source);
    assert.deepEqual(requests, [{ types: [source.id.split(':')[0]], thumbnailSize: { width: 0, height: 0 }, fetchWindowIcons: false }]);
  }
});

test('resolver never guesses an absent ID or allows malformed source types', async () => {
  for (const id of [undefined, '', 'camera:1', 'screen:', 'screen:1\n', 'screen:' + 'a'.repeat(501)]) {
    let calls = 0; const result = await resolveScreenSource(mac({ id, getSources: () => { calls++; return [screen]; } }));
    assert.equal(result.code, 'SCREEN_SOURCE_INVALID'); assert.equal(calls, 0);
  }
  const absent = await resolveScreenSource(mac({ id: 'screen:2:0', getSources: async () => [screen] }));
  assert.equal(absent.code, 'SCREEN_SOURCE_UNAVAILABLE'); assert.equal(absent.ok, false);
});

test('resolver rechecks Mac consent and room lifetime after enumeration', async () => {
  let status = 'granted';
  const denied = await resolveScreenSource(mac({ id: screen.id, getStatus: () => status, getSources: async () => { status = 'denied'; return [screen]; } }));
  assert.equal(denied.code, 'SCREEN_PERMISSION_REQUIRED');
  let active = true;
  const canceled = await resolveScreenSource(mac({ id: screen.id, isCurrent: () => active, getSources: async () => { active = false; return [screen]; } }));
  assert.equal(canceled.code, 'SCREEN_SELECTION_CANCELED');
});

test('resolver safely reports native failure and timeout', async () => {
  const failed = await resolveScreenSource(mac({ id: screen.id, getSources: async () => { throw new Error('Native secret'); } }));
  assert.equal(failed.code, 'SCREEN_SOURCES_UNAVAILABLE'); assert.doesNotMatch(failed.reason, /Native secret/);
  const pending = defer(); const timedOut = await resolveScreenSource(mac({ id: screen.id, timeoutMs: 15, getSources: () => pending.promise }));
  assert.equal(timedOut.code, 'SCREEN_SOURCES_TIMEOUT'); pending.resolve([screen]);
});

test('non-Mac enumeration does not apply Mac TCC gating or fallback policy', async () => {
  let calls = 0;
  const options = { platform: 'win32', getStatus: () => 'unknown', getSources: async () => { calls++; return [screen]; } };
  assert.equal((await listScreenSources(options)).ok, true); assert.equal((await resolveScreenSource({ ...options, id: screen.id })).ok, true); assert.equal(calls, 2);
  const failed = await listScreenSources({ ...options, getSources: async () => { calls++; throw new Error('Native refused'); } });
  assert.equal(failed.code, 'SCREEN_SOURCES_UNAVAILABLE'); assert.equal(calls, 3);
});
