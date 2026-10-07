package local.auralink.mobile;

import android.accessibilityservice.AccessibilityService;
import android.accessibilityservice.GestureDescription;
import android.app.KeyguardManager;
import android.graphics.Color;
import android.graphics.Path;
import android.graphics.Rect;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.view.Gravity;
import android.view.WindowManager;
import android.view.accessibility.AccessibilityEvent;
import android.view.accessibility.AccessibilityNodeInfo;
import android.widget.Button;
import org.json.JSONObject;
import java.util.HashSet;
import java.util.Set;

/** Enabled by the owner in Android Settings, then separately approved for each room session. */
public final class AttendedAccessibilityService extends AccessibilityService {
    interface StopListener { void stopped(String reason); }
    private static AttendedAccessibilityService instance;
    private final AttendedControlPolicy policy = new AttendedControlPolicy();
    private final Handler main = new Handler(Looper.getMainLooper());
    private final Set<String> keys = new HashSet<>();
    private StopListener listener;
    private Button stopButton;
    private WindowManager windows;
    private Path pointer;
    private float pointerX, pointerY;
    private long pointerStarted;
    private boolean dragMoved;
    private int pointerPoints;
    private boolean gestureBusy;
    private long gestureGeneration;
    private Path queuedGesture;
    private long queuedDuration;
    private final Runnable expiry = () -> revoke("Control approval expired. Approve a new request to continue.");

    static AttendedAccessibilityService current() { return instance; }
    @Override protected void onServiceConnected() { instance = this; windows = (WindowManager)getSystemService(WINDOW_SERVICE); }
    @Override public void onAccessibilityEvent(AccessibilityEvent event) { /* No event history, screen text or usage logs are collected. */ }
    @Override public void onInterrupt() { revoke("Android interrupted device control."); }
    @Override public void onDestroy() { revoke("Accessibility service was disabled."); if (instance == this) instance = null; super.onDestroy(); }

    boolean grant(String peerId, String sessionId, String name, StopListener callback) {
        revoke("A new controller was selected.");
        if (locked() || !ScreenShareService.activeFullDisplay() || !policy.grant(peerId, sessionId, SystemClock.elapsedRealtime())) return false;
        listener = callback;
        stopButton = new Button(this); stopButton.setText("Stop control"); stopButton.setTextColor(Color.WHITE); stopButton.setBackgroundColor(0xffb52d56);
        stopButton.setContentDescription("Stop remote control immediately"); stopButton.setOnClickListener(view -> revoke("Stopped on the phone."));
        WindowManager.LayoutParams params = new WindowManager.LayoutParams(-2, -2, WindowManager.LayoutParams.TYPE_ACCESSIBILITY_OVERLAY,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE | WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL, android.graphics.PixelFormat.TRANSLUCENT);
        params.gravity = Gravity.TOP | Gravity.END; params.y = getResources().getDimensionPixelSize(android.R.dimen.app_icon_size);
        try { windows.addView(stopButton, params); }
        catch (Exception failure) { revoke("Android could not show the emergency stop button."); return false; }
        main.postDelayed(expiry, AttendedControlPolicy.DURATION_MS); return true;
    }
    boolean confirm(String peerId, String sessionId) { return policy.confirm(peerId, sessionId); }
    boolean matches(String peerId, String sessionId) { return policy.matches(peerId, sessionId); }
    boolean active() { return policy.active(SystemClock.elapsedRealtime()); }
    boolean confirmed() { return policy.confirmed(); }
    String controller() { return policy.peerId(); }
    void revoke(String reason) {
        boolean wasActive = policy.peerId() != null;
        policy.revoke(); gestureGeneration++; main.removeCallbacks(expiry); keys.clear(); pointer = null; dragMoved = false; queuedGesture = null;
        if (stopButton != null) { try { windows.removeView(stopButton); } catch (Exception ignored) { } stopButton = null; }
        StopListener previous = listener; listener = null;
        if (wasActive && previous != null) previous.stopped(reason);
    }
    private boolean locked() { return ((KeyguardManager)getSystemService(KEYGUARD_SERVICE)).isDeviceLocked(); }
    private Rect displayBounds() {
        if (Build.VERSION.SDK_INT >= 30) return windows.getMaximumWindowMetrics().getBounds();
        android.util.DisplayMetrics metrics = new android.util.DisplayMetrics(); windows.getDefaultDisplay().getRealMetrics(metrics);
        return new Rect(0, 0, metrics.widthPixels, metrics.heightPixels);
    }
    private boolean finite(double number) { return !Double.isNaN(number) && !Double.isInfinite(number); }
    boolean apply(String peerId, String sessionId, JSONObject event) {
        if (locked() || !ScreenShareService.activeFullDisplay()) { revoke("Phone sharing stopped or the screen was locked."); return false; }
        String type = event.optString("type", "");
        if (!AttendedControlPolicy.validSequence(event.opt("seq"))) return false;
        long seq = ((Number)event.opt("seq")).longValue();
        // Validate payloads before consuming their sequence or authorization budget.
        if ("move".equals(type) || "down".equals(type) || "up".equals(type)) {
            double x = event.optDouble("x", Double.NaN), y = event.optDouble("y", Double.NaN);
            if (!(event.opt("x") instanceof Number) || !(event.opt("y") instanceof Number)) return false;
            if (!finite(x) || !finite(y) || Math.abs(x) > 1000000 || Math.abs(y) > 1000000) return false;
            if (!"move".equals(type) && (!(event.opt("button") instanceof Number) || event.optDouble("button", -1) != 0)) return false;
            if ("down".equals(type) && pointer != null || "up".equals(type) && pointer == null) return false;
            if (pointer != null && (SystemClock.elapsedRealtime() - pointerStarted > 15000 || pointerPoints > 600)) { revoke("Remote drag exceeded its safety limit."); return false; }
        } else if ("wheel".equals(type)) {
            double x = event.optDouble("deltaX", 0), y = event.optDouble("deltaY", 0);
            if (event.has("deltaX") && !(event.opt("deltaX") instanceof Number) || event.has("deltaY") && !(event.opt("deltaY") instanceof Number)) return false;
            if (!finite(x) || !finite(y) || Math.abs(x) > 1200 || Math.abs(y) > 1200 || pointer != null) return false;
        } else if ("keydown".equals(type) || "keyup".equals(type)) {
            String code = event.optString("code", "");
            if (!supportedKey(code) || ("keyup".equals(type) && !keys.contains(code))) return false;
        } else return false;
        if (!policy.accepts(peerId, sessionId, seq, type, SystemClock.elapsedRealtime())) return false;
        Rect bounds = displayBounds();
        if ("move".equals(type) || "down".equals(type) || "up".equals(type)) {
            float x = (float)(Math.max(0, Math.min(1, event.optDouble("x"))) * (bounds.width() - 1));
            float y = (float)(Math.max(0, Math.min(1, event.optDouble("y"))) * (bounds.height() - 1));
            if ("down".equals(type)) { pointer = new Path(); pointer.moveTo(x, y); pointerX = x; pointerY = y; pointerStarted = SystemClock.elapsedRealtime(); dragMoved = false; pointerPoints = 1; return true; }
            if (pointer != null && Math.hypot(x - pointerX, y - pointerY) > 2) { pointer.lineTo(x, y); pointerX = x; pointerY = y; dragMoved = true; pointerPoints++; }
            if ("up".equals(type)) {
                Path path = pointer; pointer = null;
                long duration = Math.min(500, Math.max(dragMoved ? 100 : 50, SystemClock.elapsedRealtime() - pointerStarted));
                return gesture(path, duration);
            }
            return true;
        }
        if ("wheel".equals(type)) {
            float dx = (float)event.optDouble("deltaX", 0), dy = (float)event.optDouble("deltaY", 0);
            if (dx == 0 && dy == 0) return true;
            float fromX = bounds.width() * 0.5f, fromY = bounds.height() * 0.6f;
            Path path = new Path(); path.moveTo(fromX, fromY);
            path.lineTo(Math.max(bounds.width() * 0.1f, Math.min(bounds.width() * 0.9f, fromX - dx)),
                Math.max(bounds.height() * 0.15f, Math.min(bounds.height() * 0.85f, fromY - dy)));
            return gesture(path, 180);
        }
        String code = event.optString("code", "");
        if ("keyup".equals(type)) { keys.remove(code); return true; }
        keys.add(code);
        if (code.startsWith("Shift")) return true;
        if ("Escape".equals(code)) return performGlobalAction(GLOBAL_ACTION_BACK);
        if ("Home".equals(code)) return performGlobalAction(GLOBAL_ACTION_HOME);
        return edit(code);
    }
    private boolean gesture(Path path, long duration) {
        if (gestureBusy) { queuedGesture = path; queuedDuration = duration; return true; }
        gestureBusy = true;
        final long dispatchGeneration = gestureGeneration;
        boolean sent = dispatchGesture(new GestureDescription.Builder().addStroke(new GestureDescription.StrokeDescription(path, 0, duration)).build(), new GestureResultCallback() {
            @Override public void onCompleted(GestureDescription gesture) {
                gestureBusy = false;
                if (queuedGesture != null && active() && confirmed() && ScreenShareService.activeFullDisplay() && !locked()) {
                    Path next = queuedGesture; long time = queuedDuration; queuedGesture = null; gesture(next, time);
                } else queuedGesture = null;
            }
            @Override public void onCancelled(GestureDescription gesture) {
                gestureBusy = false; queuedGesture = null;
                if (dispatchGeneration == gestureGeneration && active()) revoke("Phone interaction interrupted the remote gesture. Approve again to continue.");
            }
        }, main);
        if (!sent) gestureBusy = false;
        return sent;
    }
    private boolean supportedKey(String code) {
        return code.matches("Key[A-Z]|Digit[0-9]") || code.matches("ShiftLeft|ShiftRight|Space|Backspace|Delete|Enter|ArrowLeft|ArrowRight|Escape|Home|End|Minus|Equal|BracketLeft|BracketRight|Backslash|Semicolon|Quote|Comma|Period|Slash|Backquote");
    }
    private String ascii(String code) {
        boolean shift = keys.contains("ShiftLeft") || keys.contains("ShiftRight");
        if (code.startsWith("Key")) return shift ? code.substring(3) : code.substring(3).toLowerCase(java.util.Locale.ROOT);
        if (code.startsWith("Digit")) { int digit = code.charAt(5) - '0'; return String.valueOf(shift ? ")!@#$%^&*(".charAt(digit) : code.charAt(5)); }
        String[] names = {"Space", "Minus", "Equal", "BracketLeft", "BracketRight", "Backslash", "Semicolon", "Quote", "Comma", "Period", "Slash", "Backquote"};
        String plain = " -=[]\\;',./`", shifted = " _+{}|:\"<>?~";
        for (int index = 0; index < names.length; index++) if (names[index].equals(code)) return String.valueOf((shift ? shifted : plain).charAt(index));
        return "";
    }
    private boolean edit(String code) {
        AccessibilityNodeInfo node = findFocus(AccessibilityNodeInfo.FOCUS_INPUT);
        if (node == null) return false;
        try {
            if (!node.isEditable() || node.isPassword() || !node.isEnabled()) return false;
            String value = node.getText() == null ? "" : node.getText().toString(); if (value.length() > 16000) return false;
            int start = Math.max(0, Math.min(value.length(), node.getTextSelectionStart()));
            int end = Math.max(start, Math.min(value.length(), node.getTextSelectionEnd()));
            if (node.getTextSelectionStart() < 0) start = end = value.length();
            if ("ArrowLeft".equals(code) || "ArrowRight".equals(code) || "End".equals(code)) {
                int cursor = "End".equals(code) ? value.length() : "ArrowLeft".equals(code) ? Math.max(0, start - 1) : Math.min(value.length(), end + 1);
                Bundle selection = new Bundle(); selection.putInt(AccessibilityNodeInfo.ACTION_ARGUMENT_SELECTION_START_INT, cursor); selection.putInt(AccessibilityNodeInfo.ACTION_ARGUMENT_SELECTION_END_INT, cursor);
                return node.performAction(AccessibilityNodeInfo.ACTION_SET_SELECTION, selection);
            }
            String text = ascii(code);
            if ("Backspace".equals(code)) { if (start == end && start > 0) start = value.offsetByCodePoints(start, -1); }
            else if ("Delete".equals(code)) { if (start == end && end < value.length()) end = value.offsetByCodePoints(end, 1); }
            else if ("Enter".equals(code)) {
                if (!node.isMultiLine()) return Build.VERSION.SDK_INT >= 30 && node.performAction(AccessibilityNodeInfo.AccessibilityAction.ACTION_IME_ENTER.getId());
                text = "\n";
            } else if (text.isEmpty()) return false;
            if (value.length() - (end - start) + text.length() > 16000) return false;
            Bundle arguments = new Bundle(); arguments.putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, value.substring(0, start) + text + value.substring(end));
            if (!node.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, arguments)) return false;
            Bundle selection = new Bundle(); selection.putInt(AccessibilityNodeInfo.ACTION_ARGUMENT_SELECTION_START_INT, start + text.length()); selection.putInt(AccessibilityNodeInfo.ACTION_ARGUMENT_SELECTION_END_INT, start + text.length());
            node.performAction(AccessibilityNodeInfo.ACTION_SET_SELECTION, selection); return true;
        } finally { node.recycle(); }
    }
}
