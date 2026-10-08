'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {findRoomAction, fits, viewport} = require('./android-room-action.cjs');

const view = {class:'android.webkit.WebView',bounds:'[0,136][720,1245]'};
const nav = {class:'android.widget.Button',text:'Rooms',bounds:'[75,1160][181,1232]'};
const button = bounds => ({'resource-id':'host-button',class:'android.widget.Button',text:'',
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
