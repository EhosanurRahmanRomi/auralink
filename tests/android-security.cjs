'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { X509Certificate } = require('node:crypto');
const WebSocket = require('ws');
const selfsigned = require('selfsigned');
const { createBroker } = require('../src/core/broker.cjs');

const root = path.resolve(__dirname, '..');
const resultsDir = path.join(root, 'test-results');
const fixtureDir = path.join(resultsDir, 'android-security-fixtures');
const classesDir = path.join(fixtureDir, 'classes');
const packageDir = path.join(root, 'android', 'src', 'local', 'auralink', 'mobile');
const evidence = { kind: 'JVM production-code and source-policy checks', physicalAndroid: false, emulator: false, nativeInputInjection: false, checks: {} };
const credentialFiles = [];
let broker; let host;

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
  const activity = await fs.readFile(path.join(packageDir, 'MainActivity.java'), 'utf8');
  const projection = await fs.readFile(path.join(packageDir, 'ScreenShareService.java'), 'utf8');
  const control = await fs.readFile(path.join(packageDir, 'AttendedAccessibilityService.java'), 'utf8');
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
  assert.match(activity, /RESOURCE_VIDEO_CAPTURE/, 'Camera resource is explicitly named');
  assert.doesNotMatch(activity, /\.grant\s*\(\s*\w+\.getResources\s*\(\s*\)\s*\)/, 'Unknown WebView permission resources are not granted blindly');
  const ownPause = activity.slice(activity.indexOf('private boolean ownPermissionPause()'), activity.indexOf('private final class NativeBridge'));
  assert.match(ownPause, /!foreground\s*&&\s*!destroyed/, 'Owned permission exception never applies to a destroyed activity');
  assert.match(ownPause, /runtimePermissionsPending\s*&&\s*mediaRequest\s*!=\s*null/, 'Microphone/camera pause is scoped to an owned request');
  assert.match(ownPause, /projectionPermissionPending/, 'Screen consent pause is scoped to an owned request');
  assert.match(ownPause, /PAGE\.equals\(webView\.getUrl\(\)\)/, 'Paused transport requires the exact local document');
  const pauseDispatch = activity.slice(activity.indexOf('private void dispatch(String value)'), activity.indexOf('String id = "";', activity.indexOf('private void dispatch(String value)')));
  assert.match(pauseDispatch, /if\s*\(ownPermissionPause\(\)\s*\|\|\s*projectionSession\(\)\)/, 'Paused native dispatch requires an owned permission prompt or active screen service');
  const backgroundMethods = [...pauseDispatch.matchAll(/!"([^"]+)"\.equals\(method\)/g)].map(match => match[1]);
  assert.deepEqual(backgroundMethods, ['sendSocket', 'closeSocket', 'ackScreenFrame', 'applyInput', 'revokeControl', 'stopScreenShare'], 'Background bridge is confined to already-scoped transport, delivery acknowledgement, approved input and stop operations');
  assert.doesNotMatch(pauseDispatch, /"(?:trustInvite|openSocket|copyText)"\.equals\(method\)/, 'Paused native dispatch cannot authorize a new invitation or privileged operation');
  const delivery = activity.slice(activity.indexOf('private void deliver(JSONObject value)'), activity.indexOf('private void reply(String id'));
  assert.match(delivery, /!transportPage\(\)/, 'Native delivery uses the scoped foreground, owned-prompt or projection guard');
  const transport = activity.slice(activity.indexOf('private boolean localDocument()'), activity.indexOf('private final class NativeBridge'));
  assert.match(transport, /localDocument\(\)\s*&&\s*\(ScreenShareService\.active\(\)\s*\|\|\s*projectionStarting\)/, 'Projection exception requires the exact bundled document and active or starting service');
  assert.match(activity, /main\.postDelayed\(projectionDeadline,\s*120000\)/, 'Owned projection prompt has a bounded deadline');
  assert.match(activity, /Manifest\.permission\.POST_NOTIFICATIONS/, 'Screen sharing requests an optional visible stop notification');
  assert.match(activity, /code\s*==\s*43\s*&&\s*projectionRequest\s*!=\s*null/, 'Notification result is bound to a still-pending owner screen request');
  assert.match(activity, /notificationAvailable/, 'Native screen descriptor tells the renderer when the stop notification is unavailable');
  const approval = activity.slice(activity.indexOf('private void grantControl'), activity.indexOf('private void requestMedia'));
  assert.match(approval, /!trustedPage\(\)/, 'Native owner approval is unavailable in the background');
  assert.match(approval, /!approvedPeers\.contains\(peerId\)/, 'Native owner approval requires a broker-admitted peer');
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
  const events = activity.slice(activity.indexOf('private void event(long serial'), activity.indexOf('private void closeSocket()'));
  assert.match(events, /pausedEvents\.size\(\)\s*>=\s*64/, 'Incoming native events have a bounded pause queue');
  assert.match(events, /generation\s*!=\s*serial/, 'Native event delivery rejects stale session generations');
  const stopSession = activity.slice(activity.indexOf('private void stopSession()'), activity.indexOf('@Override protected void onPause()'));
  assert.match(stopSession, /generation\+\+/, 'Real background invalidates the current session generation');
  assert.match(stopSession, /pausedEvents\.clear\(\)/, 'Real background discards queued native events');
  assert.match(stopSession, /loadUrl\("about:blank"\)/, 'Real background destroys the media document');
  assert.match(manifest, /android:usesCleartextTraffic="false"/, 'Cleartext network traffic is disabled');
  assert.match(manifest, /android:allowBackup="false"/, 'Invitation/session data is excluded from backup');
  const permissions = [...manifest.matchAll(/<uses-permission\s+android:name="([^"]+)"/g)].map(match => match[1]);
  for (const permission of permissions) assert.ok(['android.permission.INTERNET', 'android.permission.CAMERA', 'android.permission.RECORD_AUDIO', 'android.permission.MODIFY_AUDIO_SETTINGS', 'android.permission.ACCESS_NETWORK_STATE', 'android.permission.FOREGROUND_SERVICE', 'android.permission.FOREGROUND_SERVICE_MEDIA_PROJECTION', 'android.permission.FOREGROUND_SERVICE_MICROPHONE', 'android.permission.FOREGROUND_SERVICE_CAMERA', 'android.permission.POST_NOTIFICATIONS'].includes(permission), 'Unexpected Android privilege: ' + permission);
  for (const permission of ['android.permission.INTERNET', 'android.permission.CAMERA', 'android.permission.RECORD_AUDIO']) assert.ok(permissions.includes(permission), 'Required call permission missing');
  evidence.checks.sourcePolicies = { passed: true, label: 'Static source assertions, not WebView runtime verification', permissions, permissionPausePolicy: 'Exact local document; owned bounded screen consent or media prompt; active approved projection can continue existing transport and gated input; no background invitation, new capture or owner approval; input confirmation, expiry, rate and replay checks also exercised in production JVM policy' };
}
async function main() {
  await fs.mkdir(classesDir, { recursive: true });
  const java = await executable('java'); const javac = await executable('javac');
  const libs = ['Java-WebSocket-1.6.0.jar', 'slf4j-api-2.0.13.jar'].map(name => path.join(root, 'android', 'libs', name));
  const classpath = libs.join(path.delimiter);
  const sources = ['Invitation.java', 'PinnedTls.java', 'PinnedRoomClient.java', 'AttendedControlPolicy.java'].map(name => path.join(packageDir, name));
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
  await sourcePolicies();
  evidence.passed = true;
}
main().catch(error => { evidence.passed = false; evidence.error = error.message; process.exitCode = 1; }).finally(async () => {
  if (host) host.terminate(); if (broker) await broker.stop();
  for (const filename of credentialFiles) await fs.unlink(filename).catch(() => {});
  await fs.mkdir(resultsDir, { recursive: true });
  await fs.writeFile(path.join(resultsDir, 'android-security.json'), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence, null, 2));
});
