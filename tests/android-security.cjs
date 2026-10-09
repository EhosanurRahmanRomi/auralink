'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { X509Certificate } = require('node:crypto');
const https = require('node:https');
const WebSocket = require('ws');
const selfsigned = require('selfsigned');
const { createBroker } = require('../src/core/broker.cjs');
const { runCallAudioHarness } = require('./android-call-audio.cjs');

const root = path.resolve(__dirname, '..');
const resultsDir = path.join(root, 'test-results');
const fixtureDir = path.join(resultsDir, 'android-security-fixtures');
const classesDir = path.join(fixtureDir, 'classes');
const packageDir = path.join(root, 'android', 'src', 'local', 'auralink', 'mobile');
const evidence = { kind: 'JVM production-code and source-policy checks', physicalAndroid: false, emulator: false, nativeInputInjection: false, checks: {} };
const credentialFiles = [];
let broker; let host;
let internetServer; let internetWss;

async function executable(name) {
  const executableName = name + (process.platform === 'win32' ? '.exe' : '');
  if (process.env.JAVA_HOME) {
    const candidate = path.join(process.env.JAVA_HOME, 'bin', executableName);
    try { await fs.access(candidate); return candidate; } catch { /* Try the local bundled JDK next. */ }
  }
  const jdkRoot = path.join(root, '.tools', 'jdk');
  const entries = await fs.readdir(jdkRoot, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const candidate = path.join(jdkRoot, entry.name, 'bin', executableName);
    try { await fs.access(candidate); return candidate; } catch { /* Try next installed JDK. */ }
  }
  throw new Error('Set JAVA_HOME to JDK 21 or install the local JDK under .tools/jdk.');
}
function run(exe, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    const timer = setTimeout(() => { child.kill(); reject(new Error('Java security fixture exceeded 30 seconds.')); }, 30000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(`Java security fixture failed (${code}): ${stderr.slice(-6000)} ${stdout.slice(-1000)}`));
      else resolve({ stdout: stdout.trim(), stderr: stderr.trim() });
    });
  });
}
const fingerprint = certificate => new X509Certificate(certificate).fingerprint256.replaceAll(':', '').toLowerCase();
async function properties(name, values) {
  const filename = path.join(fixtureDir, name + '.properties');
  const escaped = Object.entries(values).map(([key, value]) => `${key}=${String(value).replaceAll('\\', '\\\\').replaceAll('\n', '\\n')}`).join('\n');
  await fs.writeFile(filename, escaped, { mode: 0o600 }); credentialFiles.push(filename); return filename;
}
async function makeCertificate(name, notBeforeDate, notAfterDate) {
  return selfsigned.generate([{ name: 'commonName', value: name }], { keyType: 'ec', curve: 'P-256', algorithm: 'sha256', notBeforeDate, notAfterDate });
}
async function connectHost() {
  host = new WebSocket(broker.url.replace(/^https:/, 'wss:') + '/ws', { rejectUnauthorized: false });
  let requests = 0;
  const ready = new Promise((resolve, reject) => {
    host.once('error', reject);
    host.on('message', raw => {
      const message = JSON.parse(raw.toString());
      if (message.type === 'welcome') resolve();
      if (message.type === 'join-request') { requests++; host.send(JSON.stringify({ type: 'approve', peerId: message.peerId })); }
    });
  });
  await new Promise((resolve, reject) => { host.once('open', resolve); host.once('error', reject); });
  host.send(JSON.stringify({ type: 'join', name: 'Authenticated local host fixture', roomKey: broker.roomKey, hostToken: broker.hostToken }));
  await ready;
  return () => requests;
}
async function sourcePolicies() {
  const activity = await fs.readFile(path.join(packageDir, 'AndroidRoomSession.java'), 'utf8');
  const window = await fs.readFile(path.join(packageDir, 'MainActivity.java'), 'utf8');
  const projection = await fs.readFile(path.join(packageDir, 'ScreenShareService.java'), 'utf8');
  const callService = await fs.readFile(path.join(packageDir, 'CallSessionService.java'), 'utf8');
  const control = await fs.readFile(path.join(packageDir, 'AttendedAccessibilityService.java'), 'utf8');
  const client = await fs.readFile(path.join(packageDir, 'PinnedRoomClient.java'), 'utf8');
  const manifest = await fs.readFile(path.join(root, 'android', 'AndroidManifest.xml'), 'utf8');
  assert.doesNotMatch(activity, /\.proceed\s*\(/, 'WebView never bypasses TLS errors');
  assert.doesNotMatch(activity, /setDefault(?:SSLSocketFactory|HostnameVerifier)\s*\(/, 'No global TLS trust override');
  for (const setter of ['setAllowFileAccess', 'setAllowContentAccess', 'setAllowFileAccessFromFileURLs', 'setAllowUniversalAccessFromFileURLs']) {
    assert.match(activity, new RegExp(setter + '\\s*\\(\\s*false\\s*\\)'), `${setter} is disabled`);
  }
  assert.match(activity, /MIXED_CONTENT_NEVER_ALLOW/, 'WebView mixed content is disabled');
  assert.match(activity, /onReceivedSslError/, 'WebView explicitly handles TLS errors');
  assert.match(activity, /\.cancel\s*\(/, 'WebView TLS errors are canceled');
  assert.match(activity, /RESOURCE_AUDIO_CAPTURE/, 'Microphone resource is explicitly named');
  assert.doesNotMatch(activity, /Manifest\.permission\.CAMERA|FOREGROUND_SERVICE_TYPE_CAMERA/, 'Native app cannot grant camera access or declare camera capture');
  assert.match(activity, /if\s*\(!PermissionRequest\.RESOURCE_AUDIO_CAPTURE\.equals\(resource\)\)\s*\{\s*request\.deny\(\);\s*return;/, 'Every resource other than microphone is denied before granting WebView capture');
  assert.doesNotMatch(activity, /\.grant\s*\(\s*\w+\.getResources\s*\(\s*\)\s*\)/, 'Unknown WebView permission resources are not granted blindly');
  const ownPause = activity.slice(activity.indexOf('private boolean ownPermissionPause()'), activity.indexOf('private final class NativeBridge'));
  assert.match(ownPause, /!foreground\s*&&\s*!destroyed/, 'Owned permission exception never applies to a destroyed activity');
  assert.match(ownPause, /runtimePermissionsPending\s*&&\s*mediaRequest\s*!=\s*null/, 'Microphone pause is scoped to an owned request');
  assert.match(ownPause, /projectionPermissionPending/, 'Screen consent pause is scoped to an owned request');
  assert.match(ownPause, /PAGE\.equals\(webView\.getUrl\(\)\)/, 'Paused transport requires the exact local document');
  const pauseDispatch = activity.slice(activity.indexOf('private void dispatch(String value)'), activity.indexOf('String id = "";', activity.indexOf('private void dispatch(String value)')));
  assert.match(pauseDispatch, /if\s*\(ownPermissionPause\(\)\s*\|\|\s*projectionSession\(\)\s*\|\|\s*callSession\(\)\)/, 'Paused native dispatch requires an owned permission prompt or explicit active foreground session');
  const backgroundMethods = [...pauseDispatch.matchAll(/!"([^"]+)"\.equals\(method\)/g)].map(match => match[1]);
  assert.deepEqual(backgroundMethods, ['sendSocket', 'closeSocket', 'ackScreenFrame', 'applyInput', 'revokeControl', 'stopScreenShare', 'setAudioRoute', 'setSystemAudio', 'ackSystemAudio'], 'Background bridge is confined to already-scoped transport, media routing, approved input and stop operations');
  const systemAudio = activity.slice(activity.indexOf('private void setSystemAudio('), activity.indexOf('private void cancelSystemAudioPermission('));
  const screenQuality = activity.slice(activity.indexOf('private void setScreenQuality('), activity.indexOf('private void clearProjectionRequest('));
  assert.match(screenQuality,/!trustedPage\(\)\s*\|\|\s*!roomMembership\.hasRoom\(\)/,'Live screen quality requires the foreground owner and an admitted room');
  assert.match(screenQuality,/!ticket\.equals\(projectionId\)\s*\|\|\s*!ScreenShareService\.active\(\)/,'Live screen quality is bound to the exact active projection');
  assert.match(screenQuality,/serial\s*!=\s*roomMembership\.epoch\(\)/,'A queued quality result cannot enter a replacement room');
  assert.doesNotMatch(screenQuality,/startProjection|createScreenCaptureIntent|requestPermissions|prepare\(/,'Quality changes never request another capture or grant');
  const qualityCapture = projection.slice(projection.indexOf('static void setQuality('),projection.indexOf('static void acknowledgePlaybackAudio('));
  assert.match(qualityCapture,/current\.capture\.post\(/,'Live output resize is serialized with image conversion on the capture thread');
  assert.match(qualityCapture,/!ticket\.equals\(current\.activeTicket\)/,'Queued resize rechecks capture ownership before modifying a surface');
  assert.doesNotMatch(qualityCapture,/stopPlaybackAudio|revoke\(|createVirtualDisplay|getMediaProjection/,'Quality changes preserve playback and normalized full-display input ownership');
  const consumeFrame = projection.slice(projection.indexOf('private void consumeFrame('),projection.indexOf('private Notification notification('));
  assert.ok(consumeFrame.indexOf('source != reader')<consumeFrame.indexOf('source.acquireLatestImage()'),'Callbacks queued by a closed prior reader are ignored before image acquisition');
  assert.ok(systemAudio.indexOf('if (!enabled)') < systemAudio.indexOf('if (!trustedPage())'), 'Background device audio can only stop; enabling requires the visible local document');
  assert.match(systemAudio, /capture\.equals\(projectionId\)/, 'Device audio requests are scoped to the current capture ticket');
  assert.doesNotMatch(systemAudio, /request\.grant|RESOURCE_AUDIO_CAPTURE|getUserMedia/, 'Playback permission does not grant or open a microphone');
  assert.doesNotMatch(pauseDispatch, /"(?:trustInvite|openSocket|copyText)"\.equals\(method\)/, 'Paused native dispatch cannot authorize a new invitation or privileged operation');
  const delivery = activity.slice(activity.indexOf('private void deliver(JSONObject value)'), activity.indexOf('private void reply(String id'));
  assert.match(delivery, /!transportPage\(\)/, 'Native delivery uses the scoped foreground, owned-prompt or projection guard');
  const transport = activity.slice(activity.indexOf('private boolean localDocument()'), activity.indexOf('private final class NativeBridge'));
  assert.match(transport, /localDocument\(\)\s*&&\s*\(ScreenShareService\.active\(\)\s*\|\|\s*projectionStarting\)/, 'Projection exception requires the exact bundled document and active or starting service');
  assert.match(activity, /main\.postDelayed\(projectionDeadline,\s*120000\)/, 'Owned projection prompt has a bounded deadline');
  assert.match(activity, /Manifest\.permission\.POST_NOTIFICATIONS/, 'Screen sharing requests an optional visible stop notification');
  assert.match(activity, /code\s*==\s*notificationPermissionCode\s*&&\s*projectionRequest\s*!=\s*null/, 'Notification result is bound to a still-pending owner screen request');
  assert.match(activity, /requestCode\s*!=\s*projectionPermissionCode\s*\|\|\s*projectionRequest\s*==\s*null/, 'An old Android screen consent result cannot complete a replacement request');
  assert.match(activity, /code\s*==\s*mediaPermissionCode\s*&&\s*mediaRequest\s*!=\s*null/, 'Android microphone results match only their current owned permission request');
  assert.match(activity, /projectionPermissionCode\s*=\s*newPermissionCode\(\)/, 'Each Android screen prompt receives a new native result code');
  assert.match(activity, /nextPermissionCode\s*>\s*65535\)\s*throw/, 'Native permission result identifiers fail closed rather than reuse an old request code');
  assert.match(activity, /notificationAvailable/, 'Native screen descriptor tells the renderer when the stop notification is unavailable');
  const approval = activity.slice(activity.indexOf('private void grantControl'), activity.indexOf('private void requestMedia'));
  assert.match(approval, /!trustedPage\(\)/, 'Native owner approval is unavailable in the background');
  assert.match(approval, /!roomMembership\.allows\(peerId\)/, 'Native owner approval requires a broker-admitted peer');
  assert.match(approval, /ScreenShareService\.activeFullDisplay\(\)/, 'Native owner approval requires a live full-display projection');
  assert.match(approval, /Allow control/, 'Native owner must explicitly approve input');
  assert.match(control, /isDeviceLocked\(\)/, 'Phone input is stopped at the lock screen');
  assert.match(control, /node\.isPassword\(\)/, 'Phone input refuses password field editing');
  assert.match(control, /TYPE_ACCESSIBILITY_OVERLAY/, 'Approved input exposes a system accessibility stop overlay');
  assert.match(control, /Stop control/, 'Overlay explicitly provides an immediate stop action');
  assert.match(projection, /registerCallback\(/, 'Projection registers its stop callback');
  assert.match(projection, /onCapturedContentResize/, 'Projection handles Android capture resizing');
  assert.match(projection, /START_NOT_STICKY/, 'Projection is never silently restarted by Android');
  assert.match(projection, /inFlight\s*!=\s*0/, 'Native screen frames are bounded to one pending delivery');
  assert.match(projection, /bytes\.size\(\)\s*>\s*524288/, 'Native JPEG size is bounded');
  assert.match(projection, /Stop sharing/, 'Screen service provides a stop notification action');
  assert.match(projection, /if\s*\(running\)\s*return\s*START_NOT_STICKY/, 'Delayed service intents do not stop a live projection');
  assert.match(projection, /ownership\.claim\(ticket\)/, 'Projection service starts only the current pending owner ticket');
  assert.match(projection, /cancelPreparation\(activeTicket\);\s*ownership\.release\(activeTicket\)/, 'Service teardown cancels and releases only its own capture ticket');
  assert.match(activity, /ScreenShareService\.stopCurrent\(ticket,\s*"Screen start was superseded\."\)/, 'Obsolete Activity start callback stops only its own projection');
  const events = activity.slice(activity.indexOf('private void event(long serial'), activity.indexOf('private void closeSocket()'));
  assert.match(events, /pausedEvents\.size\(\)\s*>=\s*64/, 'Incoming native events have a bounded pause queue');
  assert.match(events, /pausedEventBytes\s*\+\s*bytes\s*>\s*1048576/, 'Larger encrypted media cannot expand the paused queue beyond one MiB');
  assert.match(events, /generation\s*!=\s*serial/, 'Native event delivery rejects stale session generations');
  assert.match(events, /"message"\.equals\(type\)\s*&&\s*!observeBroker\(data\)\)\s*return/, 'Admission observer receives authenticated native socket traffic and can reject canceled welcomes before renderer delivery');
  const clearRoom = activity.slice(activity.indexOf('private void clearRoomState('), activity.indexOf('private void ensureCallService('));
  assert.match(clearRoom, /roomMembership\.clear\(\)/, 'Room exit clears native admitted identity and peers');
  assert.match(clearRoom, /clearProjectionRequest\(\)/, 'Room exit cancels pending phone capture consent');
  assert.match(clearRoom, /revokeControl\(reason\)/, 'Room exit revokes accessibility input authorization');
  assert.match(clearRoom, /ScreenShareService\.stopCurrent\(reason\)/, 'Room exit ends live phone capture');
  assert.doesNotMatch(clearRoom, /socket\s*=|closeSocket\(/, 'Leaving an Internet room retains its directory socket');
  assert.match(activity, /roomMembership\.endForEvent\(type\)/, 'Native observer handles authoritative Internet room exit events');
  assert.match(activity, /if\s*\(internetService\s*!=\s*null\)[\s\S]*roomMembership\.endForOutbound\(operation\)/, 'Internet room transitions clear native admission before awaiting a server response');
  assert.match(activity, /roomMembership\.expectAdmission\(outgoing\.optString\("roomId"\),\s*"join-device"\.equals\(operation\)\)/, 'Internet admission is expected only after an explicit native join request');
  assert.match(activity, /internetService\s*!=\s*null\s*&&\s*!roomMembership\.acceptsWelcome/, 'Internet native membership rejects unsolicited or canceled welcome traffic');
  assert.match(activity, /roomMembership\.observePending/, 'Internet native pending admission binds the assigned identity and room');
  // Inspect the real dispatch block, not its earlier background-method allowlist.
  const realSend = activity.slice(activity.indexOf('} else if ("sendSocket".equals(method))'), activity.indexOf('} else if ("closeSocket".equals(method))'));
  assert.ok(realSend.indexOf('clearRoomState(') < realSend.indexOf('socket.send(data)'), 'Room authorization is cleared synchronously before transition data leaves the native socket');
  assert.match(events, /!foreground\s*&&\s*\("close"\.equals\(type\)\s*\|\|\s*"error"\.equals\(type\)\)\)\s*\{\s*stopSession\(/, 'Background socket loss invalidates pending consent and destroys active media immediately');
  assert.match(activity, /"version",\s*installedVersion\(\)/, 'Android bridge reports the actual installed package version');
  assert.match(activity, /projectionGeneration\s*=\s*roomMembership\.epoch\(\)/, 'Phone capture consent is scoped to the admitted room, not the longer-lived directory socket');
  assert.match(activity, /mediaGeneration\s*!=\s*roomMembership\.epoch\(\)/, 'Old microphone permission completion cannot authorize a later Internet room');
  assert.match(activity, /roomMembership\.epoch\(\)\s*==\s*serial\s*&&\s*roomMembership\.hasRoom\(\)/, 'Screen frame delivery rejects callbacks from rooms already left');
  assert.match(activity, /"captureId",\s*ticket/, 'Native capture callbacks carry the opaque projection identity');
  assert.match(activity, /!ticket\.equals\(projectionId\)/, 'A stopped or started old projection cannot mutate a newer pending projection');
  const realStop = activity.slice(activity.indexOf('} else if ("stopScreenShare".equals(method))'), activity.indexOf('} else if ("ackScreenFrame".equals(method))'));
  assert.ok(realStop.indexOf('Objects.equals(projectionId') < realStop.indexOf('ScreenShareService.stopCurrent('), 'Scoped stale renderer cleanup is rejected before stopping the native service');
  assert.match(client, /setSocketFactory\(SSLContext\.getDefault\(\)\.getSocketFactory\(\)\)/, 'Internet sockets use the normal system CA trust store');
  assert.match(client, /setEndpointIdentificationAlgorithm\(internet\s*\?\s*"HTTPS"\s*:\s*null\)/, 'Internet hostname validation is distinct from LAN pin validation');
  const internetTrust = activity.slice(activity.indexOf('"trustInternetService".equals(method)'), activity.indexOf('"openSocket".equals(method)'));
  assert.doesNotMatch(internetTrust, /setHostnameVerifier|setSSLSocketFactory|PinnedTls/, 'Internet HTTPS health verification retains default certificate and hostname checks');
  assert.match(internetTrust, /setInstanceFollowRedirects\(false\)/, 'Internet health cannot silently switch to another authority');
  assert.match(activity, /internetService\s*!=\s*null\s*&&\s*invitation\s*==\s*null\s*&&\s*internetService\.matchesSocket\(address\)/, 'Internet sockets cannot reuse a LAN invitation trust namespace');
  const stopSession = activity.slice(activity.indexOf('private void stopSession()'), activity.indexOf('void pause()'));
  assert.match(stopSession, /generation\+\+/, 'Actual session loss invalidates the current session generation');
  assert.match(stopSession, /pausedEvents\.clear\(\)/, 'Actual session loss discards queued native events');
  assert.match(stopSession, /loadUrl\("about:blank"\)/, 'Actual session loss destroys the media document');
  const idlePause = activity.slice(activity.indexOf('private void pauseIdleSession()'), activity.indexOf('void pause()'));
  assert.doesNotMatch(idlePause, /loadUrl|destroy\(/, 'Ordinary backgrounding retains the local document rather than restarting the UI');
  assert.match(idlePause, /closeSocket\(\)/, 'An unadmitted directory or pending connection has no room background privilege');
  const lifecycle = activity.slice(activity.indexOf('void pause()'), activity.indexOf('private void dispose('));
  assert.match(lifecycle, /projectionSession\(\)\s*\|\|\s*callSession\(\)/, 'Existing explicit call or screen foreground service survives an Activity pause');
  assert.match(lifecycle, /if\s*\(!localDocument\(\)\)\s*webView\.loadUrl\(PAGE\)/, 'Returning reloads only an absent/untrusted document');
  assert.match(window, /session\.detach\(this,\s*isFinishing\(\)\)/, 'Activity destruction distinguishes closing from a replacement window');
  assert.doesNotMatch(window, /new WebView|closeSocket|stopSharing|\.destroy\(\)/, 'A replaceable Activity cannot destroy an admitted media session');
  assert.match(activity, /super\(application\.getApplicationContext\(\)\)/, 'Native session ownership has an application context');
  assert.match(activity, /WeakReference<MainActivity>/, 'The process session holds only a weak Activity reference');
  const detach = activity.slice(activity.indexOf('void detach('), activity.indexOf('void saveState('));
  assert.match(detach, /activity\.clear\(\);\s*viewContext\.setBaseContext\(getBaseContext\(\)\)/, 'Destroyed Activity is released from the WebView mutable context');
  assert.match(detach, /if\s*\(finishing\)\s*dispose\(/, 'An explicit Activity close disposes the session');
  assert.doesNotMatch(detach, /webView\.destroy|loadUrl|closeSocket|revokeControl\(/, 'Window replacement retains the same document, native connection and previously approved control');
  assert.match(detach, /mediaRequest\.deny\(\)/, 'An Activity replacement cancels pending microphone prompts');
  assert.match(detach, /clearProjectionRequest\(\)/, 'An Activity replacement cancels pending screen consent instead of restoring it');
  assert.match(callService, /ownership\.activeMatches\(ticket\)/, 'Wake leases renew only for the current service owner');
  assert.match(callService, /roomWakeLock\.acquire\(WAKE_LEASE_MS\)/, 'Room wake leases remain bounded while renewing for a live owned session');
  assert.match(callService, /main\.removeCallbacks\(renewRoomWakeLock\)/, 'Leaving the room cancels pending wake renewal');
  assert.match(callService, /START_NOT_STICKY/, 'Android never silently resumes an ended call');
  assert.match(callService, /End call/, 'The ongoing call notification has an owner stop action');
  assert.match(callService, /id\s*!=\s*null\s*&&\s*id\.equals\(ticket\)/, 'Notification stop is bound to the exact current call');
  assert.match(callService, /ownership\.claim\(id\)/, 'A delayed service start must match the current prepared room ticket');
  assert.match(activity, /!CallSessionService\.active\(callId\)\)\s*\{\s*request\.deny/, 'WebView microphone grant requires an already active foreground service');
  assert.match(activity, /if\s*\(!trustedPage\(\)\)\s*\{\s*failed\.run\(\);\s*return;/, 'Starting a new call service requires the visible bundled document');
  assert.match(activity, /!foreground\s*&&\s*!transportPage\(\)\)\s*\{\s*stopSession\(/, 'A background room exit destroys media after native authorization clears');
  assert.match(activity, /websocketRelayEnabled[\s\S]*RelayMediaPolicy\.validKey/, 'Larger relay messages require a negotiated admitted-room key');
  assert.match(activity, /roomMembership\.allows\(\(String\)peer\)/, 'Encrypted relay requires an admitted native sender or recipient');
  assert.match(manifest, /android:usesCleartextTraffic="false"/, 'Cleartext network traffic is disabled');
  assert.match(manifest, /android:allowBackup="false"/, 'Invitation/session data is excluded from backup');
  assert.match(manifest, /android:launchMode="singleTask"/, 'An invitation reuses the current Activity instead of restarting a call');
  assert.match(manifest, /android:scheme="auralink"\s+android:host="join"/, 'Android exposes only the intended app-link scheme and host');
  assert.match(activity, /AppInvitation\.parse\(intent\.getData\(\)\.toString\(\)\)/, 'OS invitations pass the strict native validator');
  assert.match(activity, /!invitationListenerReady/, 'Startup invitations wait until the renderer registers its listener');
  assert.match(manifest, /android:foregroundServiceType="connectedDevice\|mediaPlayback\|microphone"/, 'Open remote-device rooms have an explicit connectedDevice service type');
  assert.match(activity, /if\s*\(roomMembership\.hasRoom\(\)\)\s*ensureCallService\(ServiceInfo\.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE/, 'Only authenticated admission starts the visible room service');
  const permissions = [...manifest.matchAll(/<uses-permission\s+android:name="([^"]+)"/g)].map(match => match[1]);
  for (const permission of permissions) assert.ok(['android.permission.INTERNET', 'android.permission.RECORD_AUDIO', 'android.permission.MODIFY_AUDIO_SETTINGS', 'android.permission.ACCESS_NETWORK_STATE', 'android.permission.CHANGE_NETWORK_STATE', 'android.permission.FOREGROUND_SERVICE', 'android.permission.FOREGROUND_SERVICE_MEDIA_PROJECTION', 'android.permission.FOREGROUND_SERVICE_MICROPHONE', 'android.permission.FOREGROUND_SERVICE_MEDIA_PLAYBACK', 'android.permission.FOREGROUND_SERVICE_CONNECTED_DEVICE', 'android.permission.POST_NOTIFICATIONS', 'android.permission.WAKE_LOCK'].includes(permission), 'Unexpected Android privilege: ' + permission);
  for (const permission of ['android.permission.INTERNET', 'android.permission.RECORD_AUDIO']) assert.ok(permissions.includes(permission), 'Required screen/audio permission missing');
  assert.doesNotMatch(manifest, /android\.permission\.(?:CAMERA|FOREGROUND_SERVICE_CAMERA)|android\.hardware\.camera|foregroundServiceType="[^"]*camera/, 'Camera capabilities are absent from the actual screen/audio app manifest');
  evidence.checks.sourcePolicies = { passed: true, label: 'Static source assertions, not WebView runtime verification', permissions, permissionPausePolicy: 'Exact local document; owned bounded screen/media prompt; explicit active call or screen foreground service keeps existing transport; ordinary idle pause retains the UI document; real socket/service/renderer loss tears down media; no new background capture or owner approval; room tickets, relay bounds and native control authorization exercised in production JVM policy' };
}
async function main() {
  await fs.mkdir(classesDir, { recursive: true });
  const java = await executable('java'); const javac = await executable('javac');
  evidence.checks.callAudioLifecycle = await runCallAudioHarness({ run, javac, java, fixtureDir, packageDir });
  const libs = ['Java-WebSocket-1.6.0.jar', 'slf4j-api-2.0.13.jar'].map(name => path.join(root, 'android', 'libs', name));
  const classpath = libs.join(path.delimiter);
  const sources = ['Invitation.java', 'AppInvitation.java', 'InternetServiceEndpoint.java', 'PinnedTls.java', 'PinnedRoomClient.java', 'RoomMembership.java', 'ProjectionOwnership.java', 'ScreenCaptureQuality.java', 'RelayMediaPolicy.java', 'AttendedControlPolicy.java'].map(name => path.join(packageDir, name));
  await run(javac, ['--release', '8', '-cp', classpath, '-d', classesDir, ...sources, path.join(__dirname, 'android', 'AndroidSecurityHarness.java')]);
  evidence.checks.compile = { passed: true, javaTarget: 8, productionClasses: sources.map(filename => path.basename(filename)) };
  const now = Date.now();
  const [valid, expired, future, other] = await Promise.all([
    makeCertificate('Pinned fixture', new Date(now - 3600000), new Date(now + 86400000)),
    makeCertificate('Expired fixture', new Date(now - 3 * 86400000), new Date(now - 86400000)),
    makeCertificate('Future fixture', new Date(now + 86400000), new Date(now + 3 * 86400000)),
    makeCertificate('Other fixture', new Date(now - 3600000), new Date(now + 86400000)),
  ]);
  const validCertificate = path.join(fixtureDir, 'valid.pem'); const expiredCertificate = path.join(fixtureDir, 'expired.pem'); const futureCertificate = path.join(fixtureDir, 'future.pem');
  await Promise.all([fs.writeFile(validCertificate, valid.cert), fs.writeFile(expiredCertificate, expired.cert), fs.writeFile(futureCertificate, future.cert)]);
  broker = await createBroker({ host: '127.0.0.1', tls: { key: valid.private, cert: valid.cert }, name: 'Android security fixture' });
  const requestCount = await connectHost();
  const fp = fingerprint(valid.cert);
  const invitation = broker.url + '/#key=' + broker.roomKey + '&fp=' + fp;
  const props = await properties('valid', { invitation, origin: broker.url, roomKey: broker.roomKey, fingerprint: fp, validCertificate, expiredCertificate, expiredFingerprint: fingerprint(expired.cert), futureCertificate, futureFingerprint: fingerprint(future.cert), otherFingerprint: fingerprint(other.cert) });
  const javaArgs = ['-cp', classesDir + path.delimiter + classpath, 'local.auralink.mobile.AndroidSecurityHarness'];
  const policies = await run(java, [...javaArgs, 'policies', props]);
  evidence.checks.invitationAndPinPolicies = { passed: true, result: policies.stdout };
  const joined = await run(java, [...javaArgs, 'join', props]);
  assert.equal(requestCount(), 1, 'Real Java client requested exactly one owner admission');
  evidence.checks.realPinnedWssAdmission = { passed: true, result: joined.stdout, authenticatedHost: 'Local Node fixture', approvedGuest: 'Actual production Java WSS client' };
  const wrongProps = await properties('mismatch', { invitation: broker.url + '/#key=' + broker.roomKey + '&fp=' + fingerprint(other.cert) });
  const refused = await run(java, [...javaArgs, 'refuse', wrongProps]);
  assert.equal(requestCount(), 1, 'Wrong-pin client never sent its invitation key or admission request');
  evidence.checks.realWssPinMismatch = { passed: true, result: refused.stdout, additionalAdmissionRequests: 0 };
  await internetTransport(java, javaArgs);
  await sourcePolicies();
  evidence.passed = true;
}
async function internetTransport(java, javaArgs) {
  const now = Date.now();
  const ca = await selfsigned.generate([{ name: 'commonName', value: 'Test-only Internet fixture CA' }], {
    keyType: 'ec', curve: 'P-256', algorithm: 'sha256', notBeforeDate: new Date(now - 3600000), notAfterDate: new Date(now + 86400000),
    extensions: [{ name: 'basicConstraints', cA: true }, { name: 'keyUsage', keyCertSign: true, cRLSign: true }],
  });
  async function leaf() {
    return selfsigned.generate([{ name: 'commonName', value: 'localhost' }], {
      keyType: 'ec', curve: 'P-256', algorithm: 'sha256', notBeforeDate: new Date(now - 3600000), notAfterDate: new Date(now + 86400000),
      ca: { cert: ca.cert, key: ca.private },
      extensions: [{ name: 'basicConstraints', cA: false }, { name: 'keyUsage', digitalSignature: true },
        { name: 'extKeyUsage', serverAuth: true }, { name: 'subjectAltName', altNames: [{ type: 2, value: 'localhost' }] }],
    });
  }
  const first = await leaf();
  internetServer = https.createServer({ key: first.private, cert: first.cert }, (_request, response) => { response.writeHead(200); response.end('healthy fixture'); });
  internetWss = new WebSocket.WebSocketServer({ server: internetServer, path: '/internet/ws', maxPayload: 65536 });
  let registrations = 0;
  internetWss.on('connection', socket => socket.on('message', raw => {
    const message = JSON.parse(raw.toString());
    assert.equal(message.type, 'register'); registrations++;
    socket.send(JSON.stringify({ type: 'registered', deviceId: 'jvm-fixture' }));
  }));
  await new Promise((resolve, reject) => { internetServer.once('error', reject); internetServer.listen(0, '127.0.0.1', resolve); });
  const port = internetServer.address().port;
  const serviceProps = await properties('internet-valid', { service: `https://localhost:${port}` });
  const untrusted = await run(java, [...javaArgs, 'internet-refuse', serviceProps]);
  assert.equal(registrations, 0, 'Internet credentials never cross a self-signed or untrusted service chain');
  const caFile = path.join(fixtureDir, 'internet-test-ca.pem');
  const trustStore = path.join(fixtureDir, 'internet-test-trust.p12');
  await fs.writeFile(caFile, ca.cert); credentialFiles.push(caFile, trustStore);
  await fs.unlink(trustStore).catch(() => {});
  const keytool = await executable('keytool');
  await run(keytool, ['-importcert', '-noprompt', '-alias', 'test-only-ca', '-file', caFile, '-keystore', trustStore, '-storetype', 'PKCS12', '-storepass', 'test-only-password']);
  const trustedArgs = [`-Djavax.net.ssl.trustStore=${trustStore}`, '-Djavax.net.ssl.trustStoreType=PKCS12', '-Djavax.net.ssl.trustStorePassword=test-only-password', ...javaArgs];
  const accepted = await run(java, [...trustedArgs, 'internet-join', serviceProps]);
  assert.equal(registrations, 1, 'Normal CA plus DNS validation allows exactly one registration');
  const wrongHostProps = await properties('internet-hostname-mismatch', { service: `https://127.0.0.1:${port}` });
  const wrongHost = await run(java, [...trustedArgs, 'internet-refuse', wrongHostProps]);
  assert.equal(registrations, 1, 'Trusted certificate for another hostname cannot receive registration credentials');
  const rotated = await leaf();
  assert.notEqual(fingerprint(rotated.cert), fingerprint(first.cert), 'Certificate rotation uses a genuinely different leaf');
  internetServer.setSecureContext({ key: rotated.private, cert: rotated.cert });
  const rotation = await run(java, [...trustedArgs, 'internet-join', serviceProps]);
  assert.equal(registrations, 2, 'A newly CA-signed certificate for the same DNS identity remains accepted without stale pinning');
  evidence.checks.internetSystemPki = { passed: true, trust: 'Isolated test-only JVM CA store; production uses the device system CA store', untrusted: untrusted.stdout,
    accepted: accepted.stdout, wrongHostname: wrongHost.stdout, certificateRotation: rotation.stdout, registrations };
}
main().catch(error => { evidence.passed = false; evidence.error = error.message; process.exitCode = 1; }).finally(async () => {
  if (host) host.terminate(); if (broker) await broker.stop();
  if (internetWss) { for (const socket of internetWss.clients) socket.terminate(); await new Promise(resolve => internetWss.close(resolve)); }
  if (internetServer) await new Promise(resolve => internetServer.close(resolve));
  for (const filename of credentialFiles) await fs.unlink(filename).catch(() => {});
  await fs.mkdir(resultsDir, { recursive: true });
  await fs.writeFile(path.join(resultsDir, 'android-security.json'), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence, null, 2));
});
