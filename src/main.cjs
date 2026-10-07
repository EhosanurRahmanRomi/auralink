const {app, BrowserWindow, ipcMain, session, desktopCapturer, screen, dialog, globalShortcut, clipboard, systemPreferences, shell} = require('electron');
const path = require('node:path');
const os = require('node:os');
const https = require('node:https');
const {pathToFileURL} = require('node:url');
const selfsigned = require('selfsigned');
const {parseInvite, fingerprint, certificateDecisionForPin} = require('./core/invite.cjs');
const {createBroker} = require('./core/broker.cjs');
const {ControlGate, createAdapter} = require('./native/control.cjs');

app.setName('Auralink');
let win, broker, adapter, gate, selectedSource, currentSource;
let grantGeneration=0;
const pins = new Map();
const sources = new Map();
const localPage = pathToFileURL(path.join(__dirname, 'renderer', 'index.html')).href;
const testing = process.argv.includes('--smoke-test');
const mediaPermissions=new Set(['media','display-capture','speaker-selection']);
const networkPermissions=new Set(['local-network','local-network-access','loopback-network']);

function supportedPermission(permission) {
  // Electron 44 forwards Chromium's newer local/loopback network permissions.
  // Only the bundled main page can request them, after a local room or a pinned
  // invitation has been explicitly prepared by the native main process.
  return mediaPermissions.has(permission) || (networkPermissions.has(permission) && pins.size > 0);
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
  return { microphone:permissionStatus('microphone'), camera:permissionStatus('camera'), screen:permissionStatus('screen'),
    accessibility:process.platform === 'darwin' ? (systemPreferences.isTrustedAccessibilityClient(false) ? 'granted' : 'denied') : 'not-required' };
}
async function requestMedia(type) {
  if (!['microphone','camera'].includes(type)) throw new Error('Choose microphone or camera permission.');
  let status=permissionStatus(type);
  if (process.platform === 'darwin' && status === 'not-determined') {
    const granted=await systemPreferences.askForMediaAccess(type);
    status=granted ? 'granted' : permissionStatus(type);
  }
  const ok=!['denied','restricted'].includes(status);
  return {ok,status,reason:ok ? null : `Allow Auralink ${type} access in ${process.platform === 'darwin' ? 'System Settings → Privacy & Security' : 'Windows Settings → Privacy & security'}. Restart Auralink after changing access.`};
}
const settingsLinks = {
  darwin:{microphone:'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone',camera:'x-apple.systempreferences:com.apple.preference.security?Privacy_Camera',screen:'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',accessibility:'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',network:'x-apple.systempreferences:com.apple.preference.security?Privacy_LocalNetwork'},
  win32:{microphone:'ms-settings:privacy-microphone',camera:'ms-settings:privacy-webcam'},
};

function assertSender(event) {
  if (!win || event.sender !== win.webContents || !event.senderFrame || event.senderFrame !== win.webContents.mainFrame || event.senderFrame.url.split('#')[0] !== localPage) throw new Error('Privileged action blocked for untrusted content.');
}
function handle(name, fn) { ipcMain.handle(`auralink:${name}`, async (event, value) => {assertSender(event); return fn(value);}); }
function localAddresses() {
  return Object.entries(os.networkInterfaces()).flatMap(([name, list]) => list.filter(x => x.family === 'IPv4' && !x.internal && !x.address.startsWith('169.254.')).map(x=>({name,address:x.address}))).sort((a,b)=>Number(/virtual|vmware|vbox/i.test(a.name))-Number(/virtual|vmware|vbox/i.test(b.name)));
}
async function revoke() { grantGeneration++; if (gate) await gate.revoke(); }
function pinOrigin(origin, fp) { pins.set(new URL(origin).hostname, fp); }
function certificateDecision(request, callback) {
  callback(certificateDecisionForPin(pins.get(request.hostname),request.certificate.data,request.verificationResult));
}
function emergencyStop() {
  revoke().catch(()=>{});
  if (win && !win.isDestroyed()) win.webContents.send('auralink:emergency-stop');
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

app.whenReady().then(async () => {
  adapter = createAdapter({onError:emergencyStop});
  gate = new ControlGate(adapter,{onFailure:emergencyStop});
  session.defaultSession.setCertificateVerifyProc(certificateDecision);
  session.defaultSession.setPermissionRequestHandler(async (contents, permission, callback, details = {}) => {
    if (!trustedContent(contents,details) || !supportedPermission(permission)) return callback(false);
    try {
      // Browser consent alone cannot override the macOS TCC decision. Ask only
      // for the sensor requested by the local getUserMedia action.
      if (permission === 'media') {
        const types=details.mediaTypes || [];
        for (const type of types) {
          const mediaType=type === 'audio' ? 'microphone' : type === 'video' ? 'camera' : null;
          if (mediaType && !(await requestMedia(mediaType)).ok) return callback(false);
        }
      }
      callback(trustedContent(contents,details));
    } catch { callback(false); }
  });
  session.defaultSession.setPermissionCheckHandler((contents, permission, origin, details = {}) => Boolean(trustedContent(contents,details) && supportedPermission(permission)));
  session.defaultSession.setDisplayMediaRequestHandler(async (request, callback) => {
    if (!win || !request.frame || request.frame !== win.webContents.mainFrame || !selectedSource || Date.now()-selectedSource.at > 30000) return callback({});
    const chosen = selectedSource; selectedSource = null;
    try {
      const available = await desktopCapturer.getSources({types:['screen','window'],thumbnailSize:{width:0,height:0}});
      const source = available.find(s=>s.id===chosen.id);
      if (!source) return callback({});
      currentSource = source;
      callback({video:source});
    } catch {callback({});}
  });

  handle('host', async args => {
    await revoke();
    if (broker) await broker.stop();
    const name = String(args?.name || 'My room').trim().slice(0,48) || 'My room';
    const pems = await selfsigned.generate([{name:'commonName',value:'Auralink private room'}], {keyType:'ec',curve:'P-256',notAfterDate:new Date(Date.now()+30*86400000),algorithm:'sha256'});
    const certPin = fingerprint(pems.cert);
    const requestedPort=Number(args?.port || 0);
    if(!Number.isInteger(requestedPort)||requestedPort<0||requestedPort>65535||(requestedPort>0&&requestedPort<1024)) throw new Error('Choose a port between 1024 and 65535.');
    broker = await createBroker({name, port:requestedPort, tls:{key:pems.private,cert:pems.cert}, assetsDir:path.join(__dirname,'renderer')});
    const url = `https://127.0.0.1:${broker.port}`;
    pinOrigin(url, certPin);
    session.defaultSession.setCertificateVerifyProc(certificateDecision);
    const addresses = localAddresses();
    const invites = addresses.map(a=>({name:a.name,address:a.address,invite:`https://${a.address}:${broker.port}/#key=${broker.roomKey}&fp=${certPin}`}));
    const invite = invites[0]?.invite || `${url}/#key=${broker.roomKey}&fp=${certPin}`;
    return {name,url,roomKey:broker.roomKey,hostToken:broker.hostToken,port:broker.port,fingerprint:certPin,invite,invites};
  });
  handle('stop', async () => {await revoke(); currentSource=null; if(broker) {await broker.stop(); broker=null;} return {ok:true};});
  handle('trust-invite', async value => {
    const invite = parseInvite(value);
    await probeCertificate(invite.url, invite.fingerprint);
    pinOrigin(invite.url, invite.fingerprint);
    // Changing the verifier clears Chromium's certificate decision cache.
    session.defaultSession.setCertificateVerifyProc(certificateDecision);
    return invite;
  });
  handle('sources', async () => {
    const available = await desktopCapturer.getSources({types:['screen','window'],thumbnailSize:{width:320,height:180},fetchWindowIcons:false});
    if (process.platform === 'darwin' && permissionStatus('screen') !== 'granted') {
      throw new Error('Allow Auralink Screen & System Audio Recording in System Settings → Privacy & Security, then restart Auralink before sharing.');
    }
    sources.clear();
    for(const source of available) sources.set(source.id,source);
    return available.map(s=>({id:s.id,name:s.name,displayId:s.display_id,thumbnail:s.thumbnail.toDataURL(),canControl:s.id.startsWith('screen:')}));
  });
  handle('choose-screen', id => {
    if(typeof id!=='string'||!sources.has(id)) throw new Error('Select an available screen.');
    selectedSource={id,at:Date.now()}; return {ok:true};
  });
  handle('grant-control', async args => {
    if(testing) return {ok:false,reason:'Remote input is disabled in automated tests.'};
    if(!adapter.available) return {ok:false,reason:'Native input helper is unavailable on this platform.'};
    if(!currentSource || currentSource.id !== args?.screenId || !currentSource.id.startsWith('screen:')) return {ok:false,reason:'Share a full display before granting control.'};
    if(typeof args.peerId!=='string'||args.peerId.length>128||typeof args.sessionId!=='string'||! /^[A-Za-z0-9_-]{16,128}$/.test(args.sessionId)) return {ok:false,reason:'Invalid control request.'};
    const peerName=String(args.name || args.peerId).replace(/[\x00-\x1f]/g,'').slice(0,48);
    const approvedSource=currentSource;
    const approvalGeneration=grantGeneration;
    if(broker && !broker.isAcceptedPeer(args.peerId)) return {ok:false,reason:'Participant is no longer in this room.'};
    const result=await dialog.showMessageBox(win,{type:'warning',buttons:['Keep view only','Allow control'],defaultId:0,cancelId:0,title:'Approve remote control',message:`Allow ${peerName} to control the shared display?`,detail:'They can move your pointer and type into normal desktop apps. Only approve someone you trust. Stop instantly with Ctrl+Alt+Shift+Q (Command+Option+Shift+Q on Mac).'});
    if(result.response!==1) return {ok:false,reason:'Control was not approved.'};
    if(currentSource !== approvedSource || grantGeneration !== approvalGeneration) return {ok:false,reason:'Session changed while approval was open.'};
    if(broker && !broker.isAcceptedPeer(args.peerId)) return {ok:false,reason:'Participant disconnected during approval.'};
    if(process.platform === 'darwin' && !systemPreferences.isTrustedAccessibilityClient(true)) {
      return {ok:false,reason:'Enable Auralink in System Settings → Privacy & Security → Accessibility, then approve this request again. The Mac owner must grant this system permission.'};
    }
    const display=screen.getAllDisplays().find(d=>String(d.id)===currentSource.display_id);
    if(!display) return {ok:false,reason:'The shared display could not be matched to a native input surface.'};
    let bounds=display.bounds;
    if(process.platform==='win32') bounds=screen.dipToScreenRect(null,bounds);
    return await gate.grant({peerId:args.peerId,sessionId:args.sessionId,display:bounds});
  });
  handle('revoke-control',async()=>{await revoke(); return {ok:true};});
  handle('stop-sharing',async()=>{currentSource=null;selectedSource=null;await revoke();return {ok:true};});
  handle('input',args=>gate.apply(args));
  handle('copy',value=>{if(typeof value!=='string'||value.length>4096) throw new Error('Invalid clipboard value.');clipboard.writeText(value);return {ok:true};});
  handle('request-media',requestMedia);
  handle('permission-settings',async type=>{
    const url=typeof type==='string' && settingsLinks[process.platform]?.[type];
    if(!url) throw new Error('This permission settings page is unavailable on this platform.');
    await shell.openExternal(url);return {ok:true};
  });
  handle('info',()=>({version:app.getVersion(),platform:process.platform,hostname:os.hostname(),addresses:localAddresses(),nativeControl:Boolean(adapter.available),nativeSupports:adapter.supports,permissions:permissionInfo(),emergencyShortcut:process.platform==='darwin'?'Command+Option+Shift+Q':'Ctrl+Alt+Shift+Q',testing}));

  win=new BrowserWindow({width:1380,height:880,minWidth:900,minHeight:650,show:false,icon:path.join(__dirname,'..','build','icon.png'),backgroundColor:'#090e19',title:'Auralink',autoHideMenuBar:true,webPreferences:{preload:path.join(__dirname,'preload.cjs'),nodeIntegration:false,contextIsolation:true,sandbox:true,webSecurity:true,spellcheck:false}});
  win.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  win.webContents.on('will-navigate',event=>event.preventDefault());
  win.webContents.on('render-process-gone',emergencyStop);
  win.on('closed',()=>{emergencyStop();win=null;});
  win.once('ready-to-show',()=>win.show());
  await win.loadFile(path.join(__dirname,'renderer','index.html'));
  globalShortcut.register(process.platform==='darwin'?'Command+Alt+Shift+Q':'Control+Alt+Shift+Q',emergencyStop);
});
app.on('before-quit',()=>{if(gate)gate.revoke();if(adapter)adapter.dispose();if(broker)broker.stop();globalShortcut.unregisterAll();});
app.on('window-all-closed',()=>app.quit());
