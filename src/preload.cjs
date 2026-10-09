const {contextBridge, ipcRenderer} = require('electron');
const invoke = (name, args) => ipcRenderer.invoke(`auralink:${name}`, args);
contextBridge.exposeInMainWorld('auralink', {
  platform: process.platform,
  setSessionActive: active => invoke('session-active', active),
  setPresentationFullscreen: active => invoke('presentation-fullscreen', active),
  onPresentationFullscreenChanged: listener => {
    if (typeof listener !== 'function') return;
    const handler = (_event, state) => listener(state);
    ipcRenderer.on('auralink:presentation-fullscreen', handler);
    return () => ipcRenderer.removeListener('auralink:presentation-fullscreen', handler);
  },
  getPendingInvitation: () => invoke('pending-invitation'),
  onInvitation: listener => {
    if (typeof listener !== 'function') return;
    const handler = (_event, code) => listener(code);
    ipcRenderer.on('auralink:invitation', handler);
    return () => ipcRenderer.removeListener('auralink:invitation', handler);
  },
  hostRoom: args => invoke('host', args),
  stopRoom: () => invoke('stop'),
  trustInvite: invite => invoke('trust-invite', invite),
  trustInternetService: origin => invoke('trust-internet-service', origin),
  internetOpen: args => invoke('internet-open', args),
  internetSend: args => invoke('internet-send', args),
  internetClose: args => invoke('internet-close', args),
  onInternetEvent: listener => {
    if (typeof listener !== 'function') return;
    const handler = (_event, message) => listener(message);
    ipcRenderer.on('auralink:internet-event', handler);
    return () => ipcRenderer.removeListener('auralink:internet-event', handler);
  },
  sources: () => invoke('sources'),
  chooseScreen: id => invoke('choose-screen', id),
  prepareSystemAudio: () => invoke('prepare-system-audio'),
  cancelSystemAudio: token => invoke('cancel-system-audio', token),
  grantControl: args => invoke('grant-control', args),
  revokeControl: () => invoke('revoke-control'),
  stopSharing: () => invoke('stop-sharing'),
  applyInput: args => invoke('input', args),
  getInfo: () => invoke('info'),
  requestMedia: kind => invoke('request-media', kind),
  openPermissionSettings: kind => invoke('permission-settings', kind),
  copyText: value => invoke('copy', value),
  onEmergencyStop: listener => {
    if (typeof listener !== 'function') return;
    const handler = (_event, reason) => listener(reason);
    ipcRenderer.on('auralink:emergency-stop', handler);
    return () => ipcRenderer.removeListener('auralink:emergency-stop', handler);
  }
});
