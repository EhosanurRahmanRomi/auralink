package local.auralink.mobile;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.net.http.SslError;
import android.os.Bundle;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.media.projection.MediaProjectionManager;
import android.media.projection.MediaProjectionConfig;
import android.content.pm.ServiceInfo;
import android.provider.Settings;
import android.view.View;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.SslErrorHandler;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.ByteArrayInputStream;
import java.net.URL;
import java.security.cert.X509Certificate;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashSet;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import javax.net.ssl.HttpsURLConnection;

/** Pinned local room client with explicitly attended Android screen sharing and control. */
public final class MainActivity extends Activity {
    private static final String PAGE = "https://appassets.androidplatform.net/assets/index.html";
    private static final String HOST = "appassets.androidplatform.net";
    private static final Set<String> ASSETS = new HashSet<>(Arrays.asList("index.html", "styles.css", "app.js", "rtc.js", "android-bridge.js"));
    private final ExecutorService workers = Executors.newSingleThreadExecutor();
    private WebView webView;
    private FrameLayout root;
    private View fullscreen;
    private WebChromeClient.CustomViewCallback fullscreenCallback;
    private volatile boolean foreground, destroyed;
    private long generation = 0;
    private Invitation invitation;
    private PinnedRoomClient socket;
    private String socketId;
    private PermissionRequest mediaRequest;
    private long mediaGeneration;
    private boolean runtimePermissionsPending, permissionResultDeferred;
    private final java.util.ArrayDeque<Runnable> pausedEvents = new java.util.ArrayDeque<>();
    private final Handler main = new Handler(Looper.getMainLooper());
    private final Set<String> approvedPeers = new HashSet<>();
    private String selfId, projectionRequest;
    private long projectionGeneration, controlGeneration;
    private boolean projectionPermissionPending, projectionStarting;
    private JSONObject projectionOptions;
    private Intent deferredProjectionConsent;
    private boolean deferredProjectionResult;
    private int deferredProjectionCode;
    private CallAudio callAudio;
    private AlertDialog controlDialog;
    private final Runnable projectionDeadline = () -> {
        if (projectionRequest != null) { String id = projectionRequest; clearProjectionRequest(); reject(id, "Android screen permission timed out. Try sharing again."); ScreenShareService.stopCurrent("Screen permission timed out."); if (!foreground) stopSession(); }
    };

    @Override public void onCreate(Bundle saved) {
        super.onCreate(saved);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        root = new FrameLayout(this); webView = new WebView(this);
        root.addView(webView, new FrameLayout.LayoutParams(-1, -1)); setContentView(root);
        callAudio = new CallAudio(this);
        // Android 15/16 enforce edge-to-edge. Reserve system bars and the keyboard
        // in native pixels so the mobile controls remain reachable on real phones.
        root.setOnApplyWindowInsetsListener((view, insets) -> {
            if (Build.VERSION.SDK_INT >= 30) {
                android.graphics.Insets safe = insets.getInsets(android.view.WindowInsets.Type.systemBars() | android.view.WindowInsets.Type.displayCutout() | android.view.WindowInsets.Type.ime());
                view.setPadding(safe.left, safe.top, safe.right, safe.bottom);
            } else view.setPadding(insets.getSystemWindowInsetLeft(), insets.getSystemWindowInsetTop(), insets.getSystemWindowInsetRight(), insets.getSystemWindowInsetBottom());
            return insets;
        });
        root.requestApplyInsets();
        WebView.setWebContentsDebuggingEnabled(false);
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true); settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(false); settings.setAllowContentAccess(false);
        settings.setAllowFileAccessFromFileURLs(false); settings.setAllowUniversalAccessFromFileURLs(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setMediaPlaybackRequiresUserGesture(true); settings.setSafeBrowsingEnabled(true);
        settings.setSupportMultipleWindows(false); settings.setJavaScriptCanOpenWindowsAutomatically(false);
        webView.setBackgroundColor(0xff0b111a);
        webView.addJavascriptInterface(new NativeBridge(), "AuralinkNative");
        webView.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) { return !PAGE.equals(request.getUrl().toString().split("#", 2)[0]); }
            @Override public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError error) { handler.cancel(); }
            @Override public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl(); String path = uri.getPath();
                if (!"GET".equals(request.getMethod()) || !"https".equals(uri.getScheme()) || !HOST.equals(uri.getHost()) ||
                    uri.getPort() != -1 || uri.getQuery() != null || path == null || !path.startsWith("/assets/")) return blocked();
                String name = path.substring(8);
                if (!ASSETS.contains(name)) return blocked();
                try {
                    String mime = name.endsWith(".js") ? "application/javascript" : name.endsWith(".css") ? "text/css" : "text/html";
                    WebResourceResponse result = new WebResourceResponse(mime, "UTF-8", getAssets().open("renderer/" + name));
                    java.util.Map<String,String> headers = new java.util.HashMap<>();
                    headers.put("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; media-src 'self' blob:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'");
                    headers.put("X-Content-Type-Options", "nosniff"); result.setResponseHeaders(headers); return result;
                } catch (Exception failure) { return blocked(); }
            }
        });
        webView.setWebChromeClient(new WebChromeClient() {
            @Override public void onPermissionRequest(PermissionRequest request) { runOnUiThread(() -> requestMedia(request)); }
            @Override public void onPermissionRequestCanceled(PermissionRequest request) { runOnUiThread(() -> { if (mediaRequest == request) mediaRequest = null; }); }
            @Override public void onShowCustomView(View view, CustomViewCallback callback) {
                if (fullscreen != null || !trustedPage()) { callback.onCustomViewHidden(); return; }
                fullscreen = view; fullscreenCallback = callback; root.addView(view, new FrameLayout.LayoutParams(-1, -1)); webView.setVisibility(View.INVISIBLE);
            }
            @Override public void onHideCustomView() { exitFullscreen(); }
        });
        foreground = true; webView.loadUrl(PAGE);
    }
    private WebResourceResponse blocked() {
        return new WebResourceResponse("text/plain", "UTF-8", 403, "Blocked", java.util.Collections.emptyMap(), new ByteArrayInputStream(new byte[0]));
    }
    private boolean localDocument() { return !destroyed && webView != null && PAGE.equals(webView.getUrl() == null ? "" : webView.getUrl().split("#", 2)[0]); }
    private boolean trustedPage() { return foreground && localDocument(); }
    private boolean projectionSession() { return localDocument() && (ScreenShareService.active() || projectionStarting); }
    private boolean transportPage() { return trustedPage() || ownPermissionPause() || projectionSession(); }
    private boolean ownPermissionPause() {
        return !foreground && !destroyed && ((runtimePermissionsPending && mediaRequest != null) || projectionPermissionPending) &&
            webView != null && PAGE.equals(webView.getUrl());
    }
    private final class NativeBridge {
        @JavascriptInterface public void postMessage(String value) {
            if (value == null || value.length() > 70000) return;
            runOnUiThread(() -> dispatch(value));
        }
    }
    private JSONObject json(Object... values) {
        JSONObject result = new JSONObject(); try { for (int i=0; i<values.length; i+=2) result.put(String.valueOf(values[i]), values[i+1]); } catch (Exception ignored) { }
        return result;
    }
    private void deliver(JSONObject value) {
        if (!transportPage()) return;
        webView.evaluateJavascript("window.__auralinkNativeReceive && window.__auralinkNativeReceive(" + JSONObject.quote(value.toString()) + ")", null);
    }
    private void reply(String id, Object result) { deliver(json("requestId", id, "ok", true, "result", result)); }
    private void reject(String id, String error) { deliver(json("requestId", id, "ok", false, "error", error)); }
    private void dispatch(String value) {
        if (!trustedPage()) {
            // Keep only already-scoped signaling writes and their responses
            // during our own OS permission dialog. This prevents RPC timeout
            // while the user reads the prompt; native capture grants still
            // require foreground return. No new invitation/socket is allowed.
            if (ownPermissionPause() || projectionSession()) {
                try {
                    String method = new JSONObject(value).getString("method");
                    if (!"sendSocket".equals(method) && !"closeSocket".equals(method) && !"ackScreenFrame".equals(method) &&
                        !"applyInput".equals(method) && !"revokeControl".equals(method) && !"stopScreenShare".equals(method)) return;
                } catch (Exception ignored) { return; }
            } else return;
        }
        String id = "";
        try {
            JSONObject request = new JSONObject(value); id = request.getString("requestId");
            if (!id.matches("r[0-9]{1,16}")) return;
            String method = request.getString("method"); Object args = request.opt("args");
            if ("getInfo".equals(method)) {
                boolean enabled = AttendedAccessibilityService.current() != null;
                reply(id, json("platform", "android", "version", "0.2.0", "nativeControl", true,
                    "supports", new JSONArray(Arrays.asList("tap", "swipe", "wheel", "editable-text", "back", "home")), "accessibilityEnabled", enabled,
                    "capabilities", json("hostRoom", false, "screenShare", true, "remoteInputHost", true, "accessibilityEnabled", enabled, "screenMaxEdge", 1920, "screenMaxFps", 12)));
            } else if ("startScreenShare".equals(method)) {
                startProjection(id, args instanceof JSONObject ? (JSONObject)args : new JSONObject());
            } else if ("stopScreenShare".equals(method)) {
                reply(id, json("ok", true)); clearProjectionRequest(); ScreenShareService.stopCurrent("Stopped in Auralink."); revokeControl("Screen sharing stopped.");
            } else if ("ackScreenFrame".equals(method)) {
                ScreenShareService.acknowledge(((JSONObject)args).getLong("seq")); reply(id, json("ok", true));
            } else if ("grantControl".equals(method)) {
                grantControl(id, (JSONObject)args);
            } else if ("revokeControl".equals(method)) {
                revokeControl("Permission revoked in Auralink."); reply(id, json("ok", true));
            } else if ("applyInput".equals(method)) {
                JSONObject input = (JSONObject)args; AttendedAccessibilityService service = AttendedAccessibilityService.current();
                boolean ok = service != null && service.apply(input.getString("peerId"), input.getString("sessionId"), input.getJSONObject("event"));
                reply(id, json("ok", ok, "reason", ok ? "" : "Phone input was not approved, unsupported, or unavailable in this app."));
            } else if ("inputStatus".equals(method)) {
                AttendedAccessibilityService service = AttendedAccessibilityService.current();
                reply(id, json("available", service != null, "active", service != null && service.active(), "peerId", service == null || service.controller() == null ? JSONObject.NULL : service.controller()));
            } else if ("setAudioRoute".equals(method)) {
                JSONObject route = args instanceof JSONObject ? (JSONObject)args : new JSONObject();
                boolean ok = callAudio.update(route.optBoolean("active", true), route.optBoolean("speaker", true));
                reply(id, json("ok", ok, "speaker", route.optBoolean("speaker", true), "reason", ok ? "" : "Android audio focus is busy. Retry after the other call ends."));
            } else if ("copyText".equals(method)) {
                if (!(args instanceof String) || ((String)args).length() > 4096) throw new IllegalArgumentException("Invalid clipboard text.");
                ((ClipboardManager)getSystemService(CLIPBOARD_SERVICE)).setPrimaryClip(ClipData.newPlainText("Auralink", (String)args)); reply(id, json("ok", true));
            } else if ("trustInvite".equals(method)) {
                if (!(args instanceof String)) throw new IllegalArgumentException("Invalid invitation.");
                final Invitation candidate = Invitation.parse((String)args);
                if (socket != null) throw new IllegalArgumentException("Leave your room before checking another invitation.");
                final long serial = ++generation; invitation = null; final String requestId = id;
                workers.execute(() -> {
                    try {
                        HttpsURLConnection connection = (HttpsURLConnection)new URL(candidate.origin + "/health").openConnection();
                        connection.setSSLSocketFactory(PinnedTls.context(candidate).getSocketFactory());
                        connection.setHostnameVerifier((name, session) -> {
                            try { PinnedTls.verifyCertificate((X509Certificate)session.getPeerCertificates()[0], candidate.fingerprint); return candidate.matchesHost(name); }
                            catch (Exception denied) { return false; }
                        });
                        connection.setConnectTimeout(7000); connection.setReadTimeout(7000); connection.setInstanceFollowRedirects(false);
                        try { if (connection.getResponseCode() != 200) throw new IllegalArgumentException("Host did not return a room response."); }
                        finally { connection.disconnect(); }
                        runOnUiThread(() -> {
                            if (!trustedPage() || generation != serial) return;
                            invitation = candidate; reply(requestId, json("url", candidate.origin, "roomKey", candidate.roomKey, "fingerprint", candidate.fingerprint));
                        });
                    } catch (Exception failure) { runOnUiThread(() -> { if (generation == serial) reject(requestId, "Could not verify the host. Check the full invitation and Wi-Fi connection."); }); }
                });
            } else if ("openSocket".equals(method)) {
                JSONObject options = (JSONObject)args; String nextId = options.getString("socketId");
                if (!nextId.matches("socket-[0-9]{1,16}") || invitation == null || socket != null || !invitation.matchesSocket(options.getString("url")))
                    throw new IllegalArgumentException("Socket address is not the verified invitation.");
                final long serial = generation; final String activeId = nextId;
                PinnedRoomClient client = new PinnedRoomClient(invitation, new PinnedRoomClient.Listener() {
                    public void opened() { event(serial, activeId, "open", null, 0, null); }
                    public void message(String data) { event(serial, activeId, "message", data, 0, null); }
                    public void closed(int code, String reason) { event(serial, activeId, "close", null, code, reason); }
                    public void failed(Exception error) { event(serial, activeId, "error", null, 0, "Host connection failed or certificate changed."); }
                });
                socket = client; socketId = activeId; reply(id, json("ok", true)); client.connect();
            } else if ("sendSocket".equals(method)) {
                JSONObject options = (JSONObject)args;
                if (socket == null || !socket.isOpen() || !socketId.equals(options.getString("socketId"))) throw new IllegalArgumentException("Socket is not open.");
                String data = options.getString("data"); if (data.length() > 65536) throw new IllegalArgumentException("Message is too large.");
                socket.send(data); reply(id, json("ok", true));
            } else if ("closeSocket".equals(method)) {
                JSONObject options = (JSONObject)args;
                if (socketId != null && socketId.equals(options.getString("socketId"))) closeSocket();
                reply(id, json("ok", true));
            } else throw new IllegalArgumentException("Unsupported native operation.");
        } catch (Exception failure) { if (!id.isEmpty()) reject(id, failure.getMessage() == null ? "Native request failed." : failure.getMessage()); }
    }
    private void event(long serial, String id, String type, String data, int code, String reason) {
        runOnUiThread(() -> {
            if (destroyed || generation != serial || !id.equals(socketId)) return;
            if (!foreground && ownPermissionPause() && !projectionSession()) {
                if (pausedEvents.size() >= 64) { stopSession(); return; }
                pausedEvents.add(() -> event(serial, id, type, data, code, reason)); return;
            }
            if (!transportPage()) return;
            if ("message".equals(type)) observeBroker(data);
            deliver(json("event", "socket", "socketId", id, "type", type, "data", data == null ? JSONObject.NULL : data,
                "code", code, "reason", reason == null ? "" : reason, "message", reason == null ? "" : reason));
            if ("close".equals(type)) { closeSocket(); }
            else if ("error".equals(type)) { closeSocket(); deliver(json("event", "socket", "socketId", id, "type", "close", "code", 1006, "reason", "Connection failed")); }
        });
    }
    private void closeSocket() {
        PinnedRoomClient previous = socket; socket = null; socketId = null; selfId = null; approvedPeers.clear();
        revokeControl("Room connection closed."); ScreenShareService.stopCurrent("Room connection closed.");
        if (previous != null) previous.cancel();
    }
    private void observeBroker(String data) {
        try {
            JSONObject message = new JSONObject(data); String type = message.optString("type");
            if ("welcome".equals(type)) {
                selfId = message.getString("selfId"); approvedPeers.clear(); JSONArray peers = message.optJSONArray("peers");
                if (peers != null) for (int index = 0; index < peers.length(); index++) approvedPeers.add(peers.getJSONObject(index).getString("id"));
            } else if ("peer-joined".equals(type)) approvedPeers.add(message.getJSONObject("peer").getString("id"));
            else if ("peer-left".equals(type)) {
                String peer = message.optString("peerId", message.optString("id")); approvedPeers.remove(peer);
                AttendedAccessibilityService service = AttendedAccessibilityService.current();
                if (service != null && peer.equals(service.controller())) revokeControl("Controller disconnected.");
            } else if ("control-granted".equals(type)) {
                AttendedAccessibilityService service = AttendedAccessibilityService.current();
                if (service != null && selfId != null && selfId.equals(message.optString("targetId"))) service.confirm(message.optString("peerId"), message.optString("sessionId"));
            } else if ("control-revoked".equals(type)) {
                AttendedAccessibilityService service = AttendedAccessibilityService.current();
                if (service != null && service.matches(message.optString("peerId"), message.optString("sessionId"))) revokeControl(message.optString("reason", "Room owner revoked control."));
            } else if ("room-ended".equals(type) || "rejected".equals(type)) {
                revokeControl("Room ended."); ScreenShareService.stopCurrent("Room ended.");
            }
        } catch (Exception ignored) { /* Renderer handles malformed/unrecognized room messages. */ }
    }
    private void clearProjectionRequest() {
        main.removeCallbacks(projectionDeadline); ScreenShareService.cancelPreparation();
        projectionRequest = null; projectionOptions = null; projectionPermissionPending = false; projectionStarting = false;
        deferredProjectionResult = false; deferredProjectionConsent = null;
    }
    private void startProjection(String requestId, JSONObject options) {
        if (!trustedPage() || socket == null || !socket.isOpen() || selfId == null) { reject(requestId, "Join an approved room before sharing the phone."); return; }
        if (projectionRequest != null || ScreenShareService.active()) { reject(requestId, "Phone screen sharing is already starting or active."); return; }
        projectionRequest = requestId; projectionGeneration = generation; projectionOptions = options; projectionPermissionPending = true;
        main.postDelayed(projectionDeadline, 120000);
        MediaProjectionManager manager = (MediaProjectionManager)getSystemService(MEDIA_PROJECTION_SERVICE);
        try {
            // Full-display capture is required to map control coordinates safely.
            Intent captureIntent = Build.VERSION.SDK_INT >= 34 ? manager.createScreenCaptureIntent(MediaProjectionConfig.createConfigForDefaultDisplay()) : manager.createScreenCaptureIntent();
            startActivityForResult(captureIntent, 42);
        } catch (Exception failure) { clearProjectionRequest(); reject(requestId, "Android could not open screen sharing permission."); }
    }
    @Override protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode != 42 || projectionRequest == null) return;
        if (!foreground) { deferredProjectionResult = true; deferredProjectionCode = resultCode; deferredProjectionConsent = data; return; }
        finishProjectionPermission(resultCode, data);
    }
    private void finishProjectionPermission(int resultCode, Intent data) {
        final String requestId = projectionRequest; final long serial = projectionGeneration;
        if (requestId == null) return;
        if (resultCode != RESULT_OK || data == null || !trustedPage() || serial != generation || socket == null || !socket.isOpen() || selfId == null) {
            clearProjectionRequest(); reject(requestId, "Screen sharing was canceled or the room ended."); return;
        }
        projectionPermissionPending = false; projectionStarting = true;
        final JSONObject options = projectionOptions; String ticket = java.util.UUID.randomUUID().toString();
        ScreenShareService.prepare(ticket, new ScreenShareService.Listener() {
            public void started(int width, int height, int maxEdge) {
                if (destroyed || generation != serial || !requestId.equals(projectionRequest)) { ScreenShareService.stopCurrent("Screen start was superseded."); return; }
                projectionRequest = null; projectionOptions = null; projectionStarting = false; main.removeCallbacks(projectionDeadline);
                reply(requestId, json("id", "android-screen", "name", "Phone display", "width", width, "height", height, "fps", 12, "maxEdge", maxEdge));
            }
            public void frame(long seq, String jpeg, int width, int height) {
                if (generation == serial && localDocument()) deliver(json("event", "screen", "type", "frame", "seq", seq, "data", "data:image/jpeg;base64," + jpeg, "width", width, "height", height));
            }
            public void stopped(String reason) {
                if (destroyed || generation != serial) return;
                String pending = projectionRequest; clearProjectionRequest();
                if (pending != null) reject(pending, reason);
                if (foreground) deliver(json("event", "screen", "type", "stopped", "reason", reason));
                else stopSession();
            }
        });
        Intent service = new Intent(this, ScreenShareService.class).putExtra("ticket", ticket).putExtra("consent", data)
            .putExtra("maxEdge", "1080p".equals(options.optString("quality")) ? 1920 : 1280)
            .putExtra("microphone", options.optBoolean("microphone", false)).putExtra("camera", options.optBoolean("camera", false));
        try { startForegroundService(service); }
        catch (Exception failure) { clearProjectionRequest(); reject(requestId, "Android could not start screen sharing. Return to the app and retry."); }
    }
    private void revokeControl(String reason) {
        controlGeneration++;
        if (controlDialog != null) { controlDialog.dismiss(); controlDialog = null; }
        AttendedAccessibilityService service = AttendedAccessibilityService.current(); if (service != null) service.revoke(reason);
    }
    private void grantControl(String requestId, JSONObject options) {
        String peerId = options.optString("peerId"), sessionId = options.optString("sessionId");
        if (!trustedPage() || !"android-screen".equals(options.optString("screenId")) || !ScreenShareService.activeFullDisplay() ||
            !approvedPeers.contains(peerId) || !AttendedControlPolicy.validIdentity(peerId) || !AttendedControlPolicy.validIdentity(sessionId) || sessionId.length() < 16) {
            reply(requestId, json("ok", false, "reason", "Share your full phone display and select an approved room member first.")); return;
        }
        final AttendedAccessibilityService service = AttendedAccessibilityService.current();
        if (service == null) {
            controlDialog = new AlertDialog.Builder(this).setTitle("Enable attended phone control")
                .setMessage("Android requires the Auralink attended control accessibility service. Enable it in Settings, return to Auralink, then approve a new control request. The service can tap, swipe and edit ordinary text fields only while you share your screen and approve a controller. For a sideloaded APK, Android may first require Allow restricted settings in App info.")
                .setPositiveButton("Open Settings", (dialog, which) -> { reply(requestId, json("ok", false, "reason", "Enable Auralink attended control in Accessibility Settings, return, and approve again.")); startActivity(new Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS)); })
                .setNegativeButton("Keep view only", (dialog, which) -> reply(requestId, json("ok", false, "reason", "Phone remains view only.")))
                .setOnCancelListener(dialog -> reply(requestId, json("ok", false, "reason", "Phone remains view only."))).create();
            controlDialog.show(); return;
        }
        revokeControl("A new approval was requested."); final long serial = generation, approval = controlGeneration;
        String name = options.optString("name", "This room member").replaceAll("[\\p{Cntrl}]", ""); if (name.length() > 64) name = name.substring(0, 64);
        final String displayName = name;
        controlDialog = new AlertDialog.Builder(this).setTitle("Allow " + displayName + " to control your phone?")
            .setMessage("They can tap, swipe, scroll and enter text into ordinary apps for up to 15 minutes. Escape means Back; Home opens the phone Home screen. Password fields, the lock screen and protected screen content remain restricted. A floating Stop control button and the screen sharing notification let you end this immediately.")
            .setPositiveButton("Allow control", (dialog, which) -> {
                controlDialog = null;
                if (!trustedPage() || generation != serial || controlGeneration != approval || !approvedPeers.contains(peerId) || !ScreenShareService.activeFullDisplay()) { reply(requestId, json("ok", false, "reason", "Approval expired or the room changed.")); return; }
                boolean granted = service.grant(peerId, sessionId, displayName, reason -> {
                    deliver(json("event", "control-stop", "reason", reason));
                });
                reply(requestId, json("ok", granted, "active", granted, "peerId", peerId, "sessionId", sessionId, "reason", granted ? "" : "Android input permission is unavailable."));
                if (granted) main.postDelayed(() -> {
                    if (generation == serial && service.matches(peerId, sessionId) && !service.confirmed()) service.revoke("Room did not confirm control approval.");
                }, 5000);
            }).setNegativeButton("Keep view only", (dialog, which) -> reply(requestId, json("ok", false, "reason", "Owner declined control.")))
            .setOnCancelListener(dialog -> reply(requestId, json("ok", false, "reason", "Owner declined control."))).create();
        controlDialog.show();
    }
    private void requestMedia(PermissionRequest request) {
        if (!trustedPage() || !"https".equals(request.getOrigin().getScheme()) || !HOST.equals(request.getOrigin().getHost()) ||
            request.getOrigin().getPort() != -1 || mediaRequest != null) { request.deny(); return; }
        ArrayList<String> needed = new ArrayList<>();
        for (String resource : request.getResources()) {
            String permission = PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(resource) ? Manifest.permission.CAMERA :
                PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(resource) ? Manifest.permission.RECORD_AUDIO : null;
            if (permission == null) { request.deny(); return; }
            if (checkSelfPermission(permission) != PackageManager.PERMISSION_GRANTED) needed.add(permission);
        }
        mediaRequest = request; mediaGeneration = generation;
        if (needed.isEmpty()) completeMedia(); else {
            runtimePermissionsPending = true;
            try { requestPermissions(needed.toArray(new String[0]), 41); }
            catch (Exception failure) { runtimePermissionsPending = false; mediaRequest = null; request.deny(); }
        }
    }
    private void completeMedia() {
        PermissionRequest request = mediaRequest; mediaRequest = null; if (request == null) return;
        if (!trustedPage() || mediaGeneration != generation || socket == null || !socket.isOpen()) { request.deny(); return; }
        ArrayList<String> granted = new ArrayList<>();
        for (String resource : request.getResources()) {
            if (PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(resource) && checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) granted.add(resource);
            if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(resource) && checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) granted.add(resource);
        }
        if (granted.isEmpty()) request.deny(); else {
            try {
                if (ScreenShareService.active() && Build.VERSION.SDK_INT >= 30) {
                    int types = 0;
                    if (granted.contains(PermissionRequest.RESOURCE_AUDIO_CAPTURE)) types |= ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE;
                    if (granted.contains(PermissionRequest.RESOURCE_VIDEO_CAPTURE)) types |= ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA;
                    ScreenShareService.addMediaTypes(types);
                }
                request.grant(granted.toArray(new String[0]));
            } catch (Exception failure) { request.deny(); deliver(json("event", "media-error", "reason", "Android could not keep the microphone or camera active. Stop screen sharing, enable the device, then share again.")); }
        }
    }
    @Override public void onRequestPermissionsResult(int code, String[] permissions, int[] results) {
        super.onRequestPermissionsResult(code, permissions, results);
        if (code == 41) {
            // Android may pause this Activity for its own permission dialog.
            // Grant only after our page has returned to the foreground.
            if (foreground) { runtimePermissionsPending = false; completeMedia(); }
            else permissionResultDeferred = true;
        }
    }
    private void exitFullscreen() {
        if (fullscreen == null) return; root.removeView(fullscreen); fullscreen = null; webView.setVisibility(View.VISIBLE);
        if (fullscreenCallback != null) fullscreenCallback.onCustomViewHidden(); fullscreenCallback = null;
    }
    @Override public void onBackPressed() { if (fullscreen != null) exitFullscreen(); else super.onBackPressed(); }
    private void stopSession() {
        // Destroy the active document as well as signaling. onPause alone does
        // not guarantee MediaStream tracks or peer data channels are stopped.
        if (webView != null) {
            deliver(json("event", "session-stop", "reason", "Android app moved to the background."));
            foreground = false; generation++; invitation = null; closeSocket();
            clearProjectionRequest(); revokeControl("Android session ended."); if (callAudio != null) callAudio.stop();
            runtimePermissionsPending = false; permissionResultDeferred = false; pausedEvents.clear();
            if (mediaRequest != null) { mediaRequest.deny(); mediaRequest = null; }
            exitFullscreen(); webView.loadUrl("about:blank"); webView.onPause();
        }
    }
    @Override protected void onPause() {
        if (runtimePermissionsPending && mediaRequest != null || projectionPermissionPending || projectionSession()) foreground = false;
        else stopSession();
        super.onPause();
    }
    @Override protected void onStop() { if (!foreground && !ownPermissionPause() && !projectionSession()) stopSession(); super.onStop(); }
    @Override protected void onResume() {
        super.onResume(); foreground = true;
        if (webView != null) {
            webView.onResume();
            if (!PAGE.equals(webView.getUrl())) webView.loadUrl(PAGE);
            else {
                while (!pausedEvents.isEmpty()) pausedEvents.poll().run();
                if (permissionResultDeferred) { permissionResultDeferred = false; runtimePermissionsPending = false; completeMedia(); }
                if (deferredProjectionResult) {
                    int code = deferredProjectionCode; Intent consent = deferredProjectionConsent; deferredProjectionResult = false; deferredProjectionConsent = null;
                    finishProjectionPermission(code, consent);
                }
            }
        }
    }
    @Override protected void onDestroy() {
        destroyed = true; foreground = false; generation++; closeSocket(); workers.shutdownNow();
        clearProjectionRequest(); revokeControl("Android app closed."); if (callAudio != null) callAudio.stop();
        main.removeCallbacksAndMessages(null);
        if (webView != null) { webView.removeJavascriptInterface("AuralinkNative"); webView.destroy(); webView = null; }
        super.onDestroy();
    }
}
