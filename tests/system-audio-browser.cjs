'use strict';
// Explicit synthetic device/microphone capture inputs; real shipped renderer,
// mixer, RTC and encrypted Opus/PCM encode/decode. No hardware capture claim.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const WebSocket = require('ws');
const selfsigned = require('selfsigned');
const {chromium} = require('playwright');
const {createBroker} = require('../src/core/broker.cjs');
const root = path.resolve(__dirname,'..');
const browserPath = [process.env.AURALINK_TEST_BROWSER,'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe','C:/Program Files/Google/Chrome/Application/chrome.exe','/Applications/Google Chrome.app/Contents/MacOS/Google Chrome','/usr/bin/chromium'].filter(Boolean).find(fs.existsSync);
if (!browserPath) throw new Error('A Chromium browser is required for the real audio graph test.');
async function fixture(broker) {
  const socket = new WebSocket(`wss://127.0.0.1:${broker.port}/ws`,{rejectUnauthorized:false});
  const queued = [], waits = [];
  socket.on('message',data=>{const value=JSON.parse(data);const index=waits.findIndex(wait=>wait.type===value.type);if(index>=0){const [wait]=waits.splice(index,1);clearTimeout(wait.timer);wait.resolve(value);}else queued.push(value);});
  const take=type=>new Promise((resolve,reject)=>{const index=queued.findIndex(value=>value.type===type);if(index>=0)return resolve(queued.splice(index,1)[0]);const wait={type,resolve,timer:setTimeout(()=>reject(new Error(`Missing ${type}`)),10000)};waits.push(wait);});
  await new Promise((resolve,reject)=>{socket.once('open',resolve);socket.once('error',reject);});
  const send=value=>socket.send(JSON.stringify(value));send({type:'join',name:'Audio fixture owner',roomKey:broker.roomKey,hostToken:broker.hostToken});await take('welcome');
  return {socket,take,send};
}
async function main() {
  const output=path.join(root,'test-results');fs.mkdirSync(output,{recursive:true});
  let browser,broker,owner,page;const errors=[];let phase='launch';const proof={boundary:'Explicit synthetic 440 Hz left / 880 Hz right device capture and 200 Hz mono microphone. Real bundled renderer controls, Web Audio stereo mix and shipped encrypted WebCodecs Opus/PCM relay. No physical device/system-permission or network-route claim.'};
  try {
    const cert=await selfsigned.generate([{name:'commonName',value:'localhost'}],{keySize:2048,algorithm:'sha256'});
    broker=await createBroker({host:'127.0.0.1',name:'Device audio QA',tls:{key:cert.private,cert:cert.cert},assetsDir:path.join(root,'src','renderer')});owner=await fixture(broker);
    browser=await chromium.launch({executablePath:browserPath,headless:true,args:['--autoplay-policy=no-user-gesture-required','--disable-audio-output']});
    const context=await browser.newContext({ignoreHTTPSErrors:true,viewport:{width:1280,height:960}});
    await context.addInitScript(()=>{
      const qa=window.systemAudioQA={microphoneCalls:0,deviceCalls:0,contexts:[],tracks:[],missingAudio:false,delayAudio:false,pendingAudio:null};
      function tone(frequencies) {
        const ctx=new AudioContext({sampleRate:48000});qa.contexts.push(ctx);const destination=ctx.createMediaStreamDestination();destination.channelCount=frequencies.length;destination.channelCountMode='explicit';const merge=ctx.createChannelMerger(frequencies.length);merge.connect(destination);
        frequencies.forEach((frequency,index)=>{const osc=ctx.createOscillator();const gain=ctx.createGain();osc.frequency.value=frequency;gain.gain.value=.2;osc.connect(gain);gain.connect(merge,0,index);osc.start();});
        void ctx.resume();qa.tracks.push(...destination.stream.getTracks());return destination.stream;
      }
      navigator.mediaDevices.getUserMedia=async()=>{qa.microphoneCalls++;return tone([200]);};
      navigator.mediaDevices.getDisplayMedia=async constraints=>{
        if(constraints.audio){qa.deviceCalls++;if(qa.delayAudio)await new Promise(resolve=>qa.pendingAudio=resolve);if(qa.missingAudio)return new MediaStream();return tone([440,880]);}
        const canvas=document.createElement('canvas');canvas.width=640;canvas.height=360;canvas.getContext('2d').fillRect(0,0,640,360);const stream=canvas.captureStream(2);qa.tracks.push(...stream.getTracks());return stream;
      };
      window.glancePort={platform:'win32',getInfo:async()=>({platform:'win32',nativeControl:false}),sources:async()=>[{id:'screen:fixture',name:'Synthetic device display',thumbnail:''}],chooseScreen:async()=>({ok:true}),prepareSystemAudio:async()=>({ok:true,token:1}),cancelSystemAudio:async()=>({ok:true}),stopSharing:async()=>({ok:true}),copyText:async()=>({ok:true}),requestMedia:async()=>({ok:true}),setSessionActive:async()=>({active:true})};
    });
    page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));
    await page.goto(`https://127.0.0.1:${broker.port}/#key=${broker.roomKey}`);await page.locator('#join-dialog').waitFor({state:'visible'});await page.locator('#join-submit').click();const request=await owner.take('join-request');owner.send({type:'approve',peerId:request.peerId});await page.waitForFunction(()=>!document.getElementById('mic-button').disabled);
    await page.evaluate(async()=>{
      const {RoomRTC}=await import('./rtc.js');const original=RoomRTC.prototype.setTrack;systemAudioQA.published=null;RoomRTC.prototype.setTrack=async function(kind,track,stream){if(kind==='audio')systemAudioQA.published={track,stream};return original.call(this,kind,track,stream);};
      systemAudioQA.measure=async()=>{
        const track=systemAudioQA.published?.track;if(!track)return null;const context=new AudioContext({sampleRate:48000});await context.resume();const source=context.createMediaStreamSource(new MediaStream([track]));const split=context.createChannelSplitter(2);source.connect(split);const silent=context.createGain();silent.gain.value=0;silent.connect(context.destination);const analysers=[0,1].map(channel=>{const analyser=context.createAnalyser();analyser.fftSize=4096;split.connect(analyser,channel);analyser.connect(silent);return analyser;});await new Promise(resolve=>setTimeout(resolve,400));
        const values=analysers.map(analyser=>{const bins=new Float32Array(analyser.frequencyBinCount);analyser.getFloatFrequencyData(bins);return Object.fromEntries([200,440,880].map(frequency=>[frequency,Math.max(...bins.slice(Math.round(frequency*4096/48000)-1,Math.round(frequency*4096/48000)+2))]));});
        source.disconnect();split.disconnect();await context.close();return {sampleRate:track.getSettings().sampleRate,channels:track.getSettings().channelCount,frequencies:values,trackMuted:track.muted,trackEnabled:track.enabled,fixtureContextStates:systemAudioQA.contexts.map(context=>context.state)};
      };
    });
    phase='independent device audio';await page.locator('#share-button').click();await page.locator('.screen-source').click();await page.waitForFunction(()=>!document.getElementById('system-audio-button').disabled);await page.locator('#system-audio-button').click();await page.waitForFunction(()=>document.getElementById('system-audio-button').getAttribute('aria-pressed')==='true');
    proof.deviceOnly=await page.evaluate(async()=>({microphoneCalls:systemAudioQA.microphoneCalls,deviceCalls:systemAudioQA.deviceCalls,measurement:await systemAudioQA.measure()}));assert.equal(proof.deviceOnly.microphoneCalls,0);assert.equal(proof.deviceOnly.deviceCalls,1);assert.equal(proof.deviceOnly.measurement.sampleRate,48000);assert.equal(proof.deviceOnly.measurement.channels,2);assert.ok(proof.deviceOnly.measurement.frequencies[0][440]>proof.deviceOnly.measurement.frequencies[0][880]+15);assert.ok(proof.deviceOnly.measurement.frequencies[1][880]>proof.deviceOnly.measurement.frequencies[1][440]+15);
    phase='independent microphone mix';await page.locator('#mic-button').click();await page.waitForFunction(()=>document.getElementById('mic-button').classList.contains('enabled'));proof.mixed=await page.evaluate(()=>systemAudioQA.measure());for(let index=0;index<2;index++)assert.ok(proof.mixed.frequencies[index][200]>-65&&proof.mixed.frequencies[index][200]>proof.deviceOnly.measurement.frequencies[index][200]+50,'Mic must enter both stereo channels well above the device-only baseline');
    await page.locator('#mic-button').click();await page.waitForFunction(()=>!document.getElementById('mic-button').classList.contains('enabled'));proof.microphoneOffDeviceOn=await page.evaluate(()=>systemAudioQA.measure());for(const channel of proof.microphoneOffDeviceOn.frequencies)assert.ok(channel[200]<-70,'Turning microphone off must remove only microphone');assert.equal(await page.locator('#system-audio-button').getAttribute('aria-pressed'),'true');
    phase='encrypted high fidelity relay';proof.relay=await page.evaluate(async()=>{
      const {RelayMedia}=await import('./relay-media.js');const secret=crypto.getRandomValues(new Uint8Array(32));const key=btoa(String.fromCharCode(...secret)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');let sender,receiver;const received={};const entry=()=>({remoteState:{audio:true},remoteTracks:new Map(),inactiveRemoteTracks:new Map()});
      const make=(selfId,peerId,localTracks)=>({selfId,closed:false,peers:new Map([[peerId,entry()]]),localTracks,mediaState:()=>({audio:localTracks.has('audio'),screen:false}),applyMediaState(id,state){Object.assign(this.peers.get(id).remoteState,state);},emit(type,detail){if(type==='track'&&detail.kind==='audio')received.track=detail.track;},signal(_id,data){(selfId==='owner'?receiver:sender).receive(selfId,data.relay);return true;}});
      const rtc=make('owner','guest',new Map([['audio',systemAudioQA.published]])),remote=make('guest','owner',new Map());sender=new RelayMedia(rtc,key);receiver=new RelayMedia(remote,key);sender.activate('guest');receiver.activate('owner');
      const deadline=performance.now()+10000;while(performance.now()<deadline&&(!(receiver.peers.get('owner').outputs.get('audio')?.codec==='opus')||receiver.peers.get('owner').audioPackets<8))await new Promise(resolve=>setTimeout(resolve,40));
      const output=receiver.peers.get('owner').outputs.get('audio');if(!output||output.codec!=='opus')throw new Error('Real stereo Opus did not negotiate/decode');
      const saved=systemAudioQA.published;systemAudioQA.published={track:received.track,stream:new MediaStream([received.track])};const measurement=await systemAudioQA.measure();systemAudioQA.published=saved;
      const result={codec:output.codec,packets:receiver.peers.get('owner').audioPackets,measurement,sentBytes:sender.peers.get('guest').sent};sender.close();receiver.close();return result;
    });assert.equal(proof.relay.codec,'opus');assert.ok(proof.relay.packets>=8);assert.ok(proof.relay.measurement.frequencies[0][440]>proof.relay.measurement.frequencies[0][880]+12);assert.ok(proof.relay.measurement.frequencies[1][880]>proof.relay.measurement.frequencies[1][440]+12);
    phase='device audio stop';await page.locator('#system-audio-button').click();await page.waitForFunction(()=>!systemAudioQA.published?.track);assert.equal(await page.evaluate(()=>systemAudioQA.microphoneCalls),1);assert.equal(await page.locator('#share-button').innerText(),'Stop sharing');
    phase='missing loopback audio';await page.evaluate(()=>systemAudioQA.missingAudio=true);await page.locator('#system-audio-button').click();await page.locator('.toast.error').filter({hasText:'did not provide device sound'}).waitFor();assert.equal(await page.locator('#system-audio-button').getAttribute('aria-pressed'),'false');assert.equal(await page.evaluate(()=>systemAudioQA.published?.track||null),null);
    phase='late room-leave permission';await page.evaluate(()=>{systemAudioQA.missingAudio=false;systemAudioQA.delayAudio=true;});await page.locator('#system-audio-button').click();await page.waitForFunction(()=>systemAudioQA.pendingAudio!==null);await page.locator('#end-button').click();await page.evaluate(()=>systemAudioQA.pendingAudio());await page.waitForFunction(()=>systemAudioQA.tracks.every(track=>track.readyState==='ended'));proof.latePermissionTracksStopped=true;proof.independentToggles=true;proof.errors=errors;assert.deepEqual(errors,[]);proof.passed=true;fs.writeFileSync(path.join(output,'system-audio-browser.json'),JSON.stringify(proof,null,2));console.log(JSON.stringify(proof,null,2));
  } catch(error){fs.writeFileSync(path.join(output,'system-audio-browser.json'),JSON.stringify({...proof,passed:false,phase,error:String(error.stack||error),errors},null,2));throw error;}
  finally{owner?.socket.close();await browser?.close();await broker?.stop();}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
