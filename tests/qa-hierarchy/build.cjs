'use strict';

// Separate observer APK only. No production sources or retained signing key.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const project = path.resolve(__dirname, '../..');
const sdk = process.env.ANDROID_SDK_ROOT || process.env.ANDROID_HOME || path.join(project, '.tools/android-sdk');
const localJdks = path.join(project, '.tools/jdk');
const javaHome = process.env.JAVA_HOME || (fs.existsSync(localJdks) && fs.readdirSync(localJdks)
  .map(name => path.join(localJdks, name)).find(directory => fs.existsSync(path.join(directory, 'bin', 'javac.exe'))));
assert.ok(javaHome, 'Set JAVA_HOME to a JDK 21 installation');
const extension = process.platform === 'win32' ? '.exe' : '';
const jdk = name => path.join(javaHome, 'bin', name + extension);
const tools = path.join(sdk, 'build-tools/36.0.0');
const androidJar = path.join(sdk, 'platforms/android-36/android.jar');
const output = path.join(project, '.tools/qa-hierarchy');
const classes = path.join(output, 'classes');
const dex = path.join(output, 'dex');
for (const directory of [output, classes, dex]) fs.mkdirSync(directory, { recursive: true });
const unsigned = path.join(output, 'unsigned.apk');
const aligned = path.join(output, 'aligned.apk');
const apk = path.join(output, 'Auralink-QA-hierarchy.apk');
const key = path.join(output, 'ephemeral-signing.jks');
const password = crypto.randomBytes(32).toString('base64url');
const env = { ...process.env, AURALINK_QA_SIGNING_PASSWORD: password };
function run(file, args) {
  const result = spawnSync(file, args, { env, encoding: 'utf8', windowsHide: true, timeout: 120000, maxBuffer: 4 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error(`${path.basename(file)} failed: ${result.error?.message || result.stderr || result.stdout}`);
  return result.stdout;
}
for (const file of [androidJar, jdk('java'), jdk('javac'), jdk('jar'), jdk('keytool'), path.join(tools, 'aapt2' + extension),
  path.join(tools, 'zipalign' + extension), path.join(tools, 'lib/d8.jar'), path.join(tools, 'lib/apksigner.jar')]) assert.ok(fs.existsSync(file), `Missing QA build dependency: ${file}`);
// Replace only explicitly named generated files; never reuse a distribution key.
for (const file of [unsigned, aligned, apk, key]) fs.rmSync(file, { force: true });
try {
  run(path.join(tools, 'aapt2' + extension), ['link', '--manifest', path.join(__dirname, 'AndroidManifest.xml'), '-I', androidJar, '-o', unsigned]);
  run(jdk('javac'), ['--release', '8', '-encoding', 'UTF-8', '-classpath', androidJar, '-d', classes,
    path.join(__dirname, 'HierarchyInstrumentation.java'), path.join(__dirname, 'AudioToneInstrumentation.java')]);
  const classJar = path.join(output, 'classes.jar');
  run(jdk('jar'), ['--create', '--no-manifest', '--file', classJar, '-C', classes, '.']);
  run(jdk('java'), ['-cp', path.join(tools, 'lib/d8.jar'), 'com.android.tools.r8.D8', '--release', '--min-api', '29', '--lib', androidJar, '--output', dex, classJar]);
  run(jdk('jar'), ['--update', '--no-manifest', '--file', unsigned, '-C', dex, 'classes.dex']);
  run(path.join(tools, 'zipalign' + extension), ['-f', '4', unsigned, aligned]);
  run(jdk('keytool'), ['-genkeypair', '-keystore', key, '-alias', 'qa-observer', '-keyalg', 'RSA', '-keysize', '2048', '-validity', '2',
    '-storepass:env', 'AURALINK_QA_SIGNING_PASSWORD', '-keypass:env', 'AURALINK_QA_SIGNING_PASSWORD', '-dname', 'CN=Isolated Auralink QA observer']);
  run(jdk('java'), ['-jar', path.join(tools, 'lib/apksigner.jar'), 'sign', '--ks', key, '--ks-key-alias', 'qa-observer',
    '--ks-pass', 'env:AURALINK_QA_SIGNING_PASSWORD', '--key-pass', 'env:AURALINK_QA_SIGNING_PASSWORD', '--out', apk, aligned]);
  run(jdk('java'), ['-jar', path.join(tools, 'lib/apksigner.jar'), 'verify', '--verbose', apk]);
  console.log(JSON.stringify({ apk: path.relative(project, apk).replaceAll('\\', '/'), package: 'local.auralink.qa',
    instrumentation: 'local.auralink.qa/.HierarchyInstrumentation', productionApkModified: false,
    audioInstrumentation: 'local.auralink.qa/.AudioToneInstrumentation',
    sha256: crypto.createHash('sha256').update(fs.readFileSync(apk)).digest('hex') }));
} finally {
  fs.rmSync(key, { force: true });
  delete env.AURALINK_QA_SIGNING_PASSWORD;
}
