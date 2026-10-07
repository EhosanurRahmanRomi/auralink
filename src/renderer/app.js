import { RoomRTC } from './rtc.js';

const icons = {
  grid: '<rect x="3" y="3" width="7" height="7" rx="2"/><rect x="14" y="3" width="7" height="7" rx="2"/><rect x="3" y="14" width="7" height="7" rx="2"/><rect x="14" y="14" width="7" height="7" rx="2"/>',
  monitor: '<rect x="3" y="3" width="18" height="13" rx="2"/><path d="M8 21h8m-4-5v5"/>',
  settings: '<path d="m9 3-1 3-3 1-2 3 2 3 1 3 3 1 1 3h4l1-3 3-1 2-3-1-3-1-3-3-1-1-3Z"/><circle cx="12" cy="12" r="3"/>',
  shield: '<path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6Z"/><path d="m8 12 3 3 5-6"/>',
  video: '<rect x="3" y="5" width="12" height="14" rx="3"/><path d="m15 9 6-3v12l-6-3"/>',
  'video-off': '<path d="m3 3 18 18M10 5h2a3 3 0 0 1 3 3v1l6-3v12l-3-1.5M15 15v1a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3V8"/>',
  mic: '<rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10v2a7 7 0 0 0 14 0v-2m-7 9v3m-4 0h8"/>',
  'mic-off': '<path d="m3 3 18 18M9 9v2a3 3 0 0 0 5 2M9 5a3 3 0 0 1 6 0v5M5 10v2a7 7 0 0 0 12 5m2-7v2m-7 7v3m-4 0h8"/>',
  link: '<path d="m10 13 4-4m-6 7-2 2a4 4 0 0 1-6-6l4-4a4 4 0 0 1 6 0m4 2a4 4 0 0 0 6 0l3-3a4 4 0 0 0-6-6l-2 2" transform="translate(1 1) scale(.92)"/>',
  plus: '<path d="M12 5v14M5 12h14"/>', arrow: '<path d="M4 12h16m-6-6 6 6-6 6"/>',
  lock: '<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V6a4 4 0 0 1 8 0v4m-4 5v2"/>',
  users: '<circle cx="9" cy="7" r="3"/><path d="M3 21v-3a6 6 0 0 1 12 0v3m1-17a3 3 0 0 1 0 6m2 4a5 5 0 0 1 3 5v2"/>',
  'user-plus': '<circle cx="8" cy="7" r="3"/><path d="M2 21v-3a6 6 0 0 1 12 0v3m4-14v8m-4-4h8"/>',
  pointer: '<path d="m4 3 7 18 3-7 7-3Zm10 11 6 6"/>',
  activity: '<path d="M2 12h5l3-8 4 16 3-8h5"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6m0-10h.01"/>',
  help: '<circle cx="12" cy="12" r="9"/><path d="M9 9a3 3 0 0 1 6 0c0 2-3 2-3 4m0 4h.01"/>',
  share: '<rect x="3" y="3" width="18" height="14" rx="2"/><path d="M8 21h8m-4-4v4m0-7V6m-3 3 3-3 3 3"/>',
  x: '<path d="m6 6 12 12M6 18 18 6"/>', check: '<path d="m5 12 4 4L19 6"/>',
  'phone-off': '<path d="M3 3 21 21M10 10a9 9 0 0 0 4 4m4 1 3 2v3c0 1-1 2-2 1A20 20 0 0 1 3 5c-1-1 0-2 1-2h3l2 3-1 3"/>',
  copy: '<rect x="8" y="8" width="13" height="13" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/>',
  maximize: '<path d="M8 3H3v5m13-5h5v5m0 8v5h-5m-8 0H3v-5"/>',
  minimize: '<path d="M3 8h5V3m8 0v5h5m0 8h-5v5m-8 0v-5H3"/>',
  refresh: '<path d="M20 7a9 9 0 0 0-15-2L3 8m0-5v5h5m-4 9a9 9 0 0 0 15 2l2-3m0 5v-5h-5"/>',
  keyboard: '<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M6 9h.01M10 9h.01M14 9h.01M18 9h.01M6 12h.01M10 12h.01M14 12h.01M18 12h.01M7 16h10"/>',
};
function icon(name) { return `<svg viewBox="0 0 24 24" aria-hidden="true">${icons[name] || icons.info}</svg>`; }
function paintIcons(root = document) { root.querySelectorAll('[data-icon]').forEach((el) => { el.innerHTML = icon(el.dataset.icon); }); }
paintIcons();
const $ = (id) => document.getElementById(id);
const bridge = window.auralink;
const state = {
  socket: null, rtc: null, selfId: null, hostId: null, isHost: false, joined: false, joining: false,
  peers: new Map(), tracks: new Map(), requests: new Map(), local: new Map(),
  room: null, selected: null, sourceId: null, grant: null, controlling: null, controlRequest: null,
  pendingControl: null, controlTimer: null, grantTimer: null, audioElements: new Map(), speakerPool: [], nativeInfo: null,
  audioContext: null, silentOutput: null, microphoneMonitor: null, microphoneTest: null, speaker: true, phoneScreen: null,
  mediaPending: new Set(), sharingPending: false,
  started: 0, lastMove: 0, seq: 0, pressed: new Set(), pressedButtons: new Set(), lastPoint: { x: .5, y: .5 }, statsTimer: null, durationTimer: null,
};
let preferences;
try { preferences = JSON.parse(localStorage.getItem('auralink.preferences') || '{}'); } catch { preferences = {}; }
preferences = { name: 'My device', quality: 'auto', stun: '', microphone: '', camera: '', speaker: '', ...preferences };
if (!['auto', '720', '1080', '1440'].includes(preferences.quality)) preferences.quality = 'auto';
preferences.name = String(preferences.name).slice(0, 48) || 'My device';
preferences.stun = String(preferences.stun || '');
for (const key of ['microphone', 'camera', 'speaker']) if (typeof preferences[key] !== 'string' || preferences[key].length > 256 || /[\x00-\x1f]/.test(preferences[key])) preferences[key] = '';
$('display-name').value = preferences.name;
$('join-name').value = preferences.name;
$('settings-quality').value = preferences.quality;
$('quality-select').value = preferences.quality;
$('stun-server').value = preferences.stun;

function savePreferences() {
  try { localStorage.setItem('auralink.preferences', JSON.stringify(preferences)); } catch { /* Private-browser storage can be unavailable. */ }
  $('profile-name').textContent = preferences.name;
  $('profile-initial').textContent = initials(preferences.name);
}
function initials(name) { return String(name).trim().split(/\s+/).slice(0, 2).map((part) => part[0] || '').join('').toUpperCase() || '?'; }
function cleanError(error) { return String(error?.message || error || 'Something went wrong').slice(0, 260); }
function toast(message, error = false, duration = 6500) {
  const el = document.createElement('div'); el.className = `toast${error ? ' error' : ''}`;
  el.textContent = message; $('toast-region').append(el);
  setTimeout(() => el.remove(), duration);
}
function setStatus(message, kind = '') {
  $('connection-pill').className = `status-pill ${kind}`;
  $('connection-pill').replaceChildren(document.createElement('i'), document.createTextNode(message));
}
function showView(name) {
  for (const view of ['rooms', 'devices', 'settings']) $(`view-${view}`).hidden = view !== name;
  document.querySelectorAll('.nav-item').forEach((el) => {
    el.classList.toggle('active', el.dataset.view === name);
    const dot = el.querySelector('.nav-indicator'); if (dot) dot.hidden = el.dataset.view !== name;
  });
  $('page-title').textContent = name[0].toUpperCase() + name.slice(1);
  if (name === 'devices') renderDevices();
}
function openDialog(id) { if (!$(id).open) $(id).showModal(); }
document.querySelectorAll('[data-close]').forEach((button) => button.addEventListener('click', () => button.closest('dialog').close()));
document.querySelectorAll('.nav-item').forEach((button) => button.addEventListener('click', () => showView(button.dataset.view)));
document.querySelector('.brand').addEventListener('click', (event) => { event.preventDefault(); showView('rooms'); });
$('help-button').addEventListener('click', () => openDialog('help-dialog'));
$('host-button').addEventListener('click', () => {
  if (!bridge?.hostRoom) { toast('Create a room in the desktop app. This browser can join a host invitation.', false); return; }
  openDialog('host-dialog');
});
$('join-button').addEventListener('click', () => { $('join-name').value = preferences.name; openDialog('join-dialog'); });
$('invite-button').addEventListener('click', () => {
  prepareInvite();
  $('invite-value').value = state.room?.invite || '';
  $('invite-fingerprint').textContent = state.room?.fingerprint || 'No fingerprint available';
  openDialog('invite-dialog');
});
function prepareInvite() {
  $('invite-address').replaceChildren();
  for (const entry of state.room?.invites || []) {
    const option = document.createElement('option'); option.value = entry.invite; option.textContent = `${entry.name} · ${entry.address}`;
    option.selected = entry.invite === state.room.invite; $('invite-address').append(option);
  }
  $('invite-address-label').hidden = !state.room?.invites?.length;
}
$('invite-address').addEventListener('change', () => { if (state.room) state.room.invite = $('invite-address').value; $('invite-value').value = $('invite-address').value; });
$('copy-invite').addEventListener('click', async () => {
  try { if (bridge?.copyText) await bridge.copyText($('invite-value').value); else await navigator.clipboard.writeText($('invite-value').value); toast('Invitation copied. Share it through a trusted channel.'); }
  catch { $('invite-value').focus(); $('invite-value').select(); toast('Select and copy the invitation from this field.'); }
});
$('review-requests').addEventListener('click', () => { renderRequests(); openDialog('requests-dialog'); });
$('diagnostics-toggle').addEventListener('click', () => { $('diagnostics').hidden = !$('diagnostics').hidden; refreshStats(); });
$('diagnostics-close').addEventListener('click', () => { $('diagnostics').hidden = true; });
$('fullscreen-button').addEventListener('click', async () => {
  try { if (document.fullscreenElement) await document.exitFullscreen(); else await $('stage').requestFullscreen(); }
  catch (error) { toast(`Fullscreen: ${cleanError(error)}`, true); }
});
document.addEventListener('fullscreenchange', () => {
  const active = document.fullscreenElement === $('stage'); const title = active ? 'Exit fullscreen' : 'Enter fullscreen';
  $('fullscreen-button').innerHTML = icon(active ? 'minimize' : 'maximize'); $('fullscreen-button').title = title; $('fullscreen-button').setAttribute('aria-label', title);
});

function makeAudioOutput() { const audio = document.createElement('audio'); audio.autoplay = true; audio.playsInline = true; audio.volume = 1; audio.className = 'mobile-audio'; return audio; }
function ensureSpeakerPool() { while (state.speakerPool.length + state.audioElements.size < 3) state.speakerPool.push(makeAudioOutput()); }
function audioContext() {
  const Constructor = window.AudioContext || window.webkitAudioContext;
  if (!Constructor) return null;
  if (!state.audioContext || state.audioContext.state === 'closed') state.audioContext = new Constructor({ latencyHint: 'interactive' });
  return state.audioContext;
}
function prepareListening() {
  // Called directly in a click/submit handler, before permission or network
  // awaits. Unlock these same output objects for tracks arriving later.
  const context = audioContext();
  if (context) {
    void context.resume().catch(() => {});
    if (!state.silentOutput) state.silentOutput = context.createMediaStreamDestination();
  }
  ensureSpeakerPool();
  for (const audio of state.speakerPool) {
    if (state.silentOutput) audio.srcObject = state.silentOutput.stream;
    void audio.play().catch(() => {});
  }
  for (const audio of state.audioElements.values()) void playRemoteAudio(audio);
}
async function updatePhoneAudioRoute() {
  if (bridge?.setAudioRoute) await bridge.setAudioRoute({ active: Boolean(state.joined || state.microphoneTest), speaker: state.speaker });
}
function updateAudioBanner() {
  const blocked = [...state.audioElements.values()].some(audio => audio.dataset.blocked === 'true');
  $('audio-banner').hidden = !blocked;
}
async function playRemoteAudio(audio) {
  try { await audio.play(); audio.dataset.blocked = 'false'; }
  catch { audio.dataset.blocked = 'true'; }
  updateAudioBanner();
}
$('hear-room').addEventListener('click', async () => {
  prepareListening(); await updatePhoneAudioRoute().catch(() => {});
  await Promise.all([...state.audioElements.values()].filter(audio => audio.srcObject).map(playRemoteAudio));
  if (!$('audio-banner').hidden) $('audio-banner-text').textContent = 'Playback is still blocked. Check your device sound permission, then tap Enable sound again.';
});
$('phone-speaker-toggle').addEventListener('click', async () => {
  state.speaker = !state.speaker;
  $('phone-speaker-toggle').textContent = state.speaker ? 'Speaker on' : 'Earpiece';
  $('phone-speaker-toggle').setAttribute('aria-pressed', String(state.speaker));
  try { await updatePhoneAudioRoute(); } catch (error) { toast(`Audio route: ${cleanError(error)}`, true); }
});
function mediaError(error, kind) {
  const name = kind === 'audio' ? 'microphone' : 'camera';
  if (['NotAllowedError', 'PermissionDeniedError'].includes(error?.name)) return `Allow ${name} access in your device privacy settings, then try again. ${kind === 'audio' ? 'Windows: Settings → Privacy & security → Microphone, including desktop apps.' : ''}`;
  if (['NotReadableError', 'TrackStartError'].includes(error?.name)) return `Your ${name} could not start. Close another app using it, check the device connection, or select System default in Preferences.`;
  if (error?.name === 'NotFoundError') return `No ${name} was found. Connect one and check the selected device in Preferences.`;
  return cleanError(error);
}
function startMicrophoneMonitor(stream, { test = false } = {}) {
  const context = audioContext(); if (!context) return null;
  void context.resume().catch(() => {});
  const input = context.createMediaStreamSource(stream); const analyser = context.createAnalyser();
  analyser.fftSize = 512; analyser.smoothingTimeConstant = .5;
  const silence = context.createGain(); silence.gain.value = 0;
  input.connect(analyser); analyser.connect(silence); silence.connect(context.destination);
  const samples = new Float32Array(analyser.fftSize); const meter = $(test ? 'test-mic-level' : 'mic-level');
  const status = $(test ? 'mic-test-status' : 'voice-status-text'); const track = stream.getAudioTracks()[0];
  let heard = false; let stopped = false;
  const tick = () => {
    if (stopped) return;
    analyser.getFloatTimeDomainData(samples);
    const level = Math.sqrt(samples.reduce((total, value) => total + value * value, 0) / samples.length);
    meter.value = Math.min(1, level * 5);
    if (level > .006) heard = true;
    if (track.muted) status.textContent = 'Microphone paused by your device';
    else if (test) status.textContent = heard ? 'Input detected. Your microphone is working.' : 'Listening… speak into your microphone.';
    else status.textContent = `${track.label || 'Microphone'} · ${heard ? 'input detected' : 'listening'}`;
  };
  tick(); const timer = setInterval(tick, 120);
  if (!test) $('voice-status').classList.add('active');
  return { stop() { stopped = true; clearInterval(timer); input.disconnect(); analyser.disconnect(); silence.disconnect(); meter.value = 0; } };
}
function stopMicrophoneMonitor() {
  state.microphoneMonitor?.stop(); state.microphoneMonitor = null;
  $('voice-status').classList.remove('active', 'error'); $('voice-status-text').textContent = 'Your microphone is off';
}
function stopMicrophoneTest() {
  const test = state.microphoneTest; state.microphoneTest = null;
  if (!test) return;
  clearTimeout(test.timer); test.monitor?.stop(); if (test.owned) test.stream.getTracks().forEach(track => track.stop());
  $('test-microphone').textContent = 'Test microphone';
  void updatePhoneAudioRoute().catch(() => {});
}
$('audio-check-open').addEventListener('click', () => { prepareListening(); openDialog('audio-check-dialog'); });
$('audio-check-dialog').addEventListener('close', stopMicrophoneTest);
$('test-microphone').addEventListener('click', async () => {
  if (state.microphoneTest) { stopMicrophoneTest(); $('mic-test-status').textContent = 'Microphone test stopped.'; return; }
  prepareListening(); $('test-microphone').disabled = true;
  try {
    const live = state.local.get('audio'); const stream = live?.stream || await captureMedia('audio');
    if (!$('audio-check-dialog').open) { if (!live) stream.getTracks().forEach(track => track.stop()); return; }
    const test = { stream, owned: !live, monitor: startMicrophoneMonitor(stream, { test: true }), timer: null };
    state.microphoneTest = test; $('test-microphone').textContent = 'Stop test';
    await updatePhoneAudioRoute();
    test.timer = setTimeout(() => { stopMicrophoneTest(); $('mic-test-status').textContent += ' Test finished.'; }, 10000);
    await refreshDevices();
  } catch (error) { stopMicrophoneTest(); $('mic-test-status').textContent = mediaError(error, 'audio'); }
  finally { $('test-microphone').disabled = false; }
});
$('test-speaker').addEventListener('click', async () => {
  prepareListening(); const context = audioContext(); if (!context) { $('speaker-test-status').textContent = 'Speaker test is unavailable in this browser.'; return; }
  $('test-speaker').disabled = true;
  let tone; let gain; let output; let audio;
  try {
    await context.resume();
    if (bridge?.setAudioRoute) await bridge.setAudioRoute({ active: true, speaker: state.speaker });
    output = context.createMediaStreamDestination(); tone = context.createOscillator(); gain = context.createGain();
    audio = makeAudioOutput(); audio.srcObject = output.stream;
    if (typeof audio.setSinkId === 'function') await audio.setSinkId(preferences.speaker).catch(() => audio.setSinkId(''));
    tone.frequency.value = 440; gain.gain.value = .07; tone.connect(gain); gain.connect(output); tone.start();
    await audio.play(); $('speaker-test-status').textContent = 'Playing a soft tone. If you hear it, your output is working.';
    await new Promise(resolve => setTimeout(resolve, 700));
  } catch (error) { $('speaker-test-status').textContent = `Sound could not play: ${cleanError(error)}`; }
  finally {
    tone?.stop(); tone?.disconnect(); gain?.disconnect(); audio?.pause(); if (audio) audio.srcObject = null;
    output?.stream.getTracks().forEach(track => track.stop()); $('test-speaker').disabled = false;
    await updatePhoneAudioRoute().catch(() => {});
  }
});
async function configureSpeakers(deviceId = preferences.speaker, warn = true) {
  ensureSpeakerPool();
  const outputs = [...state.speakerPool, ...state.audioElements.values()];
  if (typeof HTMLMediaElement.prototype.setSinkId !== 'function') return;
  // All output objects are configured during a user gesture. New participants
  // reuse these objects, so a remote track cannot trigger a speaker prompt.
  try { await Promise.all(outputs.map((audio) => audio.setSinkId(deviceId))); }
  catch (error) {
    await Promise.allSettled(outputs.map((audio) => audio.setSinkId('')));
    if (deviceId && warn) toast(`Selected speaker unavailable; using system default. ${cleanError(error)}`, true);
  }
}
const deviceSelections = [['audioinput', 'microphone-device', 'microphone', 'Microphone'], ['videoinput', 'camera-device', 'camera', 'Camera'], ['audiooutput', 'speaker-device', 'speaker', 'Speaker']];
const editedDeviceSelections = new Set();
let deviceRefreshGeneration = 0;
for (const [, selectId] of deviceSelections) $(selectId).addEventListener('change', () => editedDeviceSelections.add(selectId));
async function refreshDevices(warn = false) {
  if (!navigator.mediaDevices?.enumerateDevices) { $('device-help').textContent = 'Device selection requires a trusted HTTPS connection and browser support.'; return; }
  const generation = ++deviceRefreshGeneration;
  $('refresh-devices').disabled = true; $('refresh-devices').setAttribute('aria-busy', 'true');
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    if (generation !== deviceRefreshGeneration) return;
    for (const [kind, selectId, key, label] of deviceSelections) {
      const select = $(selectId); const chosen = editedDeviceSelections.has(selectId) ? select.value : preferences[key]; select.replaceChildren();
      const defaultOption = document.createElement('option'); defaultOption.value = ''; defaultOption.textContent = 'System default'; select.append(defaultOption);
      let number = 0;
      for (const device of devices.filter((item) => item.kind === kind && item.deviceId && item.deviceId !== 'default')) {
        const option = document.createElement('option'); option.value = device.deviceId; option.textContent = device.label || `${label} ${++number} · name hidden until permission`; select.append(option);
      }
      if (chosen && ![...select.options].some((option) => option.value === chosen)) {
        const previous = document.createElement('option'); previous.value = chosen; previous.textContent = 'Previously selected device · currently unavailable'; select.append(previous);
      }
      select.value = chosen;
    }
    $('device-help').textContent = devices.some((device) => device.label) ? 'Available equipment refreshed. Input changes apply the next time you enable mic or camera.' : 'Device names appear after camera or microphone permission. Refreshing does not enable either.';
  } catch (error) {
    if (generation !== deviceRefreshGeneration) return;
    $('device-help').textContent = 'Device list unavailable. You can still try the system default.'; if (warn) toast(cleanError(error), true);
  } finally {
    if (generation === deviceRefreshGeneration) { $('refresh-devices').disabled = false; $('refresh-devices').setAttribute('aria-busy', 'false'); }
  }
  const canSelectOutput = typeof HTMLMediaElement.prototype.setSinkId === 'function';
  $('speaker-device').disabled = !canSelectOutput;
  $('speaker-help').textContent = canSelectOutput ? 'Save preferences to apply to current room audio. Your saved output is applied when you next create or join.' : 'This browser uses its system audio output. Change speakers in your device sound settings.';
}
$('refresh-devices').addEventListener('click', () => refreshDevices(true));
navigator.mediaDevices?.addEventListener?.('devicechange', () => refreshDevices());

$('save-settings').addEventListener('click', async () => {
  const stun = $('stun-server').value.trim();
  if (stun && !/^stuns?:[^\s]{1,220}$/i.test(stun)) { toast('Enter a STUN address beginning with stun: or stuns:, or leave the field blank.', true); return; }
  preferences.name = $('display-name').value.trim().slice(0, 48) || 'My device';
  preferences.quality = $('settings-quality').value; preferences.stun = stun;
  preferences.microphone = $('microphone-device').value; preferences.camera = $('camera-device').value; preferences.speaker = $('speaker-device').value;
  editedDeviceSelections.clear();
  const speakers = configureSpeakers(preferences.speaker);
  $('quality-select').value = preferences.quality;
  savePreferences();
  await Promise.all([updateQuality(), speakers]);
  $('settings-saved').textContent = 'Preferences saved. Network changes apply to the next room.';
  toast('Preferences saved on this device.');
});
$('quality-select').addEventListener('change', async () => {
  preferences.quality = $('quality-select').value; $('settings-quality').value = preferences.quality; savePreferences(); await updateQuality();
});

function send(message) {
  if (state.socket?.readyState !== WebSocket.OPEN) return false;
  state.socket.send(JSON.stringify(message)); return true;
}
function validInvitation(value) {
  const url = new URL(value.trim());
  if (url.protocol !== 'https:') throw new Error('Use the complete HTTPS invitation from the host.');
  const hash = new URLSearchParams(url.hash.slice(1));
  const roomKey = hash.get('key'); const fingerprint = hash.get('fp');
  if (!roomKey || roomKey.length > 256) throw new Error('This invitation is missing its room key.');
  return { url: url.origin, invite: url.href, roomKey, fingerprint: fingerprint || '' };
}
$('host-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (state.joining || state.joined) return;
  prepareListening();
  $('create-room').disabled = true;
  try {
    await configureSpeakers();
    const result = await bridge.hostRoom({ name: $('host-name').value.trim() || 'My workspace', port: Number($('host-port').value) });
    const resultURL = result.url || new URL(result.invite).origin;
    const inviteData = result.invite ? validInvitation(result.invite) : null;
    state.room = { ...result, url: resultURL, roomKey: result.roomKey || inviteData?.roomKey, name: result.name || $('host-name').value, invite: result.invite };
    $('host-dialog').close();
    await connect(state.room, true);
  } catch (error) { toast(`Could not create the room: ${cleanError(error)}`, true); if (!state.joined) await leaveRoom(); }
  finally { $('create-room').disabled = false; }
});
$('join-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (state.joining || state.joined) { toast('Leave the current room before joining another.'); return; }
  prepareListening();
  $('join-submit').disabled = true;
  try {
    await configureSpeakers();
    preferences.name = $('join-name').value.trim().slice(0, 48) || 'My device'; $('display-name').value = preferences.name; savePreferences();
    let room = validInvitation($('join-invite').value);
    if (bridge?.trustInvite) room = { ...room, ...await bridge.trustInvite(room.invite) };
    state.room = { ...room, name: 'Private room' };
    $('join-dialog').close();
    await connect(state.room, false);
  } catch (error) { toast(`Could not request access: ${cleanError(error)}`, true); if (!state.joined) await leaveRoom(); }
  finally { $('join-submit').disabled = false; }
});

async function connect(room, isHost) {
  state.joining = true; state.isHost = isHost;
  showView('rooms'); $('lobby').hidden = true; $('session').hidden = false;
  $('room-title').textContent = room.name || 'Private room';
  $('session-eyebrow').textContent = isHost ? 'YOUR PRIVATE ROOM' : 'INVITED CONNECTION';
  $('invite-button').hidden = !isHost;
  $('session-subtitle').textContent = 'Connecting to the room host…';
  $('stage-empty-text').textContent = isHost ? 'Invite someone, then choose what you want to share.' : 'The host must approve your request before the session starts.';
  setStatus('Connecting…', 'waiting'); updateButtons();
  const socketURL = new URL('/ws', room.url); socketURL.protocol = 'wss:';
  const socket = bridge?.createSocket ? bridge.createSocket(socketURL.href) : new WebSocket(socketURL.href); state.socket = socket;
  socket.addEventListener('open', () => {
    send({ type: 'join', name: preferences.name, roomKey: room.roomKey, ...(isHost ? { hostToken: room.hostToken } : {}) });
    setStatus(isHost ? 'Opening room…' : 'Awaiting host approval', 'waiting');
  });
  socket.addEventListener('message', (event) => {
    try { const message = JSON.parse(event.data); handleMessage(message).catch((error) => toast(cleanError(error), true)); }
    catch { toast('An invalid room message was ignored.', true); }
  });
  socket.addEventListener('error', () => { toast('The host could not be reached. Check the address, certificate and network. Open Connection help for setup guidance.', true, 12000); });
  socket.addEventListener('close', () => {
    if (state.socket !== socket) return;
    const wasJoined = state.joined;
    leaveRoom().then(() => setStatus('Disconnected', 'error'));
    if (wasJoined) toast('The room connection ended. Media and desktop control have stopped.', true);
  });
}

async function handleMessage(message) {
  switch (message.type) {
    case 'pending':
      if (message.room?.name) $('room-title').textContent = message.room.name;
      $('session-subtitle').textContent = 'Your request is waiting for the host.'; setStatus('Awaiting host approval', 'waiting'); break;
    case 'welcome':
      state.selfId = message.selfId; state.hostId = message.hostId; state.joined = true; state.joining = false;
      $('stage-empty-text').textContent = 'Turn on your microphone for a conversation, or share a camera or screen.';
      void updatePhoneAudioRoute().catch(error => toast(`Audio output: ${cleanError(error)}`, true));
      if (message.room?.name || message.name || message.roomName) $('room-title').textContent = message.room?.name || message.roomName || message.name;
      state.rtc = new RoomRTC({ selfId: state.selfId, signal: (to, data) => send({ type: 'signal', to, data }), iceServers: preferences.stun ? [{ urls: preferences.stun }] : [] });
      state.rtc.setVideoLimits(preferences.quality);
      bindRTC();
      for (const peer of message.peers || []) addPeer(peer);
      state.started = Date.now();
      state.statsTimer = setInterval(refreshStats, 2000);
      state.durationTimer = setInterval(updateDuration, 1000);
      setStatus('Room connected'); updateRoomSubtitle(); updateButtons(); renderParticipants(); renderDevices();
      if (state.isHost) { prepareInvite(); $('invite-value').value = state.room.invite; $('invite-fingerprint').textContent = state.room.fingerprint || ''; openDialog('invite-dialog'); }
      else toast('The host accepted your request. Choose when to turn on your microphone or camera.');
      break;
    case 'join-request':
      if (state.isHost) { state.requests.set(message.peerId, { id: message.peerId, name: message.name || 'Guest' }); renderRequests(); toast(`${String(message.name || 'A guest').slice(0, 48)} is requesting to join.`); }
      break;
    case 'request-cancelled': case 'join-cancelled':
      state.requests.delete(message.peerId); renderRequests(); break;
    case 'peer-joined':
      addPeer(message.peer || { id: message.peerId, name: message.name, role: message.role });
      state.requests.delete(message.peer?.id || message.peerId); renderRequests(); updateRoomSubtitle(); break;
    case 'peer-left':
      await removePeer(message.peerId || message.id); break;
    case 'signal':
      if (message.data?.controlStop) {
        const sessionId = message.data.controlStop.sessionId;
        if (state.grant?.peerId === message.from && state.grant.sessionId === sessionId) await revokeControl('The controller released access.');
        if (state.controlling?.peerId === message.from && state.controlling.sessionId === sessionId) clearControlling('The screen owner stopped control.');
      } else state.rtc?.receive(message.from, message.data);
      break;
    case 'control-request': await receiveControlRequest(message); break;
    case 'control-response':
      if (message.accepted && typeof message.sessionId === 'string' && message.sessionId.length <= 128 && state.pendingControl === message.from && state.peers.has(message.from)) {
        clearTimeout(state.controlTimer); state.controlling = { peerId: message.from, sessionId: message.sessionId }; state.pendingControl = null; state.seq = 0;
        state.selected = { peerId: message.from, kind: 'screen' }; renderStage(); renderControl();
        toast('Control approved. Click the shared screen to send mouse and keyboard input. Press Esc to release keyboard focus.');
      } else if (!message.accepted && (!message.from || state.pendingControl === message.from)) {
        clearTimeout(state.controlTimer); state.pendingControl = null; toast(message.reason || 'The screen owner declined desktop control.'); updateButtons();
      }
      break;
    case 'control-granted':
      if (state.grant?.peerId === message.peerId && state.grant.sessionId === message.sessionId) { state.grant.confirmed = true; clearTimeout(state.grantTimer); }
      break;
    case 'control-revoked':
      if (state.grant?.sessionId === message.sessionId && state.grant.peerId === message.peerId) { state.grant = null; clearTimeout(state.grantTimer); await bridge?.revokeControl(); renderControl(); }
      break;
    case 'control-revoke':
      if (state.controlling?.peerId === message.from && state.controlling.sessionId === message.sessionId) clearControlling('The screen owner stopped control.');
      break;
    case 'join-rejected': case 'join-approved':
      if (state.isHost) { state.requests.delete(message.peerId); renderRequests(); }
      break;
    case 'rejected':
      toast(message.reason || 'The host declined your join request.', true); await leaveRoom(); break;
    case 'room-ended':
      toast(message.reason || 'The host closed the room.'); await leaveRoom(); break;
    case 'error':
      if (state.grant && !state.grant.confirmed) await revokeControl('The room did not confirm desktop control.');
      toast(message.message || message.reason || 'The room could not complete that request.', true); break;
  }
}

function addPeer(peer) {
  if (!peer?.id || peer.id === state.selfId || state.peers.has(peer.id)) return;
  const safe = { id: peer.id, name: String(peer.name || 'Guest').slice(0, 48), role: peer.role || (peer.id === state.hostId ? 'host' : 'guest'), connection: 'new', media: {} };
  state.peers.set(peer.id, safe); state.tracks.set(peer.id, new Map()); state.rtc?.addPeer(safe);
  renderParticipants(); renderDevices();
}
async function removePeer(peerId) {
  if (state.grant?.peerId === peerId) await revokeControl('The controller disconnected.');
  if (state.controlling?.peerId === peerId) clearControlling('The screen owner disconnected.');
  if (state.pendingControl === peerId) state.pendingControl = null;
  state.rtc?.removePeer(peerId); state.peers.delete(peerId); state.tracks.delete(peerId); state.requests.delete(peerId);
  const audio = state.audioElements.get(peerId); if (audio) { audio.srcObject = null; audio.dataset.blocked = 'false'; audio.remove(); state.audioElements.delete(peerId); state.speakerPool.push(audio); updateAudioBanner(); }
  if (state.selected?.peerId === peerId) state.selected = null;
  renderParticipants(); renderStage(); renderDevices(); renderRequests(); updateRoomSubtitle(); updateButtons();
}
function bindRTC() {
  state.rtc.addEventListener('track', ({ detail }) => {
    const tracks = state.tracks.get(detail.peerId); if (!tracks) return;
    tracks.set(detail.kind, { track: detail.track, stream: new MediaStream([detail.track]) });
    if (detail.kind === 'audio') attachAudio(detail.peerId, detail.track);
    if (detail.kind === 'screen') state.selected = { peerId: detail.peerId, kind: 'screen' };
    renderParticipants(); renderStage(); updateButtons();
  });
  state.rtc.addEventListener('track-removed', async ({ detail }) => {
    state.tracks.get(detail.peerId)?.delete(detail.kind);
    if (detail.kind === 'audio') { const audio = state.audioElements.get(detail.peerId); if (audio) { audio.srcObject = null; audio.dataset.blocked = 'false'; updateAudioBanner(); } }
    if (detail.kind === 'screen' && state.controlling?.peerId === detail.peerId) clearControlling('Screen sharing ended.');
    if (state.selected?.peerId === detail.peerId && state.selected.kind === detail.kind) state.selected = null;
    renderParticipants(); renderStage(); updateButtons();
  });
  state.rtc.addEventListener('media-state', ({ detail }) => { const peer = state.peers.get(detail.peerId); if (peer) peer.media = detail.state; renderParticipants(); });
  state.rtc.addEventListener('connection', ({ detail }) => {
    const peer = state.peers.get(detail.peerId); if (peer) peer.connection = detail.state;
    if (['failed', 'closed', 'disconnected'].includes(detail.state)) {
      if (state.grant?.peerId === detail.peerId) revokeControl('The controller connection was interrupted.');
      if (state.controlling?.peerId === detail.peerId) clearControlling('The remote connection was interrupted.');
    }
    renderDevices(); updateRoomSubtitle();
  });
  state.rtc.addEventListener('channel', ({ detail }) => {
    if (detail.open) return;
    if (state.grant?.peerId === detail.peerId) revokeControl('The desktop control channel closed.');
    if (state.controlling?.peerId === detail.peerId) {
      const { peerId, sessionId } = state.controlling;
      send({ type: 'signal', to: peerId, data: { controlStop: { sessionId } } }); clearControlling('The desktop control channel closed.');
    }
  });
  state.rtc.addEventListener('error', ({ detail }) => { console.warn('WebRTC negotiation:', detail.peerId, cleanError(detail.error)); toast('A media connection could not negotiate. Check Connection details and the network.', true); });
  state.rtc.addEventListener('data', async ({ detail }) => {
    const { peerId, data } = detail;
    if (data?.type !== 'input' || !state.grant?.confirmed || state.grant.peerId !== peerId || state.grant.sessionId !== data.sessionId || !state.local.has('screen')) return;
    if (!data.event || !Number.isSafeInteger(data.event.seq) || data.event.seq <= state.grant.lastSeq || !['move', 'down', 'up', 'wheel', 'keydown', 'keyup'].includes(data.event.type)) return;
    state.grant.lastSeq = data.event.seq;
    try { const result = await bridge?.applyInput({ peerId, sessionId: data.sessionId, event: data.event }); if (result?.ok === false && /not approved|expired|native input/i.test(result.reason || '')) await revokeControl('Desktop control authorization ended.'); }
    catch { await revokeControl('The desktop input service stopped.'); }
  });
}
function attachAudio(peerId, track) {
  let audio = state.audioElements.get(peerId);
  if (!audio) { ensureSpeakerPool(); audio = state.speakerPool.pop() || makeAudioOutput(); audio.dataset.peer = peerId; document.body.append(audio); state.audioElements.set(peerId, audio); }
  audio.muted = false; audio.volume = 1;
  audio.srcObject = new MediaStream([track]);
  track.addEventListener('unmute', () => { if (state.audioElements.get(peerId) === audio) void playRemoteAudio(audio); });
  void playRemoteAudio(audio);
}

function updateRoomSubtitle() {
  const count = state.peers.size + (state.joined ? 1 : 0);
  const connecting = [...state.peers.values()].some((peer) => peer.connection !== 'connected');
  $('session-subtitle').textContent = state.joined ? `${count} of 4 participants · ${connecting ? 'Establishing media connections' : 'Ready for audio, video and sharing'}` : 'Waiting for the host';
}
function renderRequests() {
  $('pending-banner').hidden = state.requests.size === 0; $('request-count').textContent = state.requests.size;
  $('request-list').replaceChildren();
  if (!state.requests.size) { const empty = document.createElement('p'); empty.className = 'empty-note'; empty.textContent = 'No pending requests.'; $('request-list').append(empty); }
  for (const [id, peer] of state.requests) {
    const row = document.createElement('div'); row.className = 'request-row';
    const avatar = document.createElement('div'); avatar.className = 'avatar avatar-small'; avatar.textContent = initials(peer.name);
    const name = document.createElement('strong'); name.textContent = peer.name;
    const actions = document.createElement('div');
    for (const [action, title] of [['reject', 'Decline'], ['approve', 'Accept']]) {
      const button = document.createElement('button'); button.className = `button ${action === 'approve' ? 'button-primary' : 'button-secondary'}`; button.textContent = title;
      button.addEventListener('click', () => { send({ type: action, peerId: id }); state.requests.delete(id); renderRequests(); }); actions.append(button);
    }
    row.append(avatar, name, actions); $('request-list').append(row);
  }
}
function getTrack(peerId, kind) { return peerId === state.selfId ? state.local.get(kind) : state.tracks.get(peerId)?.get(kind); }
function allParticipants() {
  const peers = [...state.peers.values()];
  return state.joined ? [{ id: state.selfId, name: `${preferences.name} (you)`, role: state.isHost ? 'host' : 'guest', local: true, media: Object.fromEntries([...state.local.keys()].map((key) => [key, true])) }, ...peers] : peers;
}
function renderParticipants() {
  $('participants').replaceChildren();
  for (const peer of allParticipants()) {
    const item = document.createElement('button'); item.className = 'participant'; item.setAttribute('aria-label', `View ${peer.name}`);
    item.classList.toggle('selected', state.selected?.peerId === peer.id);
    const camera = getTrack(peer.id, 'camera');
    if (camera) { const video = document.createElement('video'); video.autoplay = true; video.playsInline = true; video.muted = true; video.srcObject = camera.stream; item.append(video); }
    else { const background = document.createElement('div'); background.className = 'participant-avatar'; const avatar = document.createElement('div'); avatar.className = 'avatar'; avatar.textContent = initials(peer.name); background.append(avatar); item.append(background); }
    const role = document.createElement('span'); role.className = 'participant-role'; role.textContent = peer.role === 'host' ? 'HOST' : peer.local ? 'YOU' : 'GUEST'; item.append(role);
    const label = document.createElement('span'); label.className = 'participant-label'; const name = document.createElement('span'); name.textContent = peer.name;
    const badge = document.createElement('span'); badge.className = 'participant-icons'; badge.innerHTML = icon(peer.media?.audio ? 'mic' : 'mic-off') + (getTrack(peer.id, 'screen') ? icon('monitor') : '');
    label.append(name, badge); item.append(label);
    item.addEventListener('click', () => { state.selected = { peerId: peer.id, kind: getTrack(peer.id, 'screen') ? 'screen' : 'camera' }; renderStage(); renderParticipants(); updateButtons(); });
    $('participants').append(item);
  }
}
function renderStage() {
  let item = state.selected && getTrack(state.selected.peerId, state.selected.kind);
  if (!item) {
    const screenPeer = allParticipants().find((peer) => getTrack(peer.id, 'screen'));
    const cameraPeer = allParticipants().find((peer) => !peer.local && getTrack(peer.id, 'camera'));
    const selectedPeer = screenPeer || cameraPeer;
    state.selected = selectedPeer ? { peerId: selectedPeer.id, kind: screenPeer ? 'screen' : 'camera' } : null;
    item = state.selected && getTrack(state.selected.peerId, state.selected.kind);
  }
  const video = $('stage-video');
  if (item) {
    if (video.srcObject !== item.stream) video.srcObject = item.stream;
    video.muted = true; video.hidden = false; $('stage-empty').hidden = true; $('stage-label').hidden = false;
    const peerName = state.selected.peerId === state.selfId ? 'Your' : `${state.peers.get(state.selected.peerId)?.name || 'Participant'}’s`;
    $('stage-label-text').textContent = `${peerName} ${state.selected.kind === 'screen' ? 'screen' : 'camera'}`;
  } else {
    video.srcObject = null; video.hidden = true; $('stage-empty').hidden = false; $('stage-label').hidden = true;
  }
  const controlling = Boolean(state.controlling && state.selected?.peerId === state.controlling.peerId && state.selected.kind === 'screen');
  video.classList.toggle('controlling', controlling); video.tabIndex = controlling ? 0 : -1;
  renderRemoteTools();
  $('control-hint').hidden = !controlling; updateButtons();
}
function renderDevices() {
  $('device-list').replaceChildren();
  const devices = [{ id: state.selfId, name: preferences.name, local: true, role: state.isHost && state.joined ? 'Host' : 'This device', connection: state.joined ? 'connected' : 'local' }, ...state.peers.values()];
  for (const peer of devices) {
    const card = document.createElement('article'); card.className = 'device-card';
    const glyph = document.createElement('span'); glyph.className = 'device-icon'; glyph.innerHTML = icon('monitor');
    const name = document.createElement('h3'); name.textContent = peer.name;
    const detail = document.createElement('p'); detail.textContent = peer.local ? `${state.nativeInfo?.platform || bridge?.platform || 'Browser'} · ${state.joined ? 'In this room' : 'App open'}` : `${peer.role === 'host' ? 'Room host' : 'Room participant'} · Approved`;
    const status = document.createElement('div'); status.className = 'device-status'; const dot = document.createElement('span'); dot.className = 'local-dot';
    const statusLabel = peer.connection === 'connected' ? 'Connected' : peer.local ? 'Ready on this device' : `Media ${peer.connection || 'connecting'}`;
    status.append(dot, document.createTextNode(statusLabel)); card.append(glyph, name, detail, status); $('device-list').append(card);
  }
}

function updateButtons() {
  const ready = state.joined;
  for (const id of ['mic-button', 'camera-button', 'share-button']) $(id).disabled = !ready;
  if (state.mediaPending.has('audio')) $('mic-button').disabled = true;
  if (state.mediaPending.has('camera')) $('camera-button').disabled = true;
  if (state.sharingPending) $('share-button').disabled = true;
  if (bridge?.platform === 'android' && !bridge?.startScreenShare) $('share-button').disabled = true;
  for (const [kind, buttonId, onIcon, offIcon, onText, offText] of [
    ['audio', 'mic-button', 'mic', 'mic-off', 'Mic on', 'Mic off'],
    ['camera', 'camera-button', 'video', 'video-off', 'Camera on', 'Camera off'],
    ['screen', 'share-button', 'share', 'share', 'Stop sharing', 'Share screen'],
  ]) {
    const on = state.local.has(kind); const button = $(buttonId); button.classList.toggle('enabled', on);
    button.querySelector('[data-icon]').innerHTML = icon(on ? onIcon : offIcon); button.querySelector('small').textContent = on ? onText : offText;
    button.setAttribute('aria-label', on ? (kind === 'screen' ? 'Stop sharing screen' : `Turn ${kind === 'audio' ? 'microphone' : 'camera'} off`) : (kind === 'screen' ? 'Share screen' : `Turn ${kind === 'audio' ? 'microphone' : 'camera'} on`));
    if (kind === 'screen' && bridge?.platform === 'android' && !bridge?.startScreenShare) { button.querySelector('small').textContent = 'Phone sharing unavailable'; button.setAttribute('aria-label', 'Phone screen sharing is unavailable in this build'); }
  }
  const canRequest = ready && state.selected?.kind === 'screen' && state.selected.peerId !== state.selfId && !state.controlling && !state.pendingControl;
  $('request-control').disabled = !canRequest;
  $('request-control').querySelector('small').textContent = state.pendingControl ? 'Request pending' : state.controlling ? 'Controlling' : 'Request control';
  $('request-control').classList.toggle('enabled', Boolean(state.controlling));
  $('request-control').title = canRequest ? 'Ask the screen owner for desktop control' : 'Select another participant’s shared desktop to request control';
}

$('mic-button').addEventListener('click', () => toggleMedia('audio'));
$('camera-button').addEventListener('click', () => toggleMedia('camera'));
async function toggleMedia(kind) {
  if (!state.joined || state.mediaPending.has(kind)) return;
  const rtc = state.rtc;
  state.mediaPending.add(kind);
  prepareListening();
  const button = $(kind === 'audio' ? 'mic-button' : 'camera-button'); button.disabled = true;
  try {
    if (state.local.has(kind)) {
      const item = state.local.get(kind); state.local.delete(kind); await state.rtc.setTrack(kind, null); item.stream.getTracks().forEach((track) => track.stop());
      if (kind === 'audio') stopMicrophoneMonitor();
    } else {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error('Camera and microphone require a trusted HTTPS connection and browser support.');
      const stream = await captureMedia(kind);
      const track = stream.getTracks()[0];
      if (!state.joined || state.rtc !== rtc) { stream.getTracks().forEach((item) => item.stop()); return; }
      state.local.set(kind, { track, stream }); await state.rtc.setTrack(kind, track, stream);
      if (kind === 'audio') { stopMicrophoneMonitor(); state.microphoneMonitor = startMicrophoneMonitor(stream); await updatePhoneAudioRoute(); }
      await refreshDevices();
      track.addEventListener('ended', () => { if (state.local.get(kind)?.track === track) { state.local.delete(kind); state.rtc?.setTrack(kind, null); if (kind === 'audio') { stopMicrophoneMonitor(); $('voice-status-text').textContent = 'Microphone disconnected. Turn it on to retry.'; } updateButtons(); renderParticipants(); renderStage(); } });
    }
  } catch (error) { const message = mediaError(error, kind); if (kind === 'audio') { $('voice-status').classList.add('error'); $('voice-status-text').textContent = 'Microphone unavailable · check sound'; } toast(`${kind === 'audio' ? 'Microphone' : 'Camera'}: ${message}`, true, 12000); }
  finally { state.mediaPending.delete(kind); updateButtons(); renderParticipants(); renderStage(); }
}
async function captureMedia(kind) {
  if (bridge?.requestMedia) {
    const permission = await bridge.requestMedia(kind === 'audio' ? 'microphone' : 'camera');
    if (permission?.ok === false || permission?.granted === false || permission === false) throw new DOMException(permission?.reason || 'Device permission denied.', 'NotAllowedError');
  }
  const source = kind === 'audio' ? { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: { ideal: 1 }, sampleRate: { ideal: 48000 } } : { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30, max: 30 }, facingMode: { ideal: 'user' } };
  const deviceId = preferences[kind === 'audio' ? 'microphone' : 'camera'];
  const constraints = kind === 'audio' ? { audio: source, video: false } : { audio: false, video: source };
  if (deviceId) source.deviceId = { exact: deviceId };
  try { return await navigator.mediaDevices.getUserMedia(constraints); }
  catch (error) {
    if (!deviceId || !['NotFoundError', 'OverconstrainedError'].includes(error.name)) throw error;
    delete source.deviceId; toast(`Selected ${kind === 'audio' ? 'microphone' : 'camera'} unavailable; trying system default.`);
    preferences[kind === 'audio' ? 'microphone' : 'camera'] = ''; savePreferences();
    return navigator.mediaDevices.getUserMedia(constraints);
  }
}

$('share-button').addEventListener('click', async () => {
  if (!state.joined || state.sharingPending) return;
  if (state.local.has('screen')) { await stopSharing(); return; }
  state.sharingPending = true; updateButtons();
  try {
    if (bridge?.platform === 'android' && bridge?.startScreenShare) { await beginPhoneSharing(); return; }
    if (!navigator.mediaDevices?.getDisplayMedia) throw new Error('Screen capture is unavailable in this browser. Use the Android companion or a desktop app to share your screen.');
    if (bridge?.sources && bridge?.chooseScreen) await pickScreen();
    else await beginSharing();
  } catch (error) {
    if (state.phoneScreen || state.local.has('screen')) await stopSharing().catch(() => { state.local.delete('screen'); clearPhoneCapture(); });
    await bridge?.stopScreenShare?.().catch(() => {}); toast(`Screen sharing: ${cleanError(error)}`, true);
  }
  finally { state.sharingPending = false; updateButtons(); }
});
async function pickScreen() {
  const sources = await bridge.sources();
  if (!sources?.length) throw new Error('No displays or windows were available. Check screen-capture permissions.');
  $('screen-source-list').replaceChildren();
  for (const source of sources) {
    const button = document.createElement('button'); button.className = 'screen-source';
    if (typeof source.thumbnail === 'string' && source.thumbnail.startsWith('data:image/')) { const thumb = document.createElement('img'); thumb.src = source.thumbnail; thumb.alt = ''; button.append(thumb); }
    const name = document.createElement('span'); name.textContent = source.name; button.append(name);
    button.addEventListener('click', async () => {
      if (state.sharingPending) return;
      state.sharingPending = true; updateButtons();
      $('screen-source-list').querySelectorAll('button').forEach(sourceButton => { sourceButton.disabled = true; });
      try { await bridge.chooseScreen(source.id); state.sourceId = source.id; $('screen-dialog').close(); await beginSharing(); }
      catch (error) { state.sourceId = null; try { await bridge?.stopSharing?.(); } catch {} toast(`Screen sharing: ${cleanError(error)}`, true); }
      finally { state.sharingPending = false; updateButtons(); $('screen-source-list').querySelectorAll('button').forEach(sourceButton => { sourceButton.disabled = false; }); }
    });
    $('screen-source-list').append(button);
  }
  openDialog('screen-dialog');
}
function captureConstraints() {
  const sizes = { auto: [1920, 1080], '720': [1280, 720], '1080': [1920, 1080], '1440': [2560, 1440] };
  const [width, height] = sizes[preferences.quality];
  return { width: { ideal: width, max: width }, height: { ideal: height, max: height }, frameRate: { ideal: 30, max: 30 } };
}
async function beginSharing() {
  const rtc = state.rtc;
  const stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 30, max: 30 } }, audio: false });
  if (!state.joined || state.rtc !== rtc) { stream.getTracks().forEach((track) => track.stop()); return; }
  const track = stream.getVideoTracks()[0]; track.contentHint = 'detail';
  try { await track.applyConstraints(captureConstraints()); } catch { /* Use the source's actual capture mode; diagnostics reports it. */ }
  state.local.set('screen', { track, stream }); await state.rtc.setTrack('screen', track, stream);
  state.selected = { peerId: state.selfId, kind: 'screen' };
  track.addEventListener('ended', () => stopSharing());
  updateButtons(); renderParticipants(); renderStage();
}
async function beginPhoneSharing() {
  if (typeof MediaStreamTrackGenerator !== 'function' || typeof VideoFrame !== 'function') throw new Error('Update Android System WebView to enable phone screen streaming, including sharing while another app is open.');
  const rtc = state.rtc;
  $('share-button').disabled = true;
  const screen = await bridge.startScreenShare({ quality: preferences.quality === '720' || preferences.quality === 'auto' ? '720p' : '1080p', microphone: state.local.has('audio'), camera: state.local.has('camera') });
  if (!state.joined || state.rtc !== rtc) { await bridge.stopScreenShare(); return; }
  // Canvas capture waits for compositor paints, which stop when Android hides
  // the Activity. Feed explicitly decoded native frames into the media track
  // instead, while the owner-approved foreground projection remains active.
  const track = new MediaStreamTrackGenerator({ kind: 'video' }); track.contentHint = 'detail';
  const writer = track.writable.getWriter(); const stream = new MediaStream([track]);
  const capture = { writer, stream, active: true, busy: false, lastSeq: 0, timestamp: 0, unsubscribe: null };
  state.phoneScreen = capture; state.sourceId = screen.id || 'android-screen';
  capture.unsubscribe = bridge.onScreenFrame(async frame => {
    if (!capture.active || !state.joined || !frame || !Number.isSafeInteger(frame.seq) || frame.seq <= capture.lastSeq || typeof frame.data !== 'string' || !frame.data.startsWith('data:image/jpeg;base64,') || frame.data.length > 4000000) {
      if (Number.isSafeInteger(frame?.seq)) await bridge.ackScreenFrame({ seq: frame.seq }).catch(() => {}); return;
    }
    if (capture.busy) { await bridge.ackScreenFrame({ seq: frame.seq }).catch(() => {}); return; }
    capture.busy = true; capture.lastSeq = frame.seq;
    try {
      const image = new Image(); image.src = frame.data;
      await image.decode();
      if (!capture.active || state.phoneScreen !== capture) return;
      if (image.width < 1 || image.height < 1 || image.width > 1920 || image.height > 1920) throw new Error('Invalid phone frame size');
      capture.timestamp = Math.max(capture.timestamp + 1, Math.round(performance.now() * 1000));
      const videoFrame = new VideoFrame(image, { timestamp: capture.timestamp });
      try { await writer.write(videoFrame); } finally { videoFrame.close(); }
    } catch { /* A corrupt frame is skipped; the native capture can send the next. */ }
    finally { capture.busy = false; await bridge.ackScreenFrame({ seq: frame.seq }).catch(() => {}); }
  });
  state.local.set('screen', { track, stream }); await state.rtc.setTrack('screen', track, stream);
  state.selected = { peerId: state.selfId, kind: 'screen' }; track.addEventListener('ended', () => { if (state.phoneScreen === capture) void stopSharing(); });
  updateButtons(); renderParticipants(); renderStage();
  toast(screen.notificationAvailable === false ? 'Your phone screen is shared. Notifications are disabled: return to Auralink to stop sharing, or use Android’s capture control.' : 'Your phone screen is shared. Use the Android sharing notification or return here to stop.');
}
function clearPhoneCapture() {
  const capture = state.phoneScreen; state.phoneScreen = null;
  if (capture) {
    capture.active = false; capture.unsubscribe?.(); capture.stream.getTracks().forEach(track => track.stop());
    capture.writer.abort().catch(() => {}).finally(() => { try { capture.writer.releaseLock(); } catch {} });
  }
}
bridge?.onScreenStopped?.(reason => { if (state.phoneScreen) { void stopSharing(); toast(reason || 'Phone screen sharing stopped.'); } });
async function stopSharing() {
  if (state.grant) await revokeControl('Screen sharing stopped.');
  const item = state.local.get('screen'); state.local.delete('screen');
  await state.rtc?.setTrack('screen', null); item?.stream.getTracks().forEach((track) => track.stop());
  clearPhoneCapture();
  state.sourceId = null;
  try { await bridge?.stopScreenShare?.(); } catch { /* Android may already have stopped projection. */ }
  try { await bridge?.stopSharing?.(); } catch { /* Capture source may already be cleared. */ }
  if (state.selected?.peerId === state.selfId && state.selected.kind === 'screen') state.selected = null;
  updateButtons(); renderParticipants(); renderStage();
}
async function updateQuality() {
  const track = state.local.get('screen')?.track;
  if (state.phoneScreen) { toast('Phone capture quality applies when you start sharing again. Phone capture currently targets 12 fps up to 1080p.'); await state.rtc?.setVideoLimits(preferences.quality); return; }
  if (track) { try { await track.applyConstraints(captureConstraints()); } catch (error) { toast(`This source could not apply the requested ceiling: ${cleanError(error)}`, true); } }
  await state.rtc?.setVideoLimits(preferences.quality);
}

$('request-control').addEventListener('click', () => {
  const target = state.selected;
  if (!target || target.kind !== 'screen' || target.peerId === state.selfId || state.controlling || state.pendingControl) return;
  if (send({ type: 'control-request', to: target.peerId })) {
    state.pendingControl = target.peerId; updateButtons(); toast('Desktop control requested. The screen owner must approve it.');
    clearTimeout(state.controlTimer); state.controlTimer = setTimeout(() => { if (state.pendingControl === target.peerId) { state.pendingControl = null; updateButtons(); toast('Desktop control request expired. You can request again.'); } }, 60000);
  }
});
async function receiveControlRequest(message) {
  const peerId = message.from || message.peerId; const peer = state.peers.get(peerId);
  if (!peer) return;
  if (!bridge?.grantControl || !state.local.has('screen') || !(state.sourceId?.startsWith('screen:') || state.sourceId === 'android-screen') || state.grant || state.controlRequest) {
    send({ type: 'control-response', to: peerId, accepted: false, reason: !bridge?.grantControl ? 'This device supports viewing only; native desktop control is unavailable.' : 'The screen owner is not currently sharing an available full desktop.' }); return;
  }
  state.controlRequest = { peerId, name: peer.name, requestId: message.requestId };
  $('control-request-text').textContent = `${peer.name} wants to control your shared ${state.phoneScreen ? 'phone' : 'desktop'}. Approve only someone you trust. A system confirmation follows.${state.phoneScreen ? ' Android Accessibility must be enabled by you. Use the sharing notification to stop at any time.' : ''}`;
  openDialog('control-dialog');
}
$('deny-control').addEventListener('click', () => {
  if (state.controlRequest) send({ type: 'control-response', to: state.controlRequest.peerId, accepted: false });
  state.controlRequest = null; $('control-dialog').close();
});
$('control-dialog').addEventListener('cancel', () => {
  if (state.controlRequest) send({ type: 'control-response', to: state.controlRequest.peerId, accepted: false }); state.controlRequest = null;
});
$('allow-control').addEventListener('click', async () => {
  const request = state.controlRequest; if (!request) return;
  $('allow-control').disabled = true;
  try {
    const sessionId = crypto.randomUUID();
    const result = await bridge.grantControl({ peerId: request.peerId, screenId: state.sourceId, sessionId, name: request.name });
    if (!result?.ok || !state.joined || !state.local.has('screen') || !state.peers.has(request.peerId)) {
      send({ type: 'control-response', to: request.peerId, accepted: false, reason: result?.reason || 'The screen owner did not approve desktop control.' });
      await bridge.revokeControl(); return;
    }
    state.grant = { peerId: request.peerId, sessionId, lastSeq: 0, confirmed: false };
    send({ type: 'control-response', to: request.peerId, accepted: true, sessionId, requestId: request.requestId });
    state.grantTimer = setTimeout(() => { if (state.grant?.sessionId === sessionId && !state.grant.confirmed) revokeControl('Desktop control was not confirmed by the room.'); }, 5000);
    renderControl(); toast(`${request.name} can now control your shared display. Stop at any time.`);
  } catch (error) { send({ type: 'control-response', to: request.peerId, accepted: false, reason: 'Desktop control could not start.' }); toast(cleanError(error), true); }
  finally { state.controlRequest = null; $('control-dialog').close(); $('allow-control').disabled = false; }
});
async function revokeControl(reason) {
  const grant = state.grant; state.grant = null;
  clearTimeout(state.grantTimer);
  try { await bridge?.revokeControl(); } catch { /* Native process may already have stopped. */ }
  if (grant) send({ type: 'control-revoke', to: grant.peerId });
  renderControl(); if (reason && grant) toast(reason);
}
function clearControlling(reason) {
  releaseKeys(); clearTimeout(state.controlTimer); state.controlling = null; state.pendingControl = null; renderControl(); renderStage(); if (reason) toast(reason);
}
function renderControl() {
  const permission = state.grant || state.controlling;
  $('control-banner').hidden = !permission;
  if (state.grant) $('control-banner-text').textContent = `${state.peers.get(state.grant.peerId)?.name || 'A participant'} is controlling your desktop.`;
  else if (state.controlling) $('control-banner-text').textContent = `You have control of ${state.peers.get(state.controlling.peerId)?.name || 'the participant'}’s shared desktop.`;
  updateButtons(); renderRemoteTools();
}
$('stop-control').addEventListener('click', async () => {
  if (state.grant) await revokeControl('Desktop control stopped.');
  if (state.controlling) { const { peerId, sessionId } = state.controlling; releaseKeys(); send({ type: 'signal', to: peerId, data: { controlStop: { sessionId } } }); clearControlling('You released desktop control.'); }
});
bridge?.onEmergencyStop?.(reason => revokeControl(typeof reason === 'string' ? reason : 'Emergency stop: remote control revoked.'));
bridge?.onMediaError?.(async reason => {
  for (const kind of ['audio', 'camera']) {
    const item = state.local.get(kind); state.local.delete(kind);
    await state.rtc?.setTrack(kind, null); item?.stream.getTracks().forEach(track => track.stop());
  }
  stopMicrophoneMonitor(); updateButtons(); renderParticipants(); renderStage();
  toast(reason || 'Android stopped microphone and camera capture. Stop sharing, then enable them again.', true, 12000);
});
bridge?.onSessionStop?.((reason) => { leaveRoom(); toast(reason || 'The Android app moved to the background. Your room and media have stopped.'); });

function videoPoint(event, clamp = false) {
  const video = $('stage-video'); const rect = video.getBoundingClientRect();
  if (!video.videoWidth || !video.videoHeight) return null;
  const scale = Math.min(rect.width / video.videoWidth, rect.height / video.videoHeight);
  const width = video.videoWidth * scale; const height = video.videoHeight * scale;
  const left = rect.left + (rect.width - width) / 2; const top = rect.top + (rect.height - height) / 2;
  const x = (event.clientX - left) / width; const y = (event.clientY - top) / height;
  if (!clamp && (x < 0 || x > 1 || y < 0 || y > 1)) return null;
  return { x: Math.min(1, Math.max(0, x)), y: Math.min(1, Math.max(0, y)) };
}
function inputAllowed() { return state.controlling && state.selected?.peerId === state.controlling.peerId && state.selected.kind === 'screen'; }
function sendInput(event) {
  if (!inputAllowed()) return false;
  const { peerId, sessionId } = state.controlling;
  const sent = state.rtc?.sendData(peerId, { type: 'input', sessionId, event: { ...event, seq: ++state.seq } });
  if (!sent) {
    // An undelivered release can leave a native key or button held. Revoke via
    // the independent signaling connection instead of continuing this session.
    state.controlling = null; state.pendingControl = null; state.pressed.clear(); state.pressedButtons.clear();
    send({ type: 'signal', to: peerId, data: { controlStop: { sessionId } } });
    renderControl(); renderStage(); toast('The input channel could not deliver an event. Desktop control stopped.', true);
  }
  return Boolean(sent);
}
const stageVideo = $('stage-video');
stageVideo.addEventListener('pointermove', (event) => {
  if (!inputAllowed() || performance.now() - state.lastMove < 24) return;
  const point = videoPoint(event, state.pressedButtons.size > 0); if (!point) return;
  state.lastPoint = point; state.lastMove = performance.now(); sendInput({ type: 'move', ...point });
});
stageVideo.addEventListener('pointerdown', (event) => {
  if (!inputAllowed() || event.button > 2) return;
  const point = videoPoint(event); if (!point) return;
  event.preventDefault(); stageVideo.focus(); stageVideo.setPointerCapture(event.pointerId);
  state.lastPoint = point; state.pressedButtons.add(event.button); sendInput({ type: 'move', ...point }); sendInput({ type: 'down', button: event.button, ...point });
});
stageVideo.addEventListener('pointerup', (event) => {
  if (!inputAllowed() || event.button > 2) return;
  const point = videoPoint(event, true) || state.lastPoint; event.preventDefault(); state.pressedButtons.delete(event.button); state.lastPoint = point; sendInput({ type: 'up', button: event.button, ...point });
  if (stageVideo.hasPointerCapture(event.pointerId)) stageVideo.releasePointerCapture(event.pointerId);
});
stageVideo.addEventListener('pointercancel', releaseKeys);
stageVideo.addEventListener('contextmenu', (event) => { if (inputAllowed()) event.preventDefault(); });
stageVideo.addEventListener('wheel', (event) => {
  if (!inputAllowed()) return;
  const point = videoPoint(event); if (!point) return; event.preventDefault();
  const factor = event.deltaMode === 1 ? 20 : event.deltaMode === 2 ? 500 : 1;
  sendInput({ type: 'wheel', deltaX: Math.max(-1000, Math.min(1000, event.deltaX * factor)), deltaY: Math.max(-1000, Math.min(1000, event.deltaY * factor)), ...point });
}, { passive: false });
const allowedCodes = /^(Key[A-Z]|Digit[0-9]|Arrow(Up|Down|Left|Right)|Enter|Tab|Space|Backspace|Delete|Insert|Home|End|PageUp|PageDown|Shift(Left|Right)|Control(Left|Right)|Alt(Left|Right)|Meta(Left|Right)|CapsLock|Escape|Minus|Equal|BracketLeft|BracketRight|Backslash|Semicolon|Quote|Comma|Period|Slash|Backquote)$/;
stageVideo.addEventListener('keydown', (event) => {
  if (!inputAllowed()) return;
  if (event.code === 'Escape') { event.preventDefault(); releaseKeys(); stageVideo.blur(); toast('Keyboard focus released. Click the screen to resume control.'); return; }
  if (!allowedCodes.test(event.code)) return; event.preventDefault();
  if (event.repeat) return; state.pressed.add(event.code); sendInput({ type: 'keydown', code: event.code, key: event.key.slice(0, 32) });
});
stageVideo.addEventListener('keyup', (event) => {
  if (!inputAllowed() || !allowedCodes.test(event.code)) return; event.preventDefault(); state.pressed.delete(event.code); sendInput({ type: 'keyup', code: event.code, key: event.key.slice(0, 32) });
});
function releaseKeys() {
  for (const code of state.pressed) sendInput({ type: 'keyup', code }); state.pressed.clear();
  for (const button of state.pressedButtons) sendInput({ type: 'up', button, ...state.lastPoint }); state.pressedButtons.clear();
}
stageVideo.addEventListener('blur', releaseKeys);
window.addEventListener('blur', () => { releaseKeys(); clearRemoteText(); });
document.addEventListener('visibilitychange', () => { if (document.hidden) { releaseKeys(); clearRemoteText(); } });

// Phone software keyboards do not consistently produce physical DOM codes.
// Convert only supported ASCII into the same narrow, session-gated key path.
const remoteIME = { composing: false, lastComposition: null, timer: null };
const punctuationCodes = {
  '-': ['Minus', false], '_': ['Minus', true], '=': ['Equal', false], '+': ['Equal', true],
  '[': ['BracketLeft', false], '{': ['BracketLeft', true], ']': ['BracketRight', false], '}': ['BracketRight', true],
  '\\': ['Backslash', false], '|': ['Backslash', true], ';': ['Semicolon', false], ':': ['Semicolon', true],
  "'": ['Quote', false], '"': ['Quote', true], ',': ['Comma', false], '<': ['Comma', true],
  '.': ['Period', false], '>': ['Period', true], '/': ['Slash', false], '?': ['Slash', true],
  '`': ['Backquote', false], '~': ['Backquote', true], ' ': ['Space', false], '\n': ['Enter', false], '\r': ['Enter', false], '\t': ['Tab', false],
};
function clearRemoteText() {
  $('remote-text-input').value = ''; remoteIME.composing = false; remoteIME.lastComposition = null; clearTimeout(remoteIME.timer);
}
function renderRemoteTools() {
  const enabled = Boolean(inputAllowed()); $('remote-tools').hidden = !enabled;
  if (!enabled) {
    $('remote-keyboard-wrap').hidden = true; $('remote-keyboard-toggle').setAttribute('aria-expanded', 'false');
    clearRemoteText();
  }
}
function pressRemoteKey(code, shifted = false) {
  if (!inputAllowed() || !allowedCodes.test(code)) return false;
  if (shifted) { state.pressed.add('ShiftLeft'); if (!sendInput({ type: 'keydown', code: 'ShiftLeft' })) return false; }
  state.pressed.add(code);
  if (!sendInput({ type: 'keydown', code })) return false;
  if (!sendInput({ type: 'keyup', code })) return false; state.pressed.delete(code);
  if (shifted) { if (!sendInput({ type: 'keyup', code: 'ShiftLeft' })) return false; state.pressed.delete('ShiftLeft'); }
  return true;
}
function characterKey(character) {
  if (/^[a-z]$/.test(character)) return [`Key${character.toUpperCase()}`, false];
  if (/^[A-Z]$/.test(character)) return [`Key${character}`, true];
  if (/^[0-9]$/.test(character)) return [`Digit${character}`, false];
  const number = ')!@#$%^&*('.indexOf(character);
  if (number >= 0) return [`Digit${number}`, true];
  return punctuationCodes[character] || null;
}
function sendRemoteText(text) {
  $('remote-text-input').value = '';
  if (!inputAllowed()) return;
  releaseKeys();
  const characters = Array.from(String(text).replace(/\r\n/g, '\n'));
  let unsupported = false;
  for (const character of characters.slice(0, 32)) {
    const key = characterKey(character);
    if (!key) { unsupported = true; continue; }
    if (!pressRemoteKey(...key)) break;
  }
  if (unsupported) toast('Only English letters, numbers and basic ASCII punctuation are supported. Other characters were skipped.');
  if (characters.length > 32) toast('Only the first 32 characters were sent. Send longer text in smaller batches.');
}
$('remote-keyboard-toggle').addEventListener('click', () => {
  if (!inputAllowed()) return;
  releaseKeys();
  const open = $('remote-keyboard-wrap').hidden; $('remote-keyboard-wrap').hidden = !open;
  $('remote-keyboard-toggle').setAttribute('aria-expanded', String(open));
  clearRemoteText(); if (open) $('remote-text-input').focus(); else $('remote-text-input').blur();
});
$('remote-text-input').addEventListener('compositionstart', () => { remoteIME.composing = true; clearTimeout(remoteIME.timer); remoteIME.lastComposition = null; });
$('remote-text-input').addEventListener('compositionend', (event) => {
  if (!remoteIME.composing) { $('remote-text-input').value = ''; return; }
  remoteIME.composing = false;
  const text = $('remote-text-input').value || event.data || ''; remoteIME.lastComposition = text;
  sendRemoteText(text);
  remoteIME.timer = setTimeout(() => { remoteIME.lastComposition = null; }, 0);
});
$('remote-text-input').addEventListener('input', (event) => {
  if (event.isComposing || remoteIME.composing) return;
  if (remoteIME.lastComposition !== null && (event.data === remoteIME.lastComposition || String(event.inputType).includes('Composition'))) {
    $('remote-text-input').value = ''; remoteIME.lastComposition = null; return;
  }
  sendRemoteText($('remote-text-input').value);
});
$('remote-text-input').addEventListener('blur', () => { releaseKeys(); clearRemoteText(); });
for (const [buttonId, code] of [
  ['remote-enter', 'Enter'], ['remote-backspace', 'Backspace'], ['remote-tab', 'Tab'],
  ['remote-escape', 'Escape'], ['remote-home', 'Home'],
  ['remote-arrow-up', 'ArrowUp'], ['remote-arrow-down', 'ArrowDown'], ['remote-arrow-left', 'ArrowLeft'], ['remote-arrow-right', 'ArrowRight'],
]) $(buttonId).addEventListener('click', () => { if (!inputAllowed()) return; releaseKeys(); pressRemoteKey(code); });
$('remote-right-click').addEventListener('click', () => {
  if (!inputAllowed()) return; releaseKeys();
  if (!sendInput({ type: 'move', ...state.lastPoint })) return;
  state.pressedButtons.add(2); if (!sendInput({ type: 'down', button: 2, ...state.lastPoint })) return;
  if (sendInput({ type: 'up', button: 2, ...state.lastPoint })) state.pressedButtons.delete(2);
});
for (const [id, deltaY] of [['remote-scroll-up', -250], ['remote-scroll-down', 250]]) $(id).addEventListener('click', () => {
  if (!inputAllowed()) return; releaseKeys();
  if (!sendInput({ type: 'move', ...state.lastPoint })) return;
  sendInput({ type: 'wheel', deltaX: 0, deltaY, ...state.lastPoint });
});

async function refreshStats() {
  if (!state.rtc || $('diagnostics').hidden) return;
  const stats = await state.rtc.stats(); $('rtc-stats').replaceChildren();
  if (!stats.length) { const empty = document.createElement('p'); empty.className = 'empty-note'; empty.textContent = 'Invite a participant to see live measurements.'; $('rtc-stats').append(empty); }
  for (const measurement of stats) {
    const panel = document.createElement('div'); panel.className = 'stats-peer'; const name = document.createElement('strong'); name.textContent = measurement.name; panel.append(name);
    for (const [label, value] of [
      ['Media connection', measurement.state], ['Route', measurement.route ? `${measurement.route} · ${measurement.protocol || '—'}` : null],
      ['Round-trip latency', measurement.roundTripMs !== null ? `${measurement.roundTripMs} ms` : null],
      ['Download', measurement.downloadMbps !== null ? `${measurement.downloadMbps.toFixed(2)} Mbps` : null],
      ['Upload', measurement.uploadMbps !== null ? `${measurement.uploadMbps.toFixed(2)} Mbps` : null],
      ['Received video', measurement.incoming], ['Received frame rate', measurement.fps !== null ? `${measurement.fps} fps` : null],
      ['Received codec', measurement.incomingCodec], ['Sent video', measurement.outgoing], ['Sent codec', measurement.outgoingCodec], ['Packet loss (total)', measurement.packetLoss !== null ? `${measurement.packetLoss.toFixed(1)}%` : null],
      ['Audio received', measurement.receivedAudioPackets !== null ? `${measurement.receivedAudioPackets} packets` : null],
      ['Audio sent', measurement.sentAudioPackets !== null ? `${measurement.sentAudioPackets} packets` : null], ['Audio codec', measurement.audioCodec],
      ['Microphone level', measurement.microphoneLevel !== null ? `${Math.round(measurement.microphoneLevel * 100)}%` : null],
      ['Playback', state.audioElements.get(measurement.peerId)?.dataset.blocked === 'true' ? 'Tap Enable sound' : state.audioElements.get(measurement.peerId)?.srcObject ? 'Enabled' : 'No remote microphone'],
    ]) {
      const row = document.createElement('div'); row.className = 'stat-row'; const key = document.createElement('span'); key.textContent = label; const val = document.createElement('strong'); val.textContent = value ?? '—'; row.append(key, val); panel.append(row);
    }
    $('rtc-stats').append(panel);
  }
}
function updateDuration() {
  const seconds = Math.floor((Date.now() - state.started) / 1000); const min = Math.floor(seconds / 60);
  $('room-duration').textContent = `${String(min).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}
$('end-button').addEventListener('click', () => leaveRoom());
async function leaveRoom(stopHost = true) {
  stopMicrophoneTest(); stopMicrophoneMonitor(); clearPhoneCapture();
  await revokeControl();
  try { await bridge?.stopScreenShare?.(); } catch { /* Projection may already have ended. */ }
  try { await bridge?.stopSharing?.(); } catch { /* Native capture source may already be cleared. */ }
  releaseKeys(); state.controlling = null; state.pendingControl = null;
  const socket = state.socket; state.socket = null; socket?.close();
  clearInterval(state.statsTimer); clearInterval(state.durationTimer); state.statsTimer = null; state.durationTimer = null;
  clearTimeout(state.controlTimer); clearTimeout(state.grantTimer);
  state.rtc?.close(); state.rtc = null;
  for (const item of state.local.values()) item.stream.getTracks().forEach((track) => track.stop());
  for (const audio of state.audioElements.values()) { audio.srcObject = null; audio.remove(); state.speakerPool.push(audio); }
  state.audioElements.clear(); state.local.clear(); state.peers.clear(); state.tracks.clear(); state.requests.clear();
  if (document.fullscreenElement) { try { await document.exitFullscreen(); } catch {} }
  if (stopHost && state.isHost) { try { await bridge?.stopRoom(); } catch { /* Broker may already be stopped. */ } }
  state.isHost = false; state.joined = false; state.joining = false; state.selfId = null; state.hostId = null; state.selected = null; state.sourceId = null; state.controlRequest = null; state.room = null;
  $('audio-banner').hidden = true; await updatePhoneAudioRoute().catch(() => {});
  for (const dialog of document.querySelectorAll('dialog[open]')) dialog.close();
  $('session').hidden = true; $('lobby').hidden = false; $('room-duration').textContent = '00:00';
  setStatus('Ready on this device'); renderRequests(); renderParticipants(); renderStage(); renderDevices(); renderControl(); updateButtons();
}
window.addEventListener('beforeunload', () => { state.rtc?.close(); bridge?.revokeControl(); state.socket?.close(); });

async function initialize() {
  savePreferences();
  try { state.nativeInfo = await bridge?.getInfo?.(); } catch { /* Browser clients do not expose native information. */ }
  const browserPlatform = /Android/i.test(navigator.userAgent) ? 'Android browser' : /Macintosh/i.test(navigator.userAgent) ? 'Mac browser' : /Windows/i.test(navigator.userAgent) ? 'Windows browser' : 'Browser client';
  $('profile-platform').textContent = state.nativeInfo?.platform || bridge?.platform || browserPlatform;
  if (bridge?.platform === 'android') {
    if (preferences.quality === '1440') { preferences.quality = '1080'; savePreferences(); }
    for (const id of ['quality-select', 'settings-quality']) {
      const select = $(id); select.value = preferences.quality;
      const maximum = select.querySelector('option[value="1440"]'); if (maximum) { maximum.disabled = true; maximum.textContent = '1440p · desktop only'; }
      const phoneMaximum = select.querySelector('option[value="1080"]'); if (phoneMaximum) phoneMaximum.textContent = '1080p · phone maximum';
    }
    $('profile-platform').textContent = 'Android companion';
    $('host-button').disabled = true; $('host-button').title = 'Create rooms in Auralink for Windows or Mac';
    $('host-button').closest('.action-card').hidden = true;
    const caption = $('host-button').parentElement.querySelector('.card-caption');
    if (caption) { caption.replaceChildren(document.createTextNode('Room hosting is available in the desktop app')); }
    document.querySelector('.primary-card p').textContent = 'Create a room on Windows or Mac, then join it here for calls, viewing and approved desktop control.';
    document.querySelector('.primary-card h2').textContent = 'A desktop hosts the room';
    const connectionText = $('lobby').querySelector('.connection-note p');
    if (connectionText) connectionText.textContent = 'Join a desktop invitation, turn on sound, then share your phone through Android’s screen permission. To let someone help, enable Auralink Accessibility and approve their separate control request. Allow notifications to keep the Stop sharing action available outside the app.';
    $('share-button').title = 'Share your phone using Android screen-capture permission';
    $('phone-speaker-toggle').hidden = !bridge?.setAudioRoute;
  }
  renderDevices();
  await refreshDevices();
  if (!$('stage').requestFullscreen) { $('fullscreen-button').disabled = true; $('fullscreen-button').title = 'Fullscreen is unavailable in this browser'; }
  if (!bridge?.hostRoom) { $('host-button').querySelector('.button-label')?.remove(); $('host-button').title = 'Hosting requires the desktop app'; }
  consumeInvitation();
  updateButtons();
}
function consumeInvitation() {
  const params = new URLSearchParams(location.hash.slice(1));
  if (!params.has('key') || location.protocol !== 'https:') return;
  $('join-invite').value = location.href;
  try { history.replaceState(null, '', `${location.pathname}${location.search}`); } catch { /* Fragment remains local if history API unavailable. */ }
  if (state.joined || state.joining) toast('An invitation was received. Leave the current room before joining another.');
  else openDialog('join-dialog');
}
window.addEventListener('hashchange', consumeInvitation);
initialize();
