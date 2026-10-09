package local.auralink.mobile;

import android.app.Activity;
import android.content.Intent;
import android.os.Bundle;

/** The replaceable Android window; media and transport belong to AndroidRoomSession. */
public final class MainActivity extends Activity {
    private AndroidRoomSession session;
    @Override public void onCreate(Bundle saved) {
        super.onCreate(saved);
        session = AndroidRoomSession.acquire(getApplicationContext());
        session.attach(this, saved);
    }
    @Override protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent); setIntent(intent); if (session != null) session.invitation(intent);
    }
    @Override protected void onSaveInstanceState(Bundle saved) {
        super.onSaveInstanceState(saved); if (session != null) session.saveState(saved);
    }
    @Override protected void onActivityResult(int code, int result, Intent data) {
        super.onActivityResult(code, result, data); if (session != null) session.activityResult(code, result, data);
    }
    @Override public void onRequestPermissionsResult(int code, String[] permissions, int[] results) {
        super.onRequestPermissionsResult(code, permissions, results); if (session != null) session.permissionsResult(code, permissions, results);
    }
    @Override protected void onPause() { if (session != null) session.pause(); super.onPause(); }
    @Override protected void onResume() { super.onResume(); if (session != null) session.resume(); }
    @Override public void onWindowFocusChanged(boolean focused) { super.onWindowFocusChanged(focused); if (session != null) session.windowFocused(focused); }
    @Override public void onBackPressed() { if (session == null || !session.back()) super.onBackPressed(); }
    @Override protected void onDestroy() {
        if (session != null) session.detach(this, isFinishing()); session = null; super.onDestroy();
    }
}
