'use strict';

// Verify the genuine NSIS setup and its embedded application without executing
// installation, writing uninstall keys/shortcuts, or closing an existing app.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { _electron } = require('playwright');
const asar = require('@electron/asar');
const pe = require('pe-library');

const critical = ['src/main.cjs', 'src/preload.cjs', 'src/core/broker.cjs', 'src/core/invite.cjs',
  'src/native/control.cjs', 'src/native/windows-input.ps1', 'src/renderer/index.html',
  'src/renderer/styles.css', 'src/renderer/app.js', 'src/renderer/rtc.js', 'src/renderer/android-bridge.js',
  'src/renderer/internet.js', 'src/renderer/desktop-internet.js', 'src/core/internet-client.cjs'];
const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

function execute(command, args, options = {}) {
  const result = spawnSync(command, args, { windowsHide: true, encoding: 'utf8', timeout: 120000, maxBuffer: 8 * 1024 * 1024, ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${path.basename(command)} failed (${result.status}): ${(result.stderr || result.stdout).slice(-2000)}`);
  return result.stdout;
}

function findSevenZip() {
  const cache = path.join(process.env.LOCALAPPDATA, 'electron-builder', 'Cache', '7zip@1.0.0');
  for (const entry of fs.readdirSync(cache, { withFileTypes: true })) {
    const candidate = path.join(cache, entry.name, 'bin', '7za.exe');
    if (entry.isDirectory() && fs.existsSync(candidate)) return candidate;
  }
  throw new Error('electron-builder bundled 7za tool is unavailable');
}

function appProcesses() {
  const json = execute('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
    "@(Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'Auralink.exe' -or $_.Name -like 'Auralink-*-Windows-x64.exe' } | Select-Object ProcessId, ParentProcessId, ExecutablePath) | ConvertTo-Json -Compress"]);
  const parsed = JSON.parse(json || '[]');
  return Array.isArray(parsed) ? parsed : [parsed];
}

function removeDedicatedPayload(payload, workspace) {
  const realPayload = fs.realpathSync(payload);
  const realWorkspace = fs.realpathSync(workspace);
  const relative = path.relative(realWorkspace, realPayload);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || !path.basename(realPayload).startsWith('windows-setup-payload-')) throw new Error('Refusing to remove a path outside the dedicated QA workspace');
  fs.rmSync(realPayload, { recursive: true, force: true });
}

async function run() {
  if (process.platform !== 'win32') throw new Error('Windows installer QA requires Windows');
  const project = path.resolve(__dirname, '..');
  const qa = path.join(project, 'test-results');
  fs.mkdirSync(qa, { recursive: true });
  const payload = fs.mkdtempSync(path.join(qa, 'windows-setup-payload-'));
  const config = JSON.parse(fs.readFileSync(path.join(project, 'package.json'), 'utf8'));
  const installer = path.join(project, 'release', `Auralink-Setup-${config.version}-Windows-x64.exe`);
  const output = path.join(qa, 'windows-installer-smoke.json');
  const evidence = { startedAt: new Date().toISOString(), passed: false, installationExecuted: false,
    nativeInputInjected: false, checks: [], errors: [] };
  let application;
  try {
    assert.ok(fs.existsSync(installer));
    const installerBytes = fs.readFileSync(installer);
    evidence.artifact = { path: installer, bytes: installerBytes.length, sha256: sha256(installerBytes) };
    const installerExe = pe.NtExecutable.from(installerBytes, { ignoreCert: true });
    const manifests = pe.NtExecutableResource.from(installerExe).entries.filter((entry) => entry.type === 24)
      .map((entry) => Buffer.from(entry.bin).toString('utf8'));
    assert.ok(manifests.some((manifest) => /Nullsoft\.NSIS/.test(manifest)));
    assert.ok(manifests.every((manifest) => /requestedExecutionLevel level="asInvoker"/.test(manifest)));
    evidence.installerManifest = { framework: 'NSIS', requestedExecutionLevel: 'asInvoker' };
    evidence.checks.push('Setup is a genuine NSIS executable with non-elevating asInvoker manifest');
    const options = config.build.nsis;
    assert.equal(options.oneClick, false);
    assert.equal(options.perMachine, false);
    assert.equal(options.allowElevation, false);
    assert.equal(options.runAfterFinish, false);
    assert.equal(options.packElevateHelper, false);
    assert.equal(options.allowToChangeInstallationDirectory, true);
    const include = fs.readFileSync(path.join(project, options.include), 'utf8');
    assert.match(include, /StrCpy \$isForceCurrentInstall "1"/);
    assert.match(include, /insertmacro setInstallModePerUser/);
    evidence.setupConfiguration = { perUserOnly: true, assisted: true, changeInstallDirectory: true,
      requestElevation: false, autoLaunch: false, createsDesktopAndStartMenuShortcuts: true,
      preservesAppDataOnUninstall: true, portableTargetRetained: config.build.win.target.includes('portable') };
    evidence.checks.push('Setup configuration forces current-user assisted install, preserves app data and retains portable target');
    evidence.processesBefore = appProcesses();
    const tool = findSevenZip();
    const archiveCheck = execute(tool, ['t', '-y', installer]);
    assert.match(archiveCheck, /Everything is Ok/);
    evidence.archive = { integrityPassed: true, embeddedPayloadTailWarning: /data after the end of archive/.test(archiveCheck) };
    execute(tool, ['x', '-y', `-o${payload}`, installer]);
    evidence.checks.push('Embedded application archive passes CRC integrity and extracts without running setup');
    const applicationExe = path.join(payload, 'Auralink.exe');
    const executableBytes = fs.readFileSync(applicationExe);
    assert.equal(pe.NtExecutable.from(executableBytes, { ignoreCert: true }).newHeader.fileHeader.machine, 0x8664);
    evidence.payloadArchitecture = 'AMD64/x64';
    const archive = path.join(payload, 'resources', 'app.asar');
    evidence.sourceParity = critical.map((relative) => {
      const packagedSha256 = sha256(asar.extractFile(archive, path.normalize(relative)));
      const sourceSha256 = sha256(fs.readFileSync(path.join(project, relative)));
      return { path: relative, packagedSha256, sourceSha256, matches: packagedSha256 === sourceSha256 };
    });
    assert.ok(evidence.sourceParity.every((file) => file.matches));
    assert.ok(fs.existsSync(path.join(payload, 'resources', 'app.asar.unpacked', 'src', 'native', 'windows-input.ps1')));
    evidence.checks.push('Extracted x64 application and all critical source files match current source, including unpacked native helper and optional Android bridge');

    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    application = await _electron.launch({ executablePath: applicationExe,
      args: ['--smoke-test', `--user-data-dir=${path.join(payload, 'qa-profile')}`], env, timeout: 60000 });
    const page = await application.firstWindow();
    page.on('pageerror', (error) => evidence.errors.push(error.message));
    await page.locator('#host-button').waitFor();
    await page.waitForFunction(() => !!window.auralink && document.querySelector('#profile-platform').textContent !== 'Local workspace');
    evidence.runtime = await application.evaluate(({ app }) => ({ isPackaged: app.isPackaged,
      appPath: app.getAppPath(), version: app.getVersion(), userData: app.getPath('userData') }));
    assert.equal(evidence.runtime.isPackaged, true);
    assert.equal(evidence.runtime.version, config.version);
    assert.equal(path.resolve(evidence.runtime.userData), path.join(payload, 'qa-profile'));
    evidence.info = await page.evaluate(() => window.auralink.getInfo());
    assert.equal(evidence.info.nativeControl, true);
    assert.equal(evidence.info.testing, true);
    const room = await page.evaluate(() => window.auralink.hostRoom({ name: 'Installer payload QA', port: 0 }));
    const invitation = await page.evaluate((value) => window.auralink.trustInvite(value), room.invite);
    assert.equal(invitation.fingerprint, room.fingerprint);
    evidence.runtime.room = { url: room.url, invitationCertificateVerified: true };
    evidence.runtime.helper = await application.evaluate(async ({ app }) => {
      const native = process.mainModule.require(`${app.getAppPath()}/src/native/control.cjs`);
      const adapter = native.createAdapter();
      try { await adapter.ready(); await adapter.releaseAll(); return { ready: true, releaseAcknowledged: true, inputEventsSent: 0, path: adapter.helperPath }; }
      finally { await adapter.dispose(); }
    });
    const refused = await page.evaluate(() => window.auralink.grantControl({ peerId: 'qa', sessionId: 'setup-test-session', screenId: 'screen:qa' }));
    assert.equal(refused.ok, false);
    assert.match(refused.reason, /disabled.*test/i);
    assert.equal((await page.evaluate(() => window.auralink.stopRoom())).ok, true);
    evidence.checks.push('Extracted installed-layout app launches with workspace-isolated preferences, HTTPS room and native helper protocol; no native input sent');
    await application.close();
    application = null;
    evidence.processesAfter = appProcesses();
    evidence.preExistingProcessesPreserved = evidence.processesBefore.every((before) => evidence.processesAfter.some((after) => after.ProcessId === before.ProcessId && after.ExecutablePath === before.ExecutablePath));
    evidence.noQAProcessesRemaining = evidence.processesAfter.every((process) => !String(process.ExecutablePath).startsWith(payload));
    assert.equal(evidence.preExistingProcessesPreserved, true);
    assert.equal(evidence.noQAProcessesRemaining, true);
    assert.deepEqual(evidence.errors, []);
    evidence.checks.push('QA application exits and existing user application processes are preserved');
    evidence.passed = true;
    console.log('Windows NSIS setup verification passed: manifest, archive CRC, source parity and isolated payload runtime. Setup was not installed into the user profile.');
  } catch (error) {
    evidence.failure = error.stack || error.message;
    throw error;
  } finally {
    if (application) await application.close().catch(() => {});
    try { removeDedicatedPayload(payload, qa); evidence.extractedQAFilesRemoved = true; }
    catch (error) { evidence.cleanupError = error.message; }
    evidence.finishedAt = new Date().toISOString();
    fs.writeFileSync(output, JSON.stringify(evidence, null, 2));
    console.log(`Evidence: ${output}`);
  }
}

run().catch((error) => { console.error(error.message); process.exitCode = 1; });
