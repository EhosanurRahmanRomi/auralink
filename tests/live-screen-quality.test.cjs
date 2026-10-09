'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ready = import('data:text/javascript;base64,' + fs.readFileSync(path.join(__dirname,'../src/renderer/rtc.js')).toString('base64'));

test('an older negotiation tune cannot overwrite a newer live quality selection on any peer', async () => {
  const {RoomRTC} = await ready; const rtc = new RoomRTC({selfId:'owner',signal(){}});
  let release, entered; const pending = new Promise(resolve => {release=resolve;}); const started = new Promise(resolve => {entered=resolve;});
  const make = delayed => ({track:{kind:'video'}, current:0, getParameters(){return {encodings:[{}]};},
    async setParameters(parameters){if(delayed && parameters.encodings[0].maxBitrate===7000000){entered();await pending;} this.current=parameters.encodings[0].maxBitrate;}});
  const first = make(true), second = make(false);
  for (const [id,sender] of [['first',first],['second',second]]) rtc.peers.set(id,{info:{id},senders:new Map([['screen',sender]]),pc:{close(){}}});
  const old = rtc.setVideoLimits('1440'); await started;
  const latest = rtc.setVideoLimits('720');
  // Give the competing tune a chance to reach healthy peers before the older
  // browser call returns. The latest operation owns the final value everywhere.
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(second.current,2200000,'A healthy peer must apply the newest limit without waiting on another peer\'s pending browser operation');
  release(); await Promise.all([old,latest]);
  assert.equal(rtc.quality,'720'); assert.equal(first.current,2200000); assert.equal(second.current,2200000); rtc.close();
});

test('a queued quality update cannot tune a removed or relay-switched peer after its preceding browser call settles', async () => {
  const {RoomRTC} = await ready;
  for(const replacement of ['removed','relay']) {
    const rtc = new RoomRTC({selfId:'owner',signal(){}});
    let release, entered, calls=0; const pending = new Promise(resolve=>{release=resolve;}); const started = new Promise(resolve=>{entered=resolve;});
    const sender={track:{kind:'video'},getParameters(){return {encodings:[{}]};},async setParameters(){calls++;entered();await pending;}};
    const entry={info:{id:'guest'},senders:new Map([['screen',sender]]),pc:{close(){}}}; rtc.peers.set('guest',entry);
    const old=rtc.setVideoLimits('1440');await started;const next=rtc.setVideoLimits('720');
    if(replacement==='removed')rtc.removePeer('guest');else entry.relayActive=true;
    release();await Promise.all([old,next]);assert.equal(calls,1,'A retired direct route must not receive the queued tuning operation');rtc.close();
  }
});
