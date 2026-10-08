'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {visibleInWebView} = require('./android-hierarchy.cjs');

const packageName = 'local.auralink.mobile';
const view = bounds => ({class:'android.webkit.WebView',package:packageName,'visible-to-user':'true',bounds});
const action = bounds => ({class:'android.widget.Button',package:packageName,'resource-id':'presentation-fullscreen-exit',
  'visible-to-user':'true',bounds});

test('fullscreen exit below the ordinary room viewport remains visible in the expanded native WebView', () => {
  const exit = action('[241,1185][480,1256]');
  assert.equal(visibleInWebView(exit,[view('[0,136][720,1245]'),exit]),false,'The action is clipped before fullscreen');
  assert.equal(visibleInWebView(exit,[view('[0,0][720,1280]'),exit]),true,'Current fullscreen bounds include the second toolbar row');
});

test('visibility follows the current native viewport including restored bars and keyboard resize', () => {
  const exit = action('[241,850][480,920]');
  assert.equal(visibleInWebView(exit,[view('[0,136][720,1245]')]),true);
  assert.equal(visibleInWebView(exit,[view('[0,136][720,880]')]),false);
  assert.equal(visibleInWebView(action('[20,10][80,80]'),[view('[0,136][720,1245]')]),false);
});

test('fullscreen controls require complete horizontal and vertical clipping containment', () => {
  const nodes = [view('[0,0][720,1280]')];
  for (const rect of ['[-1,1185][480,1256]','[241,-1][480,70]','[241,1185][721,1256]','[241,1185][480,1281]']) {
    assert.equal(visibleInWebView(action(rect),nodes),false,rect);
  }
  assert.equal(visibleInWebView(action('[0,0][720,1280]'),nodes),true);
});

test('hidden, malformed, empty or foreign-window nodes cannot prove fullscreen visibility', () => {
  const exit = action('[241,1185][480,1256]');
  const nodes = [view('[0,0][720,1280]')];
  assert.equal(visibleInWebView({...exit,'visible-to-user':'false'},nodes),false);
  assert.equal(visibleInWebView(exit,[{...nodes[0],'visible-to-user':'false'}]),false);
  assert.equal(visibleInWebView(exit,[{...nodes[0],package:'com.android.systemui'}]),false);
  assert.equal(visibleInWebView({...exit,package:''},nodes),false);
  assert.equal(visibleInWebView(exit,[]),false);
  for (const rect of ['','[241,1185][241,1256]','[241,1256][480,1256]','[241,1256][480,1185]','[invalid]','[0,0][999999999999999999,1280]']) {
    assert.equal(visibleInWebView(action(rect),nodes),false,rect);
    assert.equal(visibleInWebView(exit,[view(rect)]),false,rect);
  }
});
