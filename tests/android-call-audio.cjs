'use strict';

// Execute the production CallAudio lifecycle against controllable Android API
// doubles. This proves error handling and ownership, not physical sound output.
const fs = require('node:fs/promises');
const path = require('node:path');

async function runCallAudioHarness({ run, javac, java, fixtureDir, packageDir }) {
  const directory = path.join(fixtureDir, 'call-audio');
  const classes = path.join(directory, 'classes');
  const source = {
    'android/os/Build.java': `package android.os; public final class Build { public static final class VERSION { public static int SDK_INT = 36; } }`,
    'android/app/Activity.java': `package android.app;
      import android.media.AudioManager;
      public class Activity { public static final String AUDIO_SERVICE="audio"; public AudioManager manager = new AudioManager();
        public int volumeStream=3; public Object getSystemService(String ignored) { return manager; }
        public int getVolumeControlStream() { return volumeStream; } public void setVolumeControlStream(int stream) { volumeStream=stream; } }`,
    'android/media/AudioAttributes.java': `package android.media;
      public class AudioAttributes { public static final int USAGE_VOICE_COMMUNICATION=2,CONTENT_TYPE_SPEECH=1;
        public static class Builder { public Builder setUsage(int ignored){return this;} public Builder setContentType(int ignored){return this;} public AudioAttributes build(){return new AudioAttributes();} } }`,
    'android/media/AudioFocusRequest.java': `package android.media;
      public class AudioFocusRequest { public AudioManager.OnAudioFocusChangeListener listener;
        public static class Builder { private AudioFocusRequest request=new AudioFocusRequest(); public Builder(int gain){}
          public Builder setAudioAttributes(AudioAttributes ignored){return this;} public Builder setWillPauseWhenDucked(boolean ignored){return this;}
          public Builder setOnAudioFocusChangeListener(AudioManager.OnAudioFocusChangeListener listener){request.listener=listener;return this;}
          public AudioFocusRequest build(){return request;} } }`,
    'android/media/AudioDeviceInfo.java': `package android.media;
      public class AudioDeviceInfo { public static final int TYPE_BUILTIN_EARPIECE=1,TYPE_BUILTIN_SPEAKER=2;
        private int type; public AudioDeviceInfo(int value){type=value;} public int getType(){return type;} }`,
    'android/media/AudioManager.java': `package android.media;
      import java.util.*;
      public class AudioManager { public static final int AUDIOFOCUS_GAIN=1,AUDIOFOCUS_LOSS=-1,AUDIOFOCUS_LOSS_TRANSIENT=-2,
          AUDIOFOCUS_REQUEST_GRANTED=1,MODE_NORMAL=0,MODE_IN_COMMUNICATION=3,STREAM_VOICE_CALL=0,STREAM_MUSIC=3;
        public interface OnAudioFocusChangeListener {void onAudioFocusChange(int change);}
        public int mode=MODE_NORMAL,focusResult=AUDIOFOCUS_REQUEST_GRANTED,requests,abandons,routeCalls;
        public boolean speaker,routeAccepted=true,throwMode,throwClear; public AudioDeviceInfo selected;
        public AudioFocusRequest focus;
        public List<AudioDeviceInfo> devices=new ArrayList<AudioDeviceInfo>(Arrays.asList(new AudioDeviceInfo(1),new AudioDeviceInfo(2)));
        public int getMode(){return mode;} public void setMode(int next){if(throwMode)throw new SecurityException("test audio route denied");mode=next;}
        public int requestAudioFocus(AudioFocusRequest request){requests++;focus=request;return focusResult;}
        public void abandonAudioFocusRequest(AudioFocusRequest request){abandons++;}
        public List<AudioDeviceInfo> getAvailableCommunicationDevices(){return devices;}
        public AudioDeviceInfo getCommunicationDevice(){return selected;}
        public boolean setCommunicationDevice(AudioDeviceInfo device){routeCalls++;if(routeAccepted){selected=device;return true;}return false;}
        public void clearCommunicationDevice(){if(throwClear)throw new SecurityException("test restore denied");selected=null;}
        public void setSpeakerphoneOn(boolean next){speaker=next;} public boolean isSpeakerphoneOn(){return speaker;}
        public void changeFocus(int change){focus.listener.onAudioFocusChange(change);} }`,
    'local/auralink/mobile/AndroidCallAudioHarness.java': `package local.auralink.mobile;
      import android.app.Activity; import android.media.*; import android.os.Build; import java.util.*;
      public class AndroidCallAudioHarness {
        static int checks; static void check(boolean ok,String reason){if(!ok)throw new AssertionError(reason);checks++;}
        public static void main(String[] args) {
          Activity idle=new Activity(); CallAudio idleAudio=new CallAudio(idle,null);
          check(idleAudio.resume() && idle.manager.requests==0,"Idle return cannot claim audio focus");

          Activity owner=new Activity(); AudioManager manager=owner.manager;
          AudioDeviceInfo previous=new AudioDeviceInfo(22);manager.selected=previous;manager.mode=1;owner.volumeStream=4;
          CallAudio audio=new CallAudio(owner,null);
          check(audio.update(true,true),"Speaker call starts");
          check(manager.selected.getType()==2 && manager.mode==3 && owner.volumeStream==0,"Requested speaker and call volume route are applied");
          check(audio.update(true,false) && manager.selected.getType()==1,"Earpiece selection chooses the actual earpiece");
          audio.stop();check(manager.selected==previous && manager.mode==1 && owner.volumeStream==4 && manager.abandons==1,"Stop restores prior device mode volume and releases focus");
          audio.stop();check(manager.abandons==1,"Repeated stop is harmless");

          Activity denied=new Activity();denied.manager.focusResult=0;CallAudio deniedAudio=new CallAudio(denied,null);
          check(!deniedAudio.update(true,true) && denied.manager.mode==0 && denied.manager.routeCalls==0,"Denied focus cannot change the route or audio mode");
          check(deniedAudio.lastError().contains("focus"),"Denied focus has actionable error");

          Activity refused=new Activity();refused.manager.routeAccepted=false;CallAudio refusedAudio=new CallAudio(refused,null);
          check(!refusedAudio.update(true,true),"A refused communication device cannot report success");
          check(refused.manager.abandons==1 && refused.manager.mode==0 && refused.volumeStream==3,"Refused route unwinds owned focus mode and volume");
          Activity absent=new Activity();absent.manager.devices.clear();CallAudio absentAudio=new CallAudio(absent,null);
          check(!absentAudio.update(true,true),"Missing speaker does not silently enable a call");
          check(absentAudio.update(true,false),"A device without an earpiece can use its normal output");absentAudio.stop();

          List<String> notices=new ArrayList<String>();Activity paused=new Activity();CallAudio pausedAudio=new CallAudio(paused,notices::add);
          check(pausedAudio.update(true,true),"Focus callback fixture starts");paused.manager.changeFocus(-2);
          int requestCount=paused.manager.requests;check(pausedAudio.resume() && paused.manager.requests==requestCount,"Transient focus loss does not steal another app's focus on return");
          paused.manager.selected=null;paused.manager.mode=0;paused.manager.changeFocus(1);
          check(paused.manager.mode==3 && paused.manager.selected.getType()==2 && notices.isEmpty(),"Regained focus reapplies a valid speaker route");
          paused.manager.throwMode=true;paused.manager.changeFocus(1);
          check(notices.size()==1 && paused.manager.abandons==1,"An OEM exception during focus gain is contained and releases focus");
          requestCount=paused.manager.requests;check(pausedAudio.resume() && paused.manager.requests==requestCount,"Failed callback cannot restart audio on return");

          Activity lost=new Activity();CallAudio lostAudio=new CallAudio(lost,notices::add);check(lostAudio.update(true,true),"Permanent focus fixture starts");
          lost.manager.changeFocus(-1);requestCount=lost.manager.requests;
          check(lostAudio.resume() && lost.manager.requests==requestCount && notices.size()==1,"Focus handed to WebView cannot terminate capture or steal focus on return");lostAudio.stop();

          Activity brokenRestore=new Activity();CallAudio brokenAudio=new CallAudio(brokenRestore,null);check(brokenAudio.update(true,true),"Restore exception fixture starts");
          brokenRestore.manager.throwClear=true;brokenAudio.stop();check(brokenRestore.manager.abandons==1 && brokenRestore.manager.mode==0,"Route restore exception cannot prevent focus and mode cleanup");

          Build.VERSION.SDK_INT=29;Activity legacy=new Activity();legacy.manager.speaker=true;CallAudio legacyAudio=new CallAudio(legacy,null);
          check(legacyAudio.update(true,false) && !legacy.manager.speaker,"Legacy earpiece routing is applied");legacyAudio.stop();
          check(legacy.manager.speaker && legacy.manager.mode==0,"Legacy stop restores previous speaker state");
          System.out.println("Production CallAudio: "+checks+" assertions passed; Android API doubles, no hardware sound claim.");
        }
      }`,
  };
  const files = [];
  await fs.mkdir(classes, { recursive: true });
  for (const [name, value] of Object.entries(source)) {
    const file = path.join(directory, name); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, value); files.push(file);
  }
  await run(javac, ['--release', '8', '-d', classes, ...files, path.join(packageDir, 'CallAudio.java')]);
  const result = await run(java, ['-cp', classes, 'local.auralink.mobile.AndroidCallAudioHarness']);
  return { passed: true, productionClass: 'CallAudio.java', result: result.stdout, hardwareOutputVerified: false, platform: 'Controllable Android API doubles in JVM' };
}

module.exports = { runCallAudioHarness };
