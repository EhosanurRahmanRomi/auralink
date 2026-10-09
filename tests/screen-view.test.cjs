'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ready = import('data:text/javascript;base64,' + fs.readFileSync(path.join(__dirname, '../src/renderer/screen-view.js')).toString('base64'));
const close = (value, expected) => assert.ok(Math.abs(value - expected) < 1e-9, `${value} should equal ${expected}`);
async function view(width = 1000, height = 800, imageWidth = 1920, imageHeight = 1080) {
  const { ScreenView } = await ready; const instance = new ScreenView(); instance.resize(width, height, imageWidth, imageHeight); return instance;
}

test('fit excludes letterboxes and inverse mapping clamps releases', async () => {
  const screen = await view();
  assert.deepEqual(screen.point(500, 400), { x: .5, y: .5 });
  assert.equal(screen.point(500, 50), null);
  assert.equal(screen.point(-1, 400), null);
  assert.deepEqual(screen.point(-100, 900, true), { x: 0, y: 1 });
});

test('cursor-anchored zoom preserves the selected remote pixel', async () => {
  const screen = await view(1000, 562.5);
  const before = screen.point(760, 140);
  screen.zoom(2, 760, 140);
  const after = screen.point(760, 140);
  close(after.x, before.x); close(after.y, before.y);
  screen.zoom(3.2, 230, 470); const anchored = screen.point(230, 470);
  screen.zoom(2.4, 230, 470); const restored = screen.point(230, 470);
  close(restored.x, anchored.x); close(restored.y, anchored.y);
});

test('zoom and pan stay bounded and Fit restores the whole screen', async () => {
  const screen = await view();
  screen.zoom(99); assert.equal(screen.scale, 4);
  screen.pan(99999, -99999); close(screen.x, 1500); close(screen.y, -725);
  close(screen.point(0, 800).x, 0); close(screen.point(0, 800).y, 1);
  screen.pan(-99999, 99999); close(screen.x, -1500); close(screen.y, 725);
  screen.zoom(-2); assert.equal(screen.scale, 1); assert.equal(screen.x, 0); assert.equal(screen.y, 0);
  screen.zoom(3); screen.pan(100, 80); screen.reset();
  assert.deepEqual({ scale: screen.scale, x: screen.x, y: screen.y }, { scale: 1, x: 0, y: 0 });
});

test('portrait zoom centres the narrow axis until it fills the viewport', async () => {
  const screen = await view(1000, 700, 1080, 2400);
  screen.zoom(2, 100, 300); screen.pan(200, 50);
  assert.equal(screen.x, 0);
  assert.equal(screen.point(5, 350), null);
  assert.deepEqual(screen.point(500, 350), { x: .5, y: (700 - 100) / 1400 });
  screen.zoom(4); screen.pan(9000, 9000);
  close(screen.x, 130); close(screen.y, 1050);
});

test('resize retains zoom focus while reclamping to the new viewport', async () => {
  const screen = await view(1000, 562.5); screen.zoom(2, 750, 140); const before = screen.point(500, 281.25);
  screen.resize(1600, 900, 1920, 1080);
  const after = screen.point(800, 450); close(after.x, before.x); close(after.y, before.y);
  assert.equal(screen.scale, 2);
  screen.resize(300, 1000, 1920, 1080); assert.equal(screen.y, 0);
  const limit = Math.max(0, (screen.fit.width * 2 - 300) / 2); assert.ok(Math.abs(screen.x) <= limit);
});

test('unready and invalid geometry never produce remote coordinates', async () => {
  const { ScreenView } = await ready; const screen = new ScreenView();
  assert.equal(screen.point(1, 1), null); screen.zoom(4); assert.equal(screen.scale, 1);
  screen.resize(1000, 800, 1920, 1080); const initial = { scale: screen.scale, x: screen.x, y: screen.y };
  screen.zoom(NaN); screen.pan(Infinity, 10); screen.zoom(2, Infinity, 4);
  assert.deepEqual({ scale: screen.scale, x: screen.x, y: screen.y }, initial);
  assert.equal(screen.point(NaN, 4), null); screen.resize(0, 800, 1920, 1080); assert.equal(screen.point(0, 0), null);
});
