'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {visibleInWebView,immersiveTutorialButton,createImmersiveTutorialHandler} = require('./android-hierarchy.cjs');

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

function tutorial() {
  const systemUI = 'com.android.systemui';
  return [
    {class:'android.widget.FrameLayout',package:systemUI,'visible-to-user':'true',bounds:'[0,0][720,1280]'},
    {class:'android.widget.TextView',package:systemUI,'resource-id':`${systemUI}:id/immersive_cling_title`,
      text:'Viewing full screen',enabled:'true','visible-to-user':'true',bounds:'[36,250][684,299]'},
    {class:'android.widget.Button',package:systemUI,'resource-id':`${systemUI}:id/ok`,text:'Got it',
      enabled:'true',clickable:'true','visible-to-user':'true',bounds:'[580,385][684,457]'}
  ];
}

test('the known SystemUI immersive tutorial uses its actual observed enabled button bounds exactly once', async () => {
  const nodes = tutorial(), taps = [], events = [];
  assert.equal(immersiveTutorialButton(nodes),nodes[2]);
  const dismiss = createImmersiveTutorialHandler({tap:async node=>taps.push(node),onDismissed:()=>events.push('dismissed')});
  assert.equal(await dismiss(nodes),true);
  assert.equal(await dismiss([view('[0,136][720,1245]')]),false);
  await assert.rejects(dismiss(nodes),/single observed dismissal/);
  assert.deepEqual(taps,[nodes[2]]);
  assert.deepEqual(events,['dismissed']);
});

test('unrecognized, foreign, hidden, disabled or unbounded dialogs never qualify for tutorial dismissal', async () => {
  const invalid = [
    [],tutorial().slice(0,1),tutorial().filter((_,index)=>index!==1),tutorial().filter((_,index)=>index!==0),
    tutorial().map(node=>({...node,package:packageName})),
    tutorial().map((node,index)=>index===1?{...node,text:'Allow screen capture?'}:node),
    tutorial().map((node,index)=>index===1?{...node,'resource-id':'com.android.systemui:id/alertTitle'}:node),
    tutorial().map((node,index)=>index===1?{...node,'visible-to-user':'false'}:node),
    tutorial().map((node,index)=>index===2?{...node,enabled:'false'}:node),
    tutorial().map((node,index)=>index===2?{...node,clickable:'false'}:node),
    tutorial().map((node,index)=>index===2?{...node,'visible-to-user':'false'}:node),
    tutorial().map((node,index)=>index===2?{...node,text:'Allow'}:node),
    tutorial().map((node,index)=>index===2?{...node,package:'com.android.permissioncontroller'}:node),
    tutorial().map((node,index)=>index===2?{...node,'resource-id':'com.android.systemui:id/permission_allow_button'}:node),
    tutorial().map((node,index)=>index===2?{...node,bounds:'[580,385][580,457]'}:node),
    tutorial().map((node,index)=>index===2?{...node,bounds:'[580,385][721,457]'}:node),
    tutorial().map((node,index)=>index===2?{...node,bounds:'[-1,385][684,457]'}:node),
    [...tutorial(),tutorial()[2]]
  ];
  let taps = 0, events = 0;
  const dismiss = createImmersiveTutorialHandler({tap:async()=>taps++,onDismissed:()=>events++});
  for (const nodes of invalid) {
    assert.equal(immersiveTutorialButton(nodes),null);
    assert.equal(await dismiss(nodes),false);
  }
  assert.equal(taps,0);assert.equal(events,0);
  assert.equal(await dismiss(tutorial()),true,'Ignoring unrelated dialogs must not consume the single valid tutorial dismissal');
  assert.equal(taps,1);assert.equal(events,1);
});

test('a failed tutorial tap is reported and cannot cause a duplicate dismissal or success event', async () => {
  let taps = 0, events = 0;
  const dismiss = createImmersiveTutorialHandler({tap:async()=>{taps++;throw new Error('Observed tap failed');},onDismissed:()=>events++});
  await assert.rejects(dismiss(tutorial()),/Observed tap failed/);
  await assert.rejects(dismiss(tutorial()),/single observed dismissal/);
  assert.equal(taps,1);assert.equal(events,0);
});
