'use strict';

const { _electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

async function run() {
  if (process.platform !== 'win32') throw new Error('Native desktop verification supports Windows only');
  const output = path.resolve(__dirname, '..', 'qa', 'native-desktop-evidence.json');
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const evidence = { startedAt: new Date().toISOString(), scope: 'Dedicated local Electron textarea/button only', events: [], passed: false };
  let application;
  let pointerMoved = false;
  let grantActive = false;
  try {
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    application = await _electron.launch({ args: [path.join(__dirname, 'native-test-main.cjs')], env, timeout: 30000 });
    const page = await application.firstWindow();
    await page.locator('#input').waitFor();
    evidence.environment = await application.evaluate(() => globalThis.nativeQA.info());
    assert.equal(evidence.environment.pointerRestorable, true, 'Pointer is outside primary display; restore would be unsafe');
    assert.equal(evidence.environment.nativeAvailable, true, 'Windows helper must be available');
    await application.evaluate(() => globalThis.nativeQA.focus());
    const granted = await application.evaluate(() => globalThis.nativeQA.grant());
    assert.equal(granted.ok, true, granted.reason);
    grantActive = true;
    await page.locator('#input').focus();
    for (const event of [{ type: 'keydown', code: 'KeyA' }, { type: 'keyup', code: 'KeyA' },
      { type: 'keydown', code: 'Digit1' }, { type: 'keyup', code: 'Digit1' }]) {
      const result = await application.evaluate((_, value) => globalThis.nativeQA.apply(value), event);
      assert.equal(result.ok, true, result.reason);
      evidence.events.push({ ...event, accepted: result.ok });
    }
    await page.waitForFunction(() => document.getElementById('input').value === 'a1');
    evidence.text = await page.locator('#input').inputValue();
    evidence.keys = await page.evaluate(() => window.qa.keys);
    assert.deepEqual(evidence.keys.map((key) => key.code), ['KeyA', 'Digit1']);
    assert.ok(evidence.keys.every((key) => key.trusted));
    const button = await page.locator('#target').boundingBox();
    assert.ok(button);
    const point = await application.evaluate((_, value) => globalThis.nativeQA.point(value), { x: button.x + button.width / 2, y: button.y + button.height / 2 });
    for (const event of [{ type: 'move', ...point }, { type: 'down', button: 0, ...point }, { type: 'up', button: 0, ...point }]) {
      const result = await application.evaluate((_, value) => globalThis.nativeQA.apply(value), event);
      assert.equal(result.ok, true, result.reason);
      pointerMoved = true;
      evidence.events.push({ ...event, accepted: result.ok });
    }
    await page.waitForFunction(() => window.qa.clicks.length === 1);
    evidence.clicks = await page.evaluate(() => window.qa.clicks);
    assert.equal(evidence.clicks[0].trusted, true);
    const restored = await application.evaluate(() => globalThis.nativeQA.restore());
    assert.equal(restored.ok, true, restored.reason);
    // releaseAll acknowledges all commands queued before it, including restore.
    await application.evaluate(() => globalThis.nativeQA.revoke());
    grantActive = false;
    pointerMoved = false;
    evidence.restoredPointer = await application.evaluate(() => globalThis.nativeQA.pointer());
    assert.deepEqual(evidence.restoredPointer, evidence.environment.original);
    evidence.afterRevoke = await application.evaluate(() => globalThis.nativeQA.apply({ type: 'keydown', code: 'KeyB' }));
    assert.equal(evidence.afterRevoke.ok, false);
    assert.equal(await page.locator('#input').inputValue(), 'a1');
    evidence.passed = true;
    console.log('Native Windows input verified only in the dedicated QA window; pointer restored, consent revoked.');
  } catch (error) {
    evidence.error = error.stack || error.message;
    throw error;
  } finally {
    if (application) {
      try {
        if (grantActive && pointerMoved) {
          await application.evaluate(() => globalThis.nativeQA.focus());
          evidence.cleanupRestore = await application.evaluate(() => globalThis.nativeQA.restore());
        }
        await application.evaluate(() => globalThis.nativeQA.dispose());
      } catch (error) { evidence.cleanupError = error.message; }
      await application.close().catch(() => {});
    }
    evidence.finishedAt = new Date().toISOString();
    fs.writeFileSync(output, JSON.stringify(evidence, null, 2));
    console.log(`Evidence: ${output}`);
  }
}

run().catch((error) => { console.error(error.message); process.exitCode = 1; });
