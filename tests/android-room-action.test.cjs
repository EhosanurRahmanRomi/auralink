'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {findRoomAction, fits, viewport, gesturePath} = require('./android-room-action.cjs');

const packageName = 'local.auralink.mobile';
const view = {class:'android.webkit.WebView',package:packageName,'visible-to-user':'true',bounds:'[0,136][720,1245]'};
const nav = {class:'android.widget.Button',package:packageName,'visible-to-user':'true',text:'Rooms',bounds:'[75,1160][181,1232]'};
const button = bounds => ({'resource-id':'host-button',class:'android.widget.Button',package:packageName,text:'',
  'content-desc':'Create an Internet room after pairing this device',enabled:'true','visible-to-user':'true',bounds});
const target = node => node['resource-id'] === 'host-button';
function fixture(read) {
  let clock = 0; const swipes = [];
  return {swipes, options:{read:() => Promise.resolve(read(swipes)),swipe:(...coords) => {swipes.push(coords);},
    wait:async ms => {clock += ms;},now:() => clock,timeout:12000}};
}
test('fully visible stable resource ID is found even when accessible text is the HTML title', async () => {
  const state = fixture(() => [view,nav,button('[66,843][655,911]')]);
  assert.equal((await findRoomAction(target,state.options)).bounds,'[66,843][655,911]');
  assert.deepEqual(state.swipes,[],'A visible action must not be scrolled past');
});
test('an above-viewport target scrolls toward earlier content instead of further down', async () => {
  const state = fixture(swipes => [view,nav,button(swipes.length ? '[66,300][655,368]' : '[66,-40][655,100]')]);
  await findRoomAction(target,state.options);
  assert.equal(state.swipes.length,1);assert.ok(state.swipes[0][3]>state.swipes[0][1]);
});
test('off-tree search returns toward the top before scanning overlapping later content', async () => {
  const state = fixture(swipes => {
    const movedLater = swipes.some(coords => coords[3]<coords[1]);
    return [view,nav,...(movedLater ? [button('[66,500][655,568]')] : [{class:'android.view.View',text:'bottom features',bounds:'[60,300][660,800]'}])];
  });
  await findRoomAction(target,state.options);
  assert.ok(state.swipes[0][3]>state.swipes[0][1]);
  assert.ok(state.swipes.some(coords => coords[3]<coords[1]));
});
test('a node clipped by navigation is scrolled into the viewport before selection', async () => {
  const state = fixture(swipes => [view,nav,button(swipes.length ? '[66,800][655,868]' : '[66,1120][655,1190]')]);
  assert.equal(fits(button('[66,1120][655,1190]'),viewport([view,nav])),false);
  const found = await findRoomAction(target,state.options);
  assert.equal(found.bounds,'[66,800][655,868]');assert.ok(state.swipes[0][3]<state.swipes[0][1]);
});
test('an absent or invisible action fails rather than tapping a different node', async () => {
  const state = fixture(() => [view,nav,{'resource-id':'host-button','visible-to-user':'false',bounds:'[0,0][0,0]'}]);
  await assert.rejects(findRoomAction(target,state.options),/absent after searching/);
  assert.ok(state.swipes.some(coords => coords[3]>coords[1]));assert.ok(state.swipes.some(coords => coords[3]<coords[1]));
});

test('SystemUI-only observer omissions cannot trigger a blind gesture or consume absent-action scans', async () => {
  const systemUI = {class:'android.widget.FrameLayout',package:'com.android.systemui','visible-to-user':'true',bounds:'[0,0][720,42]'};
  let reads = 0, clock = 0; const swipes = [];
  const snapshots = [[systemUI],[systemUI],[view,nav,button('[66,843][655,911]')],[systemUI],[view,nav,button('[66,843][655,911]')],[view,nav,button('[66,843][655,911]')]];
  const found = await findRoomAction(target,{read:async()=>snapshots[reads++],swipe:(...coords)=>swipes.push(coords),wait:async ms=>{clock+=ms;},now:()=>clock,timeout:5000});
  assert.equal(found.bounds,'[66,843][655,911]');assert.equal(reads,6);assert.deepEqual(swipes,[]);
});

test('permanently omitted, hidden, foreign or malformed app viewports fail within the existing deadline without gestures', async () => {
  for (const nodes of [[],[{...view,package:'com.android.systemui'}],[{...view,'visible-to-user':'false'}],
    [{...view,bounds:'[0,136][720,136]'}],[{...view,bounds:'[-1,136][720,1245]'}],[{...view,bounds:'malformed'}]]) {
    const state = fixture(()=>nodes);assert.equal(viewport(nodes),null);
    await assert.rejects(findRoomAction(target,state.options),/Production WebView.*observed viewport/);
    assert.deepEqual(state.swipes,[]);
  }
});

test('gesture coordinates come from the observed viewport and avoid the captured fullscreen-button corridor', () => {
  const fullscreen = {...button('[604,359][672,428]'),'resource-id':'fullscreen-button',clickable:'true'};
  const nodes = [view,nav,fullscreen]; const area = viewport(nodes), path = gesturePath(nodes,area,'earlier');
  assert.ok(path);assert.ok(path[3]>path[1]);
  assert.ok(path[0]>area[0] && path[0]<area[2] && path[1]>=area[1] && path[3]<=area[3]);
  assert.ok(path[0]<600 || path[0]>676,'The path must not cross the observed button');
  const nested = {...view,bounds:'[40,180][680,1000]'};const narrowArea=viewport([nested,view]);
  const narrowPath=gesturePath([nested,view],narrowArea,'later');
  assert.ok(narrowPath[0]>40 && narrowPath[0]<680 && narrowPath[3]>=180 && narrowPath[1]<=1000);
});

test('an interactive or video-covered viewport never falls back to fabricated gesture coordinates', async () => {
  for (const covering of [{...button('[0,136][720,1245]'),clickable:'true'},
    {package:packageName,class:'android.view.View','resource-id':'stage-video','visible-to-user':'true',bounds:'[0,136][720,1245]'}]) {
    const nodes=[view,covering];assert.equal(gesturePath(nodes,viewport(nodes),'earlier'),null);
    const state=fixture(()=>nodes);
    await assert.rejects(findRoomAction(node=>node['resource-id']==='diagnostics-close',state.options),/before the deadline/);
    assert.deepEqual(state.swipes,[]);
  }
});
