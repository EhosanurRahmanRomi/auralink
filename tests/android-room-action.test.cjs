'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {findRoomAction, fits, viewport, gesturePath, gestureBlockers, diagnosticValue} = require('./android-room-action.cjs');

const packageName = 'local.auralink.mobile';
const view = {class:'android.webkit.WebView',package:packageName,'visible-to-user':'true',bounds:'[0,136][720,1245]'};
const nav = {class:'android.widget.Button',package:packageName,'visible-to-user':'true',text:'Rooms',bounds:'[75,1160][181,1232]'};
const navBand = {class:'android.view.View',package:packageName,'visible-to-user':'true',text:'Main navigation',bounds:'[0,1146][720,1245]'};
const button = bounds => ({'resource-id':'host-button',class:'android.widget.Button',package:packageName,text:'',
  'content-desc':'Create an Internet room after pairing this device',enabled:'true','visible-to-user':'true',bounds});
const target = node => node['resource-id'] === 'host-button';
function fixture(read) {
  let clock = 0; const swipes = [];
  return {swipes, options:{read:() => Promise.resolve(read(swipes)),swipe:(...coords) => {swipes.push(coords);},
    wait:async ms => {clock += ms;},now:() => clock,timeout:12000}};
}
test('fully visible stable resource ID is found even when accessible text is the HTML title', async () => {
  const state = fixture(() => [view,navBand,nav,button('[66,843][655,911]')]);
  assert.equal((await findRoomAction(target,state.options)).bounds,'[66,843][655,911]');
  assert.deepEqual(state.swipes,[],'A visible action must not be scrolled past');
});
test('an above-viewport target scrolls toward earlier content instead of further down', async () => {
  const state = fixture(swipes => [view,navBand,nav,button(swipes.length ? '[66,300][655,368]' : '[66,-40][655,100]')]);
  await findRoomAction(target,state.options);
  assert.equal(state.swipes.length,1);assert.ok(state.swipes[0][3]>state.swipes[0][1]);
});
test('off-tree search returns toward the top before scanning overlapping later content', async () => {
  const state = fixture(swipes => {
    const movedLater = swipes.some(coords => coords[3]<coords[1]);
    return [view,navBand,nav,...(movedLater ? [button('[66,500][655,568]')] : [{class:'android.view.View',text:'bottom features',bounds:'[60,300][660,800]'}])];
  });
  await findRoomAction(target,state.options);
  assert.ok(state.swipes[0][3]>state.swipes[0][1]);
  assert.ok(state.swipes.some(coords => coords[3]<coords[1]));
});
test('a node clipped by navigation is scrolled into the viewport before selection', async () => {
  const state = fixture(swipes => [view,navBand,nav,button(swipes.length ? '[66,800][655,868]' : '[66,1120][655,1190]')]);
  assert.equal(fits(button('[66,1120][655,1190]'),viewport([view,navBand,nav])),false);
  const found = await findRoomAction(target,state.options);
  assert.equal(found.bounds,'[66,800][655,868]');assert.ok(state.swipes[0][3]<state.swipes[0][1]);
});
test('a resized wide room sidebar does not clip its fully visible fullscreen action', async () => {
  // Geometry modeled from the failed native 1080x1920 room screenshot: Rooms
  // is on the left, while the fullscreen action is visible beside the stage.
  const wideView={...view,bounds:'[0,36][1080,1884]'};
  const sidebar={...navBand,bounds:'[0,36][123,1884]'};
  const sideRooms={...nav,bounds:'[20,195][110,267]'};
  const fullscreen={...button('[954,786][1019,851]'),'resource-id':'fullscreen-button',clickable:'true'};
  const nodes=[wideView,sidebar,sideRooms,fullscreen];
  assert.deepEqual(viewport(nodes),[0,44,1080,1876]);
  assert.equal(fits(fullscreen,viewport(nodes)),true);
  const state=fixture(()=>nodes);
  assert.equal((await findRoomAction(node=>node['resource-id']==='fullscreen-button',state.options)).bounds,fullscreen.bounds);
  assert.deepEqual(state.swipes,[],'A visible stable fullscreen action must be tapped without trying to scroll the sidebar');
});

test('even lower-edge vertical sidebar buttons are not a horizontal bottom band', () => {
  const wideView={...view,bounds:'[0,36][1080,1884]'};
  const sidebar={...navBand,bounds:'[0,36][123,1884]'};
  const sideRooms={...nav,bounds:'[20,1640][110,1712]'};
  const sideDevices={...nav,text:'Devices',bounds:'[20,1720][110,1792]'};
  const sideSettings={...nav,text:'Settings',bounds:'[20,1800][110,1872]'};
  assert.deepEqual(viewport([wideView,sidebar,sideRooms,sideDevices,sideSettings]),[0,44,1080,1876]);
});

test('observed app bottom navigation and aligned lower horizontal buttons retain clipping', () => {
  assert.deepEqual(viewport([view,navBand,nav]),[0,144,720,1138]);
  const devices={...nav,text:'Devices',bounds:'[306,1160][412,1232]'};
  const settings={...nav,text:'', 'content-desc':'Settings',bounds:'[534,1160][640,1232]'};
  const area=viewport([view,nav,devices,settings]);
  assert.deepEqual(area,[0,144,720,1132]);
  assert.equal(fits(button('[66,1120][655,1190]'),area),false);
  assert.equal(fits(button('[66,800][655,868]'),area),true);
});

test('a horizontal navigation header cannot truncate room content below it', () => {
  const wideView={...view,bounds:'[0,36][1080,1884]'};
  const header={...navBand,bounds:'[0,36][1080,136]'};
  const rooms={...nav,bounds:'[75,55][181,127]'};
  const devices={...nav,text:'Devices',bounds:'[306,55][412,127]'};
  assert.deepEqual(viewport([wideView,header,rooms,devices]),[0,44,1080,1876]);
});

test('foreign, hidden or malformed navigation cannot create a viewport obstruction', () => {
  const foreign='com.android.systemui';
  for(const nodes of [[view,{...navBand,package:foreign},{...nav,package:foreign}],
    [view,{...navBand,package:foreign},nav],[view,{...navBand,'visible-to-user':'false'},nav],
    [view,{...navBand,bounds:'invalid'},nav],
    [view,nav,{...nav,text:'Devices',package:foreign,bounds:'[306,1160][412,1232]'}],
    [view,nav,{...nav,text:'Devices','visible-to-user':'false',bounds:'[306,1160][412,1232]'}],
    [view,nav,{...nav,text:'Devices',bounds:'[306,1180][412,1252]'}],
    [view,{...nav,bounds:'[-10,1160][181,1232]'},{...nav,text:'Devices',bounds:'[306,1160][412,1232]'}],
    [view,nav,{...nav,text:'Devices',bounds:'[700,1160][800,1232]'}],
    [view,nav,{...nav,bounds:'[306,1160][412,1232]'}]]) {
    assert.deepEqual(viewport(nodes),[0,144,720,1237]);
  }
});

test('a resize requires two stable current action bounds and never taps old viewport coordinates', async () => {
  const wideView={...view,bounds:'[0,36][1080,1884]'};
  const sideRooms={...nav,bounds:'[20,195][110,267]'};
  const oldAction={...button('[620,450][680,510]'),'resource-id':'fullscreen-button'};
  const newAction={...button('[954,786][1019,851]'),'resource-id':'fullscreen-button'};
  const snapshots=[[view,navBand,nav,oldAction],[wideView,sideRooms,newAction],[wideView,sideRooms,newAction]];
  let reads=0,clock=0;const swipes=[];
  const found=await findRoomAction(node=>node['resource-id']==='fullscreen-button',{
    read:async()=>snapshots[reads++],swipe:(...coords)=>swipes.push(coords),wait:async ms=>{clock+=ms;},now:()=>clock,timeout:5000});
  assert.equal(reads,3);assert.equal(found.bounds,newAction.bounds);assert.deepEqual(swipes,[]);
});

test('an absent or invisible action fails rather than tapping a different node', async () => {
  const state = fixture(() => [view,navBand,nav,{'resource-id':'host-button','visible-to-user':'false',bounds:'[0,0][0,0]'}]);
  await assert.rejects(findRoomAction(target,state.options),/absent after searching/);
  assert.ok(state.swipes.some(coords => coords[3]>coords[1]));assert.ok(state.swipes.some(coords => coords[3]<coords[1]));
});

test('SystemUI-only observer omissions cannot trigger a blind gesture or consume absent-action scans', async () => {
  const systemUI = {class:'android.widget.FrameLayout',package:'com.android.systemui','visible-to-user':'true',bounds:'[0,0][720,42]'};
  let reads = 0, clock = 0; const swipes = [];
  const snapshots = [[systemUI],[systemUI],[view,navBand,nav,button('[66,843][655,911]')],[systemUI],[view,navBand,nav,button('[66,843][655,911]')],[view,navBand,nav,button('[66,843][655,911]')]];
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
  const nodes = [view,navBand,nav,fullscreen]; const area = viewport(nodes), path = gesturePath(nodes,area,'earlier');
  assert.ok(path);assert.ok(path[3]>path[1]);
  assert.ok(path[0]>area[0] && path[0]<area[2] && path[1]>=area[1] && path[3]<=area[3]);
  assert.ok(path[0]<600 || path[0]>676,'The path must not cross the observed button');
  const nested = {...view,bounds:'[40,180][680,1000]'};const narrowArea=viewport([nested,view]);
  const narrowPath=gesturePath([nested,view],narrowArea,'later');
  assert.ok(narrowPath[0]>40 && narrowPath[0]<680 && narrowPath[3]>=180 && narrowPath[1]<=1000);
});

test('diagnostic observations report actual blocked, swipe and stability decisions without changing the search', async () => {
  const clickedAncestor={...view,clickable:'true',scrollable:'true'};
  const above=button('[66,-40][655,100]'),onScreen=button('[66,300][655,368]');
  const snapshots=[[clickedAncestor,navBand,nav,above],[],[view,navBand,nav,above],
    [view,navBand,nav,onScreen],[view,navBand,nav,onScreen]];
  let reads=0,clock=0;const swipes=[],trace=[];
  const found=await findRoomAction(target,{read:async()=>snapshots[reads++],
    swipe:(...path)=>swipes.push(path),wait:async ms=>{clock+=ms;},now:()=>clock,timeout:5000,
    observe:(nodes,node,decision)=>trace.push({decision,blockers:gestureBlockers(nodes),target:node})});
  assert.equal(found.bounds,onScreen.bounds);assert.equal(reads,5);assert.equal(swipes.length,1);
  assert.deepEqual(trace.map(value=>value.decision.decision),[
    'wait-no-safe-gesture','wait-no-viewport','swipe','wait-stable-action','return-stable-action']);
  assert.deepEqual(trace[2].decision.path,swipes[0]);assert.equal(trace[2].decision.direction,'earlier');
  assert.equal(trace[0].decision.path,null);assert.ok(trace[0].blockers.includes(clickedAncestor));
  assert.equal(trace[1].decision.viewport,null);
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

const statNode = (text,bounds) => ({class:'android.widget.TextView',package:packageName,'visible-to-user':'true',text,bounds});
test('native diagnostic label and packet value are read from the same final stable app snapshot', async () => {
  const label = statNode('Audio received','[51,800][225,821]');
  const packetValue = count=>statNode(`${count} packets`,'[480,800][654,821]');
  const snapshots = [[view,navBand,nav,label,packetValue(417)],[],[view,navBand,nav,label,packetValue(419)],[view,navBand,nav,label,packetValue(420)]];
  let reads=0,clock=0,observedValue;const swipes=[];
  await findRoomAction((node,nodes)=>node.text==='Audio received' && diagnosticValue(node,nodes,/^\d+ packets$/)!==null,
    {read:async()=>snapshots[reads++],swipe:(...coords)=>swipes.push(coords),wait:async ms=>{clock+=ms;},now:()=>clock,timeout:5000,
      observe:(nodes,node)=>{observedValue=node ? diagnosticValue(node,nodes,/^\d+ packets$/) : null;}});
  assert.equal(reads,4);assert.equal(observedValue,'420 packets');assert.deepEqual(swipes,[]);
});

test('missing, clipped, hidden, malformed, wrong-row or ambiguous stat values cannot prove native packets', () => {
  const label=statNode('Audio received','[51,800][225,821]'),value=statNode('419 packets','[480,800][654,821]');
  assert.equal(diagnosticValue(label,[view,navBand,nav,label,value],/^\d+ packets$/),'419 packets');
  for (const nodes of [[],[label,value],[view,navBand,nav,label],[view,navBand,nav,label,{...value,'visible-to-user':'false'}],
    [view,navBand,nav,label,{...value,package:'com.android.systemui'}],[view,navBand,nav,label,{...value,bounds:'[480,800][721,821]'}],
    [view,navBand,nav,label,{...value,bounds:'[480,1120][654,1190]'}],[view,navBand,nav,label,{...value,bounds:'[480,830][654,851]'}],
    [view,navBand,nav,label,{...value,bounds:'invalid'}],[view,navBand,nav,label,{...value,text:'—'}],
    [view,navBand,nav,label,{...value,text:'9999999999999999999999 packets'}],[view,navBand,nav,label,value,{...value}],
    [view,navBand,nav,{...label,'visible-to-user':'false'},value]]) {
    assert.equal(diagnosticValue(nodes.find(node=>node.text==='Audio received'),nodes,/^\d+ packets$/),null);
  }
  assert.equal(diagnosticValue(label,[view,navBand,nav,label,statNode('0 packets',value.bounds)],/^\d+ packets$/),'0 packets',
    'Zero is an actual value; the existing media threshold must reject it');
});

test('native playback states use a visible same-row value without converting failure states to running', () => {
  const label=statNode('Audio playback processing','[51,700][330,721]');
  for(const state of ['running','suspended','interrupted','off']) {
    assert.equal(diagnosticValue(label,[view,navBand,nav,label,statNode(state,'[480,700][654,721]')],/^(running|suspended|interrupted|off)$/),state);
  }
});

test('captured WebView diagnostic values use their actual noninteractive View class and three-pixel row alignment', () => {
  // API 36 observer evidence: labels are TextView nodes, while the HTML stat
  // values are android.view.View nodes with slightly different font bounds.
  const received=statNode('Audio received','[55,415][145,433]');
  const packets={...statNode('442 packets','[588,413][664,434]'),class:'android.view.View',clickable:'false','long-clickable':'false',checkable:'false'};
  assert.equal(diagnosticValue(received,[view,navBand,nav,received,packets],/^\d+ packets$/),'442 packets');
  const returned=statNode('Audio received','[55,545][145,563]');
  const returnedPackets={...packets,text:'453 packets',bounds:'[588,544][664,565]'};
  assert.equal(diagnosticValue(returned,[view,navBand,nav,returned,returnedPackets],/^\d+ packets$/),'453 packets');
  const processing=statNode('Audio playback processing','[55,712][219,730]');
  for(const state of ['running','suspended','interrupted','off']) {
    const value={...packets,text:state,bounds:'[616,710][664,733]'};
    assert.equal(diagnosticValue(processing,[view,navBand,nav,processing,value],/^(running|suspended|interrupted|off)$/),state);
  }
});

test('a View statistic still rejects interactive, foreign, hidden, clipped, wrong-row or ambiguous candidates', () => {
  const label=statNode('Audio received','[55,415][145,433]');
  const value={...statNode('442 packets','[588,413][664,434]'),class:'android.view.View',clickable:'false','long-clickable':'false',checkable:'false'};
  for(const invalid of [{...value,clickable:'true'},{...value,'long-clickable':'true'},{...value,checkable:'true'},
    {...value,class:'android.widget.Button'},{...value,package:'com.android.systemui'},
    {...value,'visible-to-user':'false'},{...value,bounds:'[588,413][721,434]'},
    {...value,bounds:'[588,411][664,434]'},{...value,bounds:'[588,413][664,437]'},
    {...value,text:'442 packets extra'},{...value,text:'9999999999999999999999 packets'}]) {
    assert.equal(diagnosticValue(label,[view,navBand,nav,label,invalid],/^\d+ packets$/),null);
  }
  assert.equal(diagnosticValue(label,[view,navBand,nav,label,value,{...value}],/^\d+ packets$/),null);
  assert.equal(diagnosticValue(label,[label,value],/^\d+ packets$/),null);
  assert.equal(diagnosticValue(label,[view,navBand,nav,label,{...value,text:'0 packets'}],/^\d+ packets$/),'0 packets',
    'A real zero remains zero for the unchanged media threshold');
  assert.equal(diagnosticValue(label,[view,navBand,nav,label,{...value,class:'android.widget.TextView',clickable:'true'}],/^\d+ packets$/),null);
});
