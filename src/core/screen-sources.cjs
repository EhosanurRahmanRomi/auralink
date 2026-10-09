'use strict';

const KNOWN_STATUS = new Set(['granted', 'denied', 'restricted', 'not-determined', 'unknown']);
const SOURCE_ID = /^(screen|window):[^\x00-\x1f\x7f]{1,500}$/;
const ZERO_THUMBNAIL = Object.freeze({ width: 0, height: 0 });

function accessStatus(options) {
  try {
    const status = options.getStatus?.('screen');
    return KNOWN_STATUS.has(status) ? status : 'unknown';
  } catch { return 'unknown'; }
}
function current(options) {
  try { return !options.isCurrent || options.isCurrent() === true; }
  catch { return false; }
}
function failure(code, status) {
  const reasons = {
    SCREEN_PERMISSION_REQUIRED: 'Allow Glance-Port Screen & System Audio Recording in System Settings → Privacy & Security. Quit and reopen Glance-Port after changing access, then try sharing again.',
    SCREEN_SELECTION_CANCELED: 'Screen selection was canceled because the room or display changed.',
    SCREEN_SOURCES_TIMEOUT: 'The system did not finish preparing the screen list. Check screen-recording access, quit and reopen Glance-Port, then try again.',
    SCREEN_SOURCES_UNAVAILABLE: 'The system could not list shareable displays or windows. Check screen-recording access, quit and reopen Glance-Port, then try again.',
    SCREEN_SOURCE_INVALID: 'Select an available display or window before sharing.',
    SCREEN_SOURCE_UNAVAILABLE: 'The selected display or window is no longer available. Select your screen again.'
  };
  return { ok: false, code, reason: reasons[code], status };
}
function checkpoint(options) {
  const status = accessStatus(options);
  if (!current(options)) return failure('SCREEN_SELECTION_CANCELED', status);
  if (options.platform === 'darwin' && status !== 'granted') return failure('SCREEN_PERMISSION_REQUIRED', status);
  return null;
}
function realSources(value, types) {
  if (!Array.isArray(value)) return [];
  // Keep only native-returned sources of the requested type. A display count or
  // guessed screen ID must never become permission to capture a different one.
  return value.filter(source => typeof source?.id === 'string' && SOURCE_ID.test(source.id) && types.includes(source.id.split(':')[0]));
}

async function enumerate(options, request, deadline) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) return { timedOut: true };
  let timer;
  try {
    // Attach rejection handling to the native promise even if the deadline wins.
    // Late completion can never continue into the authorization checks below.
    return await Promise.race([
      Promise.resolve().then(() => current(options) ? options.getSources(request) : undefined).then(value => ({ value }), () => ({ failed: true })),
      new Promise(resolve => { timer = setTimeout(() => resolve({ timedOut: true }), remaining); })
    ]);
  } finally { clearTimeout(timer); }
}
function deadlineFor(options) {
  const limit = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? Math.min(options.timeoutMs, 30000) : 30000;
  return Date.now() + limit;
}
function resultAfterEnumeration(options, result, deadline) {
  // A late permission change cannot override room cancellation or a timeout.
  if (!current(options)) return failure('SCREEN_SELECTION_CANCELED', accessStatus(options));
  // A native completion microtask can beat an overdue timer after a blocked
  // main loop. The elapsed deadline is authoritative, not timer scheduling.
  if (result.timedOut || Date.now() >= deadline) return failure('SCREEN_SOURCES_TIMEOUT', accessStatus(options));
  return checkpoint(options);
}
function requestFor(types, thumbnailSize) {
  return { types, thumbnailSize, fetchWindowIcons: false };
}

async function listScreenSources(options = {}) {
  const initialStatus = accessStatus(options);
  if (!current(options)) return failure('SCREEN_SELECTION_CANCELED', initialStatus);
  const deadline = deadlineFor(options);
  if (options.platform === 'darwin' && initialStatus !== 'granted') {
    if (initialStatus !== 'not-determined') return failure('SCREEN_PERMISSION_REQUIRED', initialStatus);
    // Screen permission has no Electron askForMediaAccess API. The owner's
    // Share action makes one native screen request so a new app identity can be
    // registered with macOS and the OS can show its consent UI.
    const result = await enumerate(options, requestFor(['screen'], ZERO_THUMBNAIL), deadline);
    const blocked = resultAfterEnumeration(options, result, deadline);
    if (blocked) return blocked;
    const available = realSources(result.value, ['screen']);
    if (result.failed || !available.length) return failure('SCREEN_SOURCES_UNAVAILABLE', accessStatus(options));
    return { ok: true, sources: available, status: accessStatus(options), fallback: true };
  }

  const result = await enumerate(options, requestFor(['screen', 'window'], { width: 320, height: 180 }), deadline);
  const blocked = resultAfterEnumeration(options, result, deadline);
  if (blocked) return blocked;
  const available = realSources(result.value, ['screen', 'window']);
  if (!result.failed && available.length) return { ok: true, sources: available, status: accessStatus(options), fallback: false };
  if (options.platform !== 'darwin') return failure('SCREEN_SOURCES_UNAVAILABLE', accessStatus(options));

  // A failed window/thumbnail path must not prevent a permitted full-display
  // share. This retry still uses native enumeration and fresh TCC/room checks.
  const fallback = await enumerate(options, requestFor(['screen'], ZERO_THUMBNAIL), deadline);
  const fallbackBlocked = resultAfterEnumeration(options, fallback, deadline);
  if (fallbackBlocked) return fallbackBlocked;
  const screens = realSources(fallback.value, ['screen']);
  if (fallback.failed || !screens.length) return failure('SCREEN_SOURCES_UNAVAILABLE', accessStatus(options));
  return { ok: true, sources: screens, status: accessStatus(options), fallback: true };
}

async function resolveScreenSource(options = {}) {
  const blocked = checkpoint(options);
  if (blocked) return blocked;
  if (typeof options.id !== 'string' || !SOURCE_ID.test(options.id)) return failure('SCREEN_SOURCE_INVALID', accessStatus(options));
  const type = options.id.split(':')[0];
  // Revalidate only the chosen source type. Reintroducing a window capturer for
  // a full-display choice would undo the permitted screen-only fallback.
  const deadline = deadlineFor(options);
  const result = await enumerate(options, requestFor([type], ZERO_THUMBNAIL), deadline);
  const after = resultAfterEnumeration(options, result, deadline);
  if (after) return after;
  const source = realSources(result.value, [type]).find(item => item.id === options.id);
  if (result.failed) return failure('SCREEN_SOURCES_UNAVAILABLE', accessStatus(options));
  if (!source) return failure('SCREEN_SOURCE_UNAVAILABLE', accessStatus(options));
  return { ok: true, source, status: accessStatus(options), fallback: false };
}

module.exports = { listScreenSources, resolveScreenSource };
