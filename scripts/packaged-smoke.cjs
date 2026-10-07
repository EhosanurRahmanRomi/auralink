'use strict';

const { _electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

async function run() {
  if (process.platform !== 'win32') throw new Error('Packaged desktop verification supports Windows only');
  const project = path.resolve(__dirname, '..');
  const executablePath = path.join(project, 'release', 'win-unpacked', 'Auralink.exe');
  const output = path.join(project, 'test-results', 'packaged-smoke.json');
  assert.ok(fs.existsSync(executablePath), 'Build the Windows release before running packaged verification');
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const evidence = { startedAt: new Date().toISOString(), passed: false, inputInjected: false, checks: [], errors: [] };
  let application;
  try {
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    application = await _electron.launch({ executablePath, args: ['--smoke-test'], env, timeout: 60000 });
    const page = await application.firstWindow();
    page.on('pageerror', (error) => evidence.errors.push(error.message));
    await page.locator('#host-button').waitFor();
    await page.waitForFunction(() => !!window.auralink && document.querySelector('#profile-platform').textContent !== 'Local workspace');
    evidence.app = await application.evaluate(({ app }) => ({ appPath: app.getAppPath(), isPackaged: app.isPackaged, version: app.getVersion() }));
    assert.equal(evidence.app.isPackaged, true);
    assert.match(evidence.app.appPath, /[\\/]app\.asar$/);
    evidence.checks.push('Real packaged executable loads its application from app.asar');

    const sourcePaths = ['src/main.cjs', 'src/preload.cjs', 'src/core/broker.cjs', 'src/core/invite.cjs',
      'src/native/control.cjs', 'src/native/windows-input.ps1', 'src/renderer/index.html',
      'src/renderer/styles.css', 'src/renderer/app.js', 'src/renderer/rtc.js'];
    evidence.sourceParity = await application.evaluate(({ app, globalShortcut }, value) => {
      const fromApp = process.mainModule.require.bind(process.mainModule);
      const fileSystem = fromApp('node:fs');
      const filePath = fromApp('node:path');
      const crypto = fromApp('node:crypto');
      const hash = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
      const files = value.paths.map((relative) => {
        const sourceHash = hash(fileSystem.readFileSync(filePath.join(value.project, relative)));
        const packagedHash = hash(fileSystem.readFileSync(filePath.join(app.getAppPath(), relative)));
        return { path: relative, sourceSha256: sourceHash, packagedSha256: packagedHash, matches: sourceHash === packagedHash };
      });
      return { emergencyShortcutRegistered: globalShortcut.isRegistered('Control+Alt+Shift+Q'),
        files, allMatch: files.every((file) => file.matches) };
    }, { project, paths: sourcePaths });
    assert.equal(evidence.sourceParity.emergencyShortcutRegistered, true, 'Emergency stop must be registered by the packaged app');
    assert.equal(evidence.sourceParity.allMatch, true, 'The packaged executable must contain the current validated source files');
    evidence.checks.push('Packaged emergency-stop shortcut is registered');
    evidence.checks.push('All ten critical packaged source files exactly match current source SHA256');

    evidence.info = await page.evaluate(() => window.auralink.getInfo());
    assert.equal(evidence.info.nativeControl, true, 'The unpacked Windows native helper must be discoverable');
    assert.equal(evidence.info.testing, true, 'Automated tests must disable production control approval');
    evidence.checks.push('Packaged preload and trusted main-process IPC return device/native capabilities');

    const room = await page.evaluate(() => window.auralink.hostRoom({ name: 'Packaged verification room', port: 0 }));
    assert.match(room.url, /^https:\/\/127\.0\.0\.1:\d+$/);
    assert.match(room.fingerprint, /^[a-f0-9]{64}$/);
    assert.ok(room.port > 0);
    const invitation = await page.evaluate((value) => window.auralink.trustInvite(value), room.invite);
    assert.equal(invitation.fingerprint, room.fingerprint);
    evidence.room = { name: room.name, url: room.url, port: room.port, fingerprint: room.fingerprint,
      invitationCertificateVerified: true, advertisedAddresses: room.invites.length };
    evidence.checks.push('Packaged HTTPS room starts and invitation fingerprint matches its live certificate');

    // Load the actual packaged native module through the packaged main module.
    // Only readiness and release of its initially empty pressed state are used:
    // no grant, mouse movement, key, click or scroll command is sent.
    evidence.helper = await application.evaluate(async ({ app }) => {
      const fromApp = process.mainModule?.require.bind(process.mainModule);
      if (!fromApp) throw new Error('Packaged main-module loader is unavailable');
      const native = fromApp(`${app.getAppPath()}/src/native/control.cjs`);
      const adapter = native.createAdapter();
      try {
        if (!adapter.available) throw new Error('Packaged helper is unavailable');
        await adapter.ready();
        await adapter.releaseAll();
        return { available: adapter.available, helperPath: adapter.helperPath, ready: true,
          emptyStateReleaseAcknowledged: true, inputEventsSent: 0 };
      } finally { await adapter.dispose(); }
    });
    assert.match(evidence.helper.helperPath, /[\\/]app\.asar\.unpacked[\\/]src[\\/]native[\\/]windows-input\.ps1$/);
    assert.equal(evidence.helper.inputEventsSent, 0);
    evidence.checks.push('Native module inside app.asar launches its unpacked helper and completes readiness/release/shutdown without input injection');

    const rejected = await page.evaluate(() => window.auralink.grantControl({ peerId: 'qa', sessionId: 'isolated-qa-session', screenId: 'screen:qa' }));
    assert.equal(rejected.ok, false);
    assert.match(rejected.reason, /disabled.*test/i);
    evidence.checks.push('Packaged smoke mode refuses remote-control approval');

    assert.equal((await page.evaluate(() => window.auralink.stopRoom())).ok, true);
    const teardown = await application.evaluate(async (_, url) => {
      const https = process.mainModule.require('node:https');
      return new Promise((resolve) => {
        const request = https.get(`${url}/health`, { rejectUnauthorized: false, agent: false, timeout: 3000 }, (response) => {
          response.resume();
          resolve({ closed: false, status: response.statusCode });
        });
        request.on('timeout', () => request.destroy(new Error('Timed out')));
        request.on('error', (error) => resolve({ closed: error.code === 'ECONNREFUSED', code: error.code || 'unknown' }));
      });
    }, room.url);
    evidence.teardown = teardown;
    assert.equal(teardown.closed, true, 'HTTPS room must refuse new connections after teardown');
    evidence.checks.push('Packaged room teardown closes its HTTPS listener');
    assert.deepEqual(evidence.errors, []);
    evidence.passed = true;
    console.log('Packaged Windows smoke passed: ASAR loading, native helper, HTTPS certificate pin and teardown; no native input injected.');
  } catch (error) {
    evidence.failure = error.stack || error.message;
    throw error;
  } finally {
    if (application) {
      try {
        const page = await application.firstWindow();
        evidence.preferenceCleanup = await page.evaluate(() => {
          const saved = localStorage.getItem('auralink.preferences');
          if (!saved) return { changed: false, reason: 'No saved test preferences' };
          let preferences;
          try { preferences = JSON.parse(saved); } catch (_) { return { changed: false, reason: 'Existing value preserved' }; }
          if (!preferences || typeof preferences !== 'object' || Array.isArray(preferences) || preferences.name !== 'Desktop QA') return { changed: false, reason: 'No test display name to remove' };
          const otherBefore = JSON.stringify(Object.entries(preferences).filter(([key]) => key !== 'name'));
          preferences.name = 'My device';
          localStorage.setItem('auralink.preferences', JSON.stringify(preferences));
          const updated = JSON.parse(localStorage.getItem('auralink.preferences'));
          return { changed: true, name: updated.name,
            otherSettingsPreserved: otherBefore === JSON.stringify(Object.entries(updated).filter(([key]) => key !== 'name')) };
        });
        if (evidence.preferenceCleanup.changed) assert.equal(evidence.preferenceCleanup.otherSettingsPreserved, true);
        await page.evaluate(() => window.auralink.stopRoom());
      } catch (error) { evidence.cleanupError = error.message; }
      await application.close().catch(() => {});
    }
    evidence.finishedAt = new Date().toISOString();
    fs.writeFileSync(output, JSON.stringify(evidence, null, 2));
    console.log(`Evidence: ${output}`);
  }
}

run().catch((error) => { console.error(error.message); process.exitCode = 1; });
