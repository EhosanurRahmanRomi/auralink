const {app, BrowserWindow, ipcMain, session, desktopCapturer, screen, dialog, globalShortcut, clipboard, systemPreferences, shell, powerSaveBlocker} = require('electron');
const path = require('node:path');
const os = require('node:os');
const https = require('node:https');
const {pathToFileURL} = require('node:url');
const selfsigned = require('selfsigned');
const {parseInvite, fingerprint, certificateDecisionForPin} = require('./core/invite.cjs');
const {createBroker} = require('./core/broker.cjs');
const {ControlGate, createAdapter} = require('./native/control.cjs');
const {probeInternetService, NativeInternetClient} = require('./core/internet-client.cjs');
const {parseAppInvitation} = require('./core/app-invitation.cjs');

app.setName('Glance-Port');
let win, broker, adapter, gate, selectedSource, currentSource;
let requestedPresentationFullscreen = null;
let grantGeneration=0;
let roomOperation=0, sourceOperation=0;
let internetService = null, internetClient = null, roomContext = 'nearby';
let microphonePermissionRequest = null;
const pins = new Map();
const sources = new Map();
const localPage = pathToFileURL(path.join(__dirname, 'renderer', 'index.html')).href;
const testing = process.argv.includes('--smoke-test');
// Keep existing room credentials and preferences when upgrading the renamed
// product. Explicit QA profiles remain isolated from the installed app.
if (app.isPackaged && !testing && !app.commandLine.hasSwitch('user-data-dir')) {
  const profile = path.join(app.getPath('appData'), 'Auralink');
  require('node:fs').mkdirSync(profile, {recursive:true});
  app.setPath('userData', profile);
}
let sessionPowerBlocker = null;
function setSessionActive(active) {
  if (typeof active !== 'boolean') throw new Error('Invalid room activity state.');
  if (active && sessionPowerBlocker === null) {
    // Scope this to an admitted room; minimize/restore never reloads its page.
    // The display may sleep. Quitting or ending the room releases the blocker.
    try { sessionPowerBlocker = powerSaveBlocker.start('prevent-app-suspension'); } catch { return {active:false}; }
  } else if (!active && sessionPowerBlocker !== null) {
    try { powerSaveBlocker.stop(sessionPowerBlocker); } finally { sessionPowerBlocker = null; }
  }
  return {active:sessionPowerBlocker !== null};
}
let ownsInstance = true;
let pendingInvitation = process.argv.map(parseAppInvitation).find(Boolean) || null;
function deliverInvitation(value) {
  const code = parseAppInvitation(value); if (!code) return;
  pendingInvitation = code;
  if (win && !win.isDestroyed()) {
    if (win.isMinimized()) win.restore(); win.show(); win.focus();
    if (!win.webContents.isLoadingMainFrame()) win.webContents.send('auralink:invitation', code);
  }
}
// Only installed apps claim the protocol. QA/source launches retain independent
// profiles and never alter the user's default URI handler.
if (app.isPackaged && !testing) {
  ownsInstance = app.requestSingleInstanceLock();
  if (!ownsInstance) app.quit();
  else app.on('second-instance', (_event, argv) => { const url = argv.find(value => parseAppInvitation(value)); if (url) deliverInvitation(url); else if (win) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); } });
}
app.on('open-url', (event, value) => { event.preventDefault(); deliverInvitation(value); });
const mediaPermissions=new Set(['media','display-capture','speaker-selection']);
const networkPermissions=new Set(['local-network','local-network-access','loopback-network']);

function supportedPermission(permission) {
  // Electron 44 forwards Chromium's newer local/loopback network permissions.
  // Only the bundled main page can request them, after a local room or a pinned
  // invitation has been explicitly prepared by the native main process.
  return permission === 'fullscreen' || mediaPermissions.has(permission) || (networkPermissions.has(permission) && pins.size > 0);
}

function trustedContent(contents, details = {}) {
  return Boolean(win && !win.isDestroyed() && contents === win.webContents &&
    contents.getURL().split('#')[0] === localPage && details.isMainFrame !== false);
}
function permissionStatus(type) {
  if (!['win32', 'darwin'].includes(process.platform)) return 'unknown';
  try { return systemPreferences.getMediaAccessStatus(type); } catch { return 'unknown'; }
}
function permissionInfo() {
  return { microphone:permissionStatus('microphone'), screen:permissionStatus('screen'),
    accessibility:process.platform === 'darwin' ? (systemPreferences.isTrustedAccessibilityClient(false) ? 'granted' : 'denied') : 'not-required' };
}
async function requestMedia(type) {
  if (type !== 'microphone') throw new Error('Only microphone permission is supported.');
  let status=permissionStatus(type);
  if (process.platform === 'darwin' && status === 'not-determined') {
    // Native IPC preflight and Chromium's media request can overlap. Share one
    // TCC prompt, and never reinterpret an explicit refusal as permission when
    // macOS has not yet updated its cached access status.
    if (!microphonePermissionRequest) {
      microphonePermissionRequest = Promise.resolve().then(() => systemPreferences.askForMediaAccess(type));
      microphonePermissionRequest.finally(() => { microphonePermissionRequest = null; }).catch(() => {});
    }
    const granted=await microphonePermissionRequest;
    status=granted ? 'granted' : 'denied';
  }
  const ok=process.platform === 'darwin' ? status === 'granted' : !['denied','restricted'].includes(status);
  return {ok,status,reason:ok ? null : `Allow Glance-Port ${type} access in ${process.platform === 'darwin' ? 'System Settings → Privacy & Security' : 'Windows Settings → Privacy & security'}. Restart Glance-Port after changing access.`};
}
const settingsLinks = {
  darwin:{microphone:'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone',screen:'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',accessibility:'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',network:'x-apple.systempreferences:com.apple.preference.security?Privacy_LocalNetwork'},
  win32:{microphone:'ms-settings:privacy-microphone'},
};

function assertSender(event) {
  if (!win || event.sender !== win.webContents || !event.senderFrame || event.senderFrame !== win.webContents.mainFrame || event.senderFrame.url.split('#')[0] !== localPage) throw new Error('Privileged action blocked for untrusted content.');
}
function handle(name, fn) { ipcMain.handle(`auralink:${name}`, async (event, value) => {assertSender(event); return fn(value);}); }
function localAddresses() {
  return Object.entries(os.networkInterfaces()).flatMap(([name, list]) => list.filter(x => x.family === 'IPv4' && !x.internal && !x.address.startsWith('169.254.')).map(x=>({name,address:x.address}))).sort((a,b)=>Number(/virtual|vmware|vbox/i.test(a.name))-Number(/virtual|vmware|vbox/i.test(b.name)));
}
async function revoke() { grantGeneration++; if (gate) await gate.revoke(); }
function resetRoomSources() { roomOperation++; sourceOperation++; sources.clear(); selectedSource=null; currentSource=null; }
function assertRoomOperation(operation) { if(operation !== roomOperation) throw new Error('Room preparation was canceled.'); }
function pinOrigin(origin, fp) { pins.set(new URL(origin).hostname, fp); }
function certificateDecision(request, callback) {
  callback(certificateDecisionForPin(pins.get(request.hostname),request.certificate.data,request.verificationResult));
}
function emergencyStop(reason) {
  revoke().catch(()=>{});
  if (win && !win.isDestroyed()) win.webContents.send('auralink:emergency-stop', typeof reason === 'string' ? reason : undefined);
}
function displayLayoutChanged() {
  sourceOperation++; sources.clear(); selectedSource = null; currentSource = null;
  emergencyStop('Display layout changed. Select a screen and approve control again.');
}
function probeCertificate(origin, expected) {
  return new Promise((resolve, reject) => {
    const req = https.get(`${origin}/health`, {rejectUnauthorized:false, timeout:5000, agent:false}, res => {
      try {
        const raw = res.socket.getPeerCertificate(true).raw;
        if (!raw || fingerprint(raw) !== expected) throw new Error('Host certificate does not match the invitation.');
        res.resume(); resolve();
      } catch (error) {res.destroy(); reject(error);}
    });
    req.on('timeout',()=>req.destroy(new Error('Host is unreachable. Check that both apps are open and the network permits connections.')));
    req.on('error',reject);
  });
}
function internetAuthorizationLost(details) {
  if (roomContext !== 'internet') return;
  if (details.kind === 'room' && roomContext === 'internet') { resetRoomSources(); setSessionActive(false); }
  void revoke();
}
function acceptedForControl(peerId) {
  if (roomContext === 'internet') return Boolean(internetClient?.membership.isAcceptedPeer(peerId));
  return !broker || broker.isAcceptedPeer(peerId);
}

app.whenReady().then(async () => {
  if (!ownsInstance) return;
  if (app.isPackaged && !testing && process.platform === 'win32') app.setAsDefaultProtocolClient('auralink');
  adapter = createAdapter({onError:emergencyStop});
  gate = new ControlGate(adapter,{onFailure:emergencyStop});
  screen.on('display-removed', displayLayoutChanged);
  screen.on('display-added', displayLayoutChanged);
  screen.on('display-metrics-changed', (_event, _display, metrics) => {
    if (metrics.some(metric => ['bounds', 'scaleFactor', 'rotation'].includes(metric))) displayLayoutChanged();
  });
  session.defaultSession.setCertificateVerifyProc(certificateDecision);
  session.defaultSession.setPermissionRequestHandler(async (contents, permission, callback, details = {}) => {
    if (!trustedContent(contents,details) || !supportedPermission(permission)) return callback(false);
    try {
      // Browser consent alone cannot override the macOS TCC decision. Ask only
      // for the sensor requested by the local getUserMedia action.
      if (permission === 'media') {
        const types=details.mediaTypes;
        if (!Array.isArray(types)) return callback(false);
        // Electron 44.6 reports getDisplayMedia through `media` with an empty
        // device list before invoking the separate display-source handler.
        // Permit that legacy stage only after the owner selected a current
        // source; the handler below consumes and revalidates that selection.
        if (!types.length) {
          if (!selectedSource || !sources.has(selectedSource.id) || Date.now()-selectedSource.at > 30000) return callback(false);
        } else {
          if (types.some(type => type !== 'audio')) return callback(false);
          const deviceCapture = selectedSource?.purpose === 'device-audio' && currentSource?.id === selectedSource.id && Date.now()-selectedSource.at <= 30000;
          // Playback capture uses its own OS system-audio permission. It must
          // never trigger the microphone TCC prompt or turn on that sensor.
          if (!deviceCapture && !(await requestMedia('microphone')).ok) return callback(false);
        }
      }
      callback(trustedContent(contents,details));
    } catch { callback(false); }
  });
  session.defaultSession.setPermissionCheckHandler((contents, permission, origin, details = {}) => Boolean(trustedContent(contents,details) && supportedPermission(permission) && (permission !== 'media' || details.mediaType !== 'video')));
  session.defaultSession.setDisplayMediaRequestHandler(async (request, callback) => {
    if (!win || !request.frame || request.frame !== win.webContents.mainFrame || !selectedSource || Date.now()-selectedSource.at > 30000) return callback({});
    const chosen = selectedSource; selectedSource = null;
    const captureGeneration = grantGeneration;
    const captureRoom = roomOperation;
    const captureContext = roomContext;
    try {
      const available = await desktopCapturer.getSources({types:['screen','window'],thumbnailSize:{width:0,height:0}});
      const source = available.find(s=>s.id===chosen.id);
      if (!source || captureGeneration !== grantGeneration || captureRoom !== roomOperation || captureContext !== roomContext ||
          (process.platform === 'darwin' && permissionStatus('screen') !== 'granted') ||
          (captureContext === 'internet' && !internetClient?.membership.roomId)) return callback({});
      if (chosen.purpose === 'device-audio') {
        if (!request.audioRequested || !currentSource || currentSource.id !== chosen.id || !['win32','darwin'].includes(process.platform)) return callback({});
        callback({video:source, audio:'loopback'});
      } else { currentSource = source; callback({video:source}); }
    } catch {callback({});}
  });

  handle('host', async args => {
    resetRoomSources(); const operation=roomOperation;
    const previous=broker; broker=null;
    await revoke();
    if (previous) await previous.stop();
    assertRoomOperation(operation);
    roomContext = 'nearby';
    const name = String(args?.name || 'My room').trim().slice(0,48) || 'My room';
    const pems = await selfsigned.generate([{name:'commonName',value:'Glance-Port private room'}], {keyType:'ec',curve:'P-256',notAfterDate:new Date(Date.now()+30*86400000),algorithm:'sha256'});
    assertRoomOperation(operation);
    const certPin = fingerprint(pems.cert);
    const requestedPort=Number(args?.port || 0);
    if(!Number.isInteger(requestedPort)||requestedPort<0||requestedPort>65535||(requestedPort>0&&requestedPort<1024)) throw new Error('Choose a port between 1024 and 65535.');
    const created = await createBroker({name, port:requestedPort, tls:{key:pems.private,cert:pems.cert}, assetsDir:path.join(__dirname,'renderer')});
    if(operation !== roomOperation) { await created.stop(); throw new Error('Room preparation was canceled.'); }
    broker=created;
    const url = `https://127.0.0.1:${created.port}`;
    pinOrigin(url, certPin);
    session.defaultSession.setCertificateVerifyProc(certificateDecision);
    const addresses = localAddresses();
    const invites = addresses.map(a=>({name:a.name,address:a.address,invite:`https://${a.address}:${created.port}/#key=${created.roomKey}&fp=${certPin}`}));
    const invite = invites[0]?.invite || `${url}/#key=${created.roomKey}&fp=${certPin}`;
    return {name,url,roomKey:created.roomKey,hostToken:created.hostToken,port:created.port,fingerprint:certPin,invite,invites};
  });
  handle('stop', async () => {setSessionActive(false); resetRoomSources(); const previous=broker; broker=null; await revoke(); if(previous) await previous.stop(); return {ok:true};});
  handle('trust-invite', async value => {
    resetRoomSources(); const operation=roomOperation;
    const invite = parseInvite(value);
    await probeCertificate(invite.url, invite.fingerprint);
    assertRoomOperation(operation);
    await revoke();
    assertRoomOperation(operation);
    roomContext = 'nearby';
    pinOrigin(invite.url, invite.fingerprint);
    // Changing the verifier clears Chromium's certificate decision cache.
    session.defaultSession.setCertificateVerifyProc(certificateDecision);
    return invite;
  });
  handle('trust-internet-service', async value => {
    if (internetClient && !internetClient.closed) throw new Error('Disconnect Internet before changing its service address.');
    internetService = await probeInternetService(value);
    return internetService;
  });
  handle('internet-open', args => {
    if (!internetService || typeof args?.socketId !== 'string' || !/^internet-[0-9]{1,16}$/.test(args.socketId) || args.url !== internetService.socketUrl) throw new Error('Verify the internet service before connecting.');
    if (internetClient && !internetClient.closed) throw new Error('An internet connection is already open.');
    internetClient = new NativeInternetClient(internetService.url, args.socketId, message => {
      if (message.type === 'message') {
        let payload;
        try { payload = JSON.parse(message.data); } catch { return; }
        if (payload.type === 'welcome') {
          resetRoomSources(); void revoke();
          roomContext = 'internet';
        }
      }
      if (win && !win.isDestroyed()) win.webContents.send('auralink:internet-event', message);
    }, internetAuthorizationLost);
    return { ok: true };
  });
  handle('internet-send', args => {
    if (!internetClient || args?.socketId !== internetClient.socketId) throw new Error('Unknown internet connection.');
    internetClient.send(args.data); return { ok: true };
  });
  handle('internet-close', args => {
    if (internetClient && args?.socketId === internetClient.socketId) internetClient.close();
    return { ok: true };
  });
  handle('pending-invitation', () => { const code = pendingInvitation; pendingInvitation = null; return code; });
  handle('sources', async () => {
    const operation=roomOperation, request=++sourceOperation;
    // A failed refresh must not leave an older chooser authorization usable.
    sources.clear(); selectedSource=null;
    const available = await desktopCapturer.getSources({types:['screen','window'],thumbnailSize:{width:320,height:180},fetchWindowIcons:false});
    if(operation !== roomOperation || request !== sourceOperation) throw new Error('Screen selection was canceled.');
    if (process.platform === 'darwin' && permissionStatus('screen') !== 'granted') {
      throw new Error('Allow Glance-Port Screen & System Audio Recording in System Settings → Privacy & Security, then restart Glance-Port before sharing.');
    }
    sources.clear();
    for(const source of available) sources.set(source.id,source);
    return available.map(s=>({id:s.id,name:s.name,displayId:s.display_id,thumbnail:s.thumbnail.toDataURL(),canControl:s.id.startsWith('screen:')}));
  });
  handle('choose-screen', id => {
    if(typeof id!=='string'||!sources.has(id)) throw new Error('Select an available screen.');
    selectedSource={id,at:Date.now()}; return {ok:true};
  });
  handle('prepare-system-audio', () => {
    if (!['win32','darwin'].includes(process.platform)) throw new Error('Device audio capture is unavailable on this desktop.');
    if (process.platform === 'darwin' && Number(os.release().split('.')[0]) < 22) throw new Error('Device audio requires macOS 13 or newer.');
    if (!currentSource || !currentSource.id.startsWith('screen:') || (roomContext === 'internet' && !internetClient?.membership.roomId)) throw new Error('Share a full display before enabling device audio.');
    sources.set(currentSource.id, currentSource);
    selectedSource = {id:currentSource.id, at:Date.now(), purpose:'device-audio', token:++sourceOperation};
    return {ok:true, sourceId:currentSource.id, token:selectedSource.token};
  });
  handle('cancel-system-audio', token => { if (selectedSource?.purpose === 'device-audio' && selectedSource.token === token) selectedSource = null; return {ok:true}; });
  handle('grant-control', async args => {
    if(testing) return {ok:false,reason:'Remote input is disabled in automated tests.'};
    if(!adapter.available) return {ok:false,reason:'Native input helper is unavailable on this platform.'};
    if(!currentSource || currentSource.id !== args?.screenId || !currentSource.id.startsWith('screen:')) return {ok:false,reason:'Share a full display before granting control.'};
    if(typeof args.peerId!=='string'||args.peerId.length>128||typeof args.sessionId!=='string'||! /^[A-Za-z0-9_-]{16,128}$/.test(args.sessionId)) return {ok:false,reason:'Invalid control request.'};
    const peerName=String(args.name || args.peerId).replace(/[\x00-\x1f]/g,'').slice(0,48);
    const approvedSource=currentSource;
    const approvalGeneration=grantGeneration;
    if(!acceptedForControl(args.peerId)) return {ok:false,reason:'Participant is no longer in this room.'};
    const result=await dialog.showMessageBox(win,{type:'warning',buttons:['Keep view only','Allow control'],defaultId:0,cancelId:0,title:'Approve remote control',message:`Allow ${peerName} to control the shared display?`,detail:'They can move your pointer and type into normal desktop apps. Only approve someone you trust. Stop instantly with Ctrl+Alt+Shift+Q (Command+Option+Shift+Q on Mac).'});
    if(result.response!==1) return {ok:false,reason:'Control was not approved.'};
    if(currentSource !== approvedSource || grantGeneration !== approvalGeneration) return {ok:false,reason:'Session changed while approval was open.'};
    if(!acceptedForControl(args.peerId)) return {ok:false,reason:'Participant disconnected during approval.'};
    if(process.platform === 'darwin' && !systemPreferences.isTrustedAccessibilityClient(true)) {
      return {ok:false,reason:'Enable Glance-Port in System Settings → Privacy & Security → Accessibility, then approve this request again. The Mac owner must grant this system permission.'};
    }
    const display=screen.getAllDisplays().find(d=>String(d.id)===currentSource.display_id);
    if(!display) return {ok:false,reason:'The shared display could not be matched to a native input surface.'};
    let bounds=display.bounds;
    if(process.platform==='win32') bounds=screen.dipToScreenRect(null,bounds);
    return await gate.grant({peerId:args.peerId,sessionId:args.sessionId,display:bounds});
  });
  handle('revoke-control',async()=>{await revoke(); return {ok:true};});
  handle('stop-sharing',async()=>{sourceOperation++;sources.clear();currentSource=null;selectedSource=null;await revoke();return {ok:true};});
  handle('input',args=>{
    if(roomContext==='internet' && !internetClient?.membership.isGrantConfirmed(args?.peerId,args?.sessionId)) return {ok:false,reason:'The internet room has not confirmed this control grant.'};
    return gate.apply(args);
  });
  handle('copy',value=>{if(typeof value!=='string'||value.length>4096) throw new Error('Invalid clipboard value.');clipboard.writeText(value);return {ok:true};});
  handle('request-media',requestMedia);
  handle('permission-settings',async type=>{
    const url=typeof type==='string' && settingsLinks[process.platform]?.[type];
    if(!url) throw new Error('This permission settings page is unavailable on this platform.');
    await shell.openExternal(url);return {ok:true};
  });
  handle('info',()=>({version:app.getVersion(),platform:process.platform,hostname:os.hostname(),addresses:localAddresses(),nativeControl:Boolean(adapter.available),nativeSupports:adapter.supports,permissions:permissionInfo(),emergencyShortcut:process.platform==='darwin'?'Command+Option+Shift+Q':'Ctrl+Alt+Shift+Q',testing}));
  handle('session-active',setSessionActive);
  handle('presentation-fullscreen',active=>{
    if(typeof active !== 'boolean') throw new Error('Invalid fullscreen state.');
    requestedPresentationFullscreen = active;
    try { win.setFullScreen(active); } catch(error) { requestedPresentationFullscreen=null; throw error; }
    // macOS transitions asynchronously. The window events below confirm the
    // actual state; presentation layout remains usable during the transition.
    return {fullscreen:active};
  });

  win=new BrowserWindow({width:1380,height:880,minWidth:900,minHeight:650,show:false,icon:path.join(__dirname,'..','build','icon.png'),backgroundColor:'#110f23',title:'Glance-Port',titleBarStyle:'hidden',titleBarOverlay:{color:'#00000000',symbolColor:'#f8f5ff',height:44},...(process.platform==='darwin'?{trafficLightPosition:{x:16,y:16}}:{}),autoHideMenuBar:true,webPreferences:{preload:path.join(__dirname,'preload.cjs'),nodeIntegration:false,contextIsolation:true,sandbox:true,webSecurity:true,spellcheck:false,backgroundThrottling:false}});
  for(const [event,fullscreen] of [['enter-full-screen',true],['leave-full-screen',false]]) win.on(event,()=>{
    if(win.isDestroyed()) return;
    // A Mac transition may finish after the user has already requested its
    // opposite. Reconcile that latest intent without publishing a stale exit
    // that would collapse a newly opened presentation.
    if(requestedPresentationFullscreen !== null && requestedPresentationFullscreen !== fullscreen) { win.setFullScreen(requestedPresentationFullscreen); return; }
    requestedPresentationFullscreen=null;
    win.webContents.send('auralink:presentation-fullscreen',{fullscreen});
  });
  win.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  win.webContents.on('will-navigate',event=>event.preventDefault());
  win.webContents.on('render-process-gone',()=>{setSessionActive(false);internetClient?.close();emergencyStop();});
  win.on('closed',()=>{requestedPresentationFullscreen=null;setSessionActive(false);internetClient?.close();emergencyStop();win=null;});
  win.once('ready-to-show',()=>win.show());
  await win.loadFile(path.join(__dirname,'renderer','index.html'));
  globalShortcut.register(process.platform==='darwin'?'Command+Alt+Shift+Q':'Control+Alt+Shift+Q',emergencyStop);
});
app.on('before-quit',()=>{setSessionActive(false);internetClient?.close();if(gate)gate.revoke();if(adapter)adapter.dispose();if(broker)broker.stop();globalShortcut.unregisterAll();});
app.on('window-all-closed',()=>app.quit());
