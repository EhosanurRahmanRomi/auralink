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
import android.view.WindowInsets;
import android.view.WindowInsetsController;
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

/** Pinned LAN or normal-PKI Internet signaling with explicitly attended device control. */
public final class MainActivity extends Activity {
    private static final String PAGE = "https://appassets.androidplatform.net/assets/index.html";
    private static final String HOST = "appassets.androidplatform.net";
    private static final Set<String> ASSETS = new HashSet<>(Arrays.asList("index.html", "styles.css", "app.js", "rtc.js", "android-bridge.js", "internet.js", "desktop-internet.js", "relay-media.js", "audio-worklet.js", "brand-mark.png"));
    private final ExecutorService workers = Executors.newSingleThreadExecutor();
    private WebView webView;
    private FrameLayout root;
    private View fullscreen;
    private WebChromeClient.CustomViewCallback fullscreenCallback;
    private boolean presentationFullscreen;
    private android.window.OnBackInvokedCallback presentationBack;
    private boolean presentationBackRegistered;
    private volatile boolean foreground, destroyed;
    private long generation = 0;
    private Invitation invitation;
    private InternetServiceEndpoint internetService;
    private PinnedRoomClient socket;
    private String socketId;
    private String pendingInvitation;
    private boolean invitationListenerReady;
    private boolean invitationConsumed;
    private boolean websocketRelayEnabled;
    private PermissionRequest mediaRequest;
    private long mediaGeneration;
    private int nextPermissionCode = 1000, mediaPermissionCode, notificationPermissionCode, projectionPermissionCode;
    private boolean runtimePermissionsPending, permissionResultDeferred;
    private final java.util.ArrayDeque<Runnable> pausedEvents = new java.util.ArrayDeque<>();
    private int pausedEventBytes;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final RoomMembership roomMembership = new RoomMembership();
    private String projectionRequest;
    private String projectionId;
    private long projectionGeneration, controlGeneration;
    private boolean projectionPermissionPending, projectionStarting;
    private JSONObject projectionOptions;
    private Intent deferredProjectionConsent;
    private boolean deferredProjectionResult;
    private boolean notificationLaunchDeferred;
    private int deferredProjectionCode;
    private CallAudio callAudio;
    private String callId, lastSessionEnd = "";
    private boolean callStarting, displayRecoveryPending;
    private int callRequiredTypes;
    private final ArrayList<Runnable> callReady = new ArrayList<>(), callFailed = new ArrayList<>();
    private AlertDialog controlDialog;
    private final Runnable projectionDeadline = () -> {
        if (projectionRequest != null) { String id = projectionRequest; clearProjectionRequest(); reject(id, "Android screen permission timed out. Try sharing again."); ScreenShareService.stopCurrent("Screen permission timed out."); if (!foreground) stopSession(); }
    };

    @Override public void onCreate(Bundle saved) {
        super.onCreate(saved);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        root = new FrameLayout(this); webView = new WebView(this);
        root.addView(webView, new FrameLayout.LayoutParams(-1, -1)); setContentView(root);
        callAudio = new CallAudio(this, reason -> deliver(json("event", "media-error", "reason", reason)));
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
        // Keep the renderer at the application priority during an explicit
        // foreground call. Android can still reclaim it; handle that honestly.
        webView.setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_IMPORTANT, false);
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
            @Override public boolean onRenderProcessGone(WebView failed, android.webkit.RenderProcessGoneDetail detail) {
                // A terminated renderer cannot be reused. Close native consent
                // before removing it, and offer a fresh page without rejoining.
                if (failed != webView) return true;
                generation++; foreground = false; invitation = null; internetService = null;
                webView = null; mediaRequest = null; invitationListenerReady = false; pausedEvents.clear(); pausedEventBytes = 0;
                runtimePermissionsPending = false; permissionResultDeferred = false;
                clearProjectionRequest(); closeSocket(); revokeControl("Android display process stopped.");
                stopCallService("Android display process stopped."); if (callAudio != null) callAudio.stop();
                if (fullscreen != null) { root.removeView(fullscreen); fullscreen = null; fullscreenCallback = null; }
                setPresentationFullscreen(false);
                root.removeView(failed); failed.destroy();
                lastSessionEnd = "Android stopped the display process. Your call, screen share and control approval ended.";
                displayRecoveryPending = true;
                // Do not attach a dialog to a stopped Activity. Returning to
                // the app presents recovery rather than crashing a second time.
                if (!isFinishing() && !isDestroyed() && hasWindowFocus()) showDisplayRecovery();
                return true;
            }
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) { return !PAGE.equals(request.getUrl().toString().split("#", 2)[0]); }
            @Override public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError error) { handler.cancel(); }
            @Override public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl(); String path = uri.getPath();
                if (!"GET".equals(request.getMethod()) || !"https".equals(uri.getScheme()) || !HOST.equals(uri.getHost()) ||
                    uri.getPort() != -1 || uri.getQuery() != null || path == null || !path.startsWith("/assets/")) return blocked();
                String name = path.substring(8);
                if (!ASSETS.contains(name)) return blocked();
                try {
                    String mime = name.endsWith(".js") ? "application/javascript" : name.endsWith(".css") ? "text/css" : name.endsWith(".png") ? "image/png" : "text/html";
                    WebResourceResponse result = new WebResourceResponse(mime, "UTF-8", getAssets().open("renderer/" + name));
                    java.util.Map<String,String> headers = new java.util.HashMap<>();
                    headers.put("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; media-src 'self' blob:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'");
                    headers.put("X-Content-Type-Options", "nosniff"); result.setResponseHeaders(headers); return result;
                } catch (Exception failure) { return blocked(); }
            }
        });
        webView.setWebChromeClient(new WebChromeClient() {
            @Override public void onPermissionRequest(PermissionRequest request) { runOnUiThread(() -> requestMedia(request)); }
            @Override public void onPermissionRequestCanceled(PermissionRequest request) { runOnUiThread(() -> { if (mediaRequest == request) { mediaRequest = null; mediaPermissionCode = 0; runtimePermissionsPending = false; permissionResultDeferred = false; } }); }
            @Override public void onShowCustomView(View view, CustomViewCallback callback) {
                if (fullscreen != null || !trustedPage()) { callback.onCustomViewHidden(); return; }
                fullscreen = view; fullscreenCallback = callback; root.addView(view, new FrameLayout.LayoutParams(-1, -1)); webView.setVisibility(View.INVISIBLE);
                setPresentationFullscreen(true);
            }
            @Override public void onHideCustomView() { exitFullscreen(); }
        });
        foreground = true; invitationConsumed = saved != null && saved.getBoolean("invitationConsumed", false);
        if (!invitationConsumed) acceptInvitationIntent(getIntent()); webView.loadUrl(PAGE);
    }
    @Override protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent); setIntent(intent); acceptInvitationIntent(intent); deliverPendingInvitation();
    }
    @Override protected void onSaveInstanceState(Bundle saved) {
        super.onSaveInstanceState(saved);
        // Save only the consumed marker; never serialize capabilities, native
        // admission, media or control grants to restore a terminated call.
        saved.putBoolean("invitationConsumed", invitationConsumed);
    }
    private void acceptInvitationIntent(Intent intent) {
        if (intent == null || !Intent.ACTION_VIEW.equals(intent.getAction()) || intent.getData() == null) return;
        try { pendingInvitation = AppInvitation.parse(intent.getData().toString()); invitationConsumed = false; }
        catch (IllegalArgumentException invalid) { /* Untrusted OS links cannot change the current room. */ }
    }
    private void deliverPendingInvitation() {
        if (!trustedPage() || !invitationListenerReady || pendingInvitation == null) return;
        String code = consumePendingInvitation();
        deliver(json("event", "app-invitation", "code", code));
    }
    private String consumePendingInvitation() {
        String code = pendingInvitation; pendingInvitation = null;
        if (code != null) {
            invitationConsumed = true;
            if (getIntent() != null && Intent.ACTION_VIEW.equals(getIntent().getAction())) setIntent(new Intent(getIntent()).setData(null));
        }
        return code;
    }
    private WebResourceResponse blocked() {
        return new WebResourceResponse("text/plain", "UTF-8", 403, "Blocked", java.util.Collections.emptyMap(), new ByteArrayInputStream(new byte[0]));
    }
    private boolean localDocument() { return !destroyed && webView != null && PAGE.equals(webView.getUrl() == null ? "" : webView.getUrl().split("#", 2)[0]); }
    private boolean trustedPage() { return foreground && localDocument(); }
    private String installedVersion() {
        try { return getPackageManager().getPackageInfo(getPackageName(), 0).versionName; }
        catch (PackageManager.NameNotFoundException missing) { return "unknown"; }
    }
    private int newPermissionCode() {
        // Activity result codes are 16-bit. Keep separate codes for each owned
        // prompt so an old result can never complete a replacement request.
        if (nextPermissionCode > 65535) throw new IllegalStateException("Reopen Glance-Port before requesting another permission.");
        return nextPermissionCode++;
    }
    private boolean projectionSession() { return localDocument() && (ScreenShareService.active() || projectionStarting); }
    private boolean callSession() { return localDocument() && callId != null && (callStarting || CallSessionService.active(callId)); }
    private boolean transportPage() { return trustedPage() || ownPermissionPause() || projectionSession() || callSession(); }
    private boolean ownPermissionPause() {
        return !foreground && !destroyed && ((runtimePermissionsPending && mediaRequest != null) || projectionPermissionPending) &&
            webView != null && PAGE.equals(webView.getUrl());
    }
    private final class NativeBridge {
        @JavascriptInterface public void postMessage(String value) {
            if (value == null || value.length() > RelayMediaPolicy.BRIDGE_LIMIT) return;
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
            // An owned permission dialog or explicitly active foreground
            // session can keep existing transport and approved input alive.
            // New invitations, capture and owner grants require foreground.
            if (ownPermissionPause() || projectionSession() || callSession()) {
                try {
                    String method = new JSONObject(value).getString("method");
                    if (!"sendSocket".equals(method) && !"closeSocket".equals(method) && !"ackScreenFrame".equals(method) &&
                        !"applyInput".equals(method) && !"revokeControl".equals(method) && !"stopScreenShare".equals(method) && !"setAudioRoute".equals(method)) return;
                } catch (Exception ignored) { return; }
            } else return;
        }
        String id = "";
        try {
            JSONObject request = new JSONObject(value); id = request.getString("requestId");
            if (!id.matches("r[0-9]{1,16}")) return;
            String method = request.getString("method"); Object args = request.opt("args");
            if (value.length() > 70000 && !"sendSocket".equals(method)) throw new IllegalArgumentException("Native request is too large.");
            if ("getInfo".equals(method)) {
                boolean enabled = AttendedAccessibilityService.current() != null;
                reply(id, json("platform", "android", "version", installedVersion(), "nativeControl", true,
                    "supports", new JSONArray(Arrays.asList("tap", "swipe", "wheel", "editable-text", "back", "home")), "accessibilityEnabled", enabled, "notificationAvailable", notificationsAvailable(),
                    "lastSessionEnd", lastSessionEnd,
                    "capabilities", json("hostRoom", false, "screenShare", true, "remoteInputHost", true, "accessibilityEnabled", enabled, "screenMaxEdge", 1920, "screenMaxFps", 12, "foregroundCallService", true, "foregroundRoomService", true)));
                lastSessionEnd = "";
            } else if ("setPresentationFullscreen".equals(method)) {
                if (!(args instanceof Boolean)) throw new IllegalArgumentException("Invalid fullscreen state.");
                if ((Boolean)args) setPresentationFullscreen(true); else exitFullscreen();
                reply(id, json("fullscreen", presentationFullscreen));
            } else if ("getPendingInvitation".equals(method)) {
                invitationListenerReady = true;
                String code = consumePendingInvitation(); reply(id, code == null ? JSONObject.NULL : code);
            } else if ("startScreenShare".equals(method)) {
                startProjection(id, args instanceof JSONObject ? (JSONObject)args : new JSONObject());
            } else if ("stopScreenShare".equals(method)) {
                // A delayed renderer continuation may clean up only the capture
                // it started, never a newer owner-approved replacement.
                if (args instanceof JSONObject && ((JSONObject)args).has("captureId") &&
                    !java.util.Objects.equals(projectionId, ((JSONObject)args).optString("captureId"))) {
                    reply(id, json("ok", false, "reason", "That screen share has already ended.")); return;
                }
                reply(id, json("ok", true)); clearProjectionRequest(); ScreenShareService.stopCurrent("Stopped in Glance-Port."); revokeControl("Screen sharing stopped.");
            } else if ("ackScreenFrame".equals(method)) {
                if (((JSONObject)args).has("captureId") &&
                    !java.util.Objects.equals(projectionId, ((JSONObject)args).optString("captureId"))) {
                    reply(id, json("ok", false)); return;
                }
                ScreenShareService.acknowledge(((JSONObject)args).getLong("seq")); reply(id, json("ok", true));
            } else if ("grantControl".equals(method)) {
                grantControl(id, (JSONObject)args);
            } else if ("revokeControl".equals(method)) {
                revokeControl("Permission revoked in Glance-Port."); reply(id, json("ok", true));
            } else if ("applyInput".equals(method)) {
                JSONObject input = (JSONObject)args; AttendedAccessibilityService service = AttendedAccessibilityService.current();
                String peer = input.getString("peerId"), session = input.getString("sessionId");
                boolean authorized = roomMembership.allows(peer) && service != null && service.matches(peer, session) && service.active() && service.confirmed();
                boolean ok = authorized && service.apply(peer, session, input.getJSONObject("event"));
                reply(id, json("ok", ok, "reason", ok ? "" : authorized ? "Unsupported phone input or this field is unavailable for accessibility editing." : "Control is not approved for this phone, participant and session."));
            } else if ("inputStatus".equals(method)) {
                AttendedAccessibilityService service = AttendedAccessibilityService.current();
                reply(id, json("available", service != null, "active", service != null && service.active(), "peerId", service == null || service.controller() == null ? JSONObject.NULL : service.controller()));
            } else if ("setAudioRoute".equals(method)) {
                JSONObject route = args instanceof JSONObject ? (JSONObject)args : new JSONObject();
                final String requestId = id; final boolean active = route.optBoolean("active", true), speaker = route.optBoolean("speaker", true);
                Runnable update = () -> {
                    boolean ok = callAudio.update(active && (foreground || callSession() || projectionSession()), speaker);
                    reply(requestId, json("ok", ok, "speaker", speaker, "reason", ok ? "" : callAudio.lastError()));
                    if (!foreground && !transportPage()) stopSession("Call media ended while Glance-Port was in the background.");
                };
                if (active && roomMembership.hasRoom()) {
                    // An explicitly admitted device room keeps its network
                    // session visible. Playback is added only for real media.
                    int types = ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE;
                    if (route.optBoolean("playback", false)) types |= ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK;
                    ensureCallService(types, update,
                        () -> reject(requestId, "Android could not keep the call active. Return to Glance-Port and reconnect."));
                } else {
                    if (!roomMembership.hasRoom()) stopCallService("Room ended.");
                    update.run();
                }
            } else if ("copyText".equals(method)) {
                if (!(args instanceof String) || ((String)args).length() > 4096) throw new IllegalArgumentException("Invalid clipboard text.");
                ((ClipboardManager)getSystemService(CLIPBOARD_SERVICE)).setPrimaryClip(ClipData.newPlainText("Glance-Port", (String)args)); reply(id, json("ok", true));
            } else if ("trustInvite".equals(method)) {
                if (!(args instanceof String)) throw new IllegalArgumentException("Invalid invitation.");
                final Invitation candidate = Invitation.parse((String)args);
                if (socket != null) throw new IllegalArgumentException("Leave your room before checking another invitation.");
                final long serial = ++generation; invitation = null; internetService = null; final String requestId = id;
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
            } else if ("trustInternetService".equals(method)) {
                if (!(args instanceof String)) throw new IllegalArgumentException("Invalid Internet service address.");
                final InternetServiceEndpoint candidate = InternetServiceEndpoint.parse((String)args);
                if (socket != null) throw new IllegalArgumentException("Disconnect before selecting another service.");
                final long serial = ++generation; invitation = null; internetService = null; final String requestId = id;
                workers.execute(() -> {
                    try {
                        // Default platform CA and hostname checks apply. A redirect may
                        // not turn the selected service into a different authority.
                        HttpsURLConnection connection = (HttpsURLConnection)new URL(candidate.origin + "/internet/health").openConnection();
                        connection.setConnectTimeout(7000); connection.setReadTimeout(7000); connection.setInstanceFollowRedirects(false);
                        try { if (connection.getResponseCode() != 200) throw new IllegalArgumentException("Service did not return a healthy response."); }
                        finally { connection.disconnect(); }
                        runOnUiThread(() -> {
                            if (!trustedPage() || generation != serial) return;
                            internetService = candidate;
                            try { reply(requestId, json("url", candidate.origin, "socketUrl", candidate.socketUri().toString(), "mode", "internet")); }
                            catch (Exception failure) { internetService = null; reject(requestId, "Invalid Internet service endpoint."); }
                        });
                    } catch (Exception failure) { runOnUiThread(() -> { if (generation == serial) reject(requestId, "Could not verify the Internet service. Check its HTTPS address, certificate and connection."); }); }
                });
            } else if ("openSocket".equals(method)) {
                JSONObject options = (JSONObject)args; String nextId = options.getString("socketId");
                String address = options.getString("url");
                boolean verifiedLan = invitation != null && internetService == null && invitation.matchesSocket(address);
                boolean verifiedInternet = internetService != null && invitation == null && internetService.matchesSocket(address);
                if (!nextId.matches("socket-[0-9]{1,16}") || socket != null || !(verifiedLan || verifiedInternet))
                    throw new IllegalArgumentException("Socket address is not the verified invitation or Internet service.");
                final long serial = generation; final String activeId = nextId;
                final boolean internet = verifiedInternet;
                PinnedRoomClient.Listener listener = new PinnedRoomClient.Listener() {
                    public void opened() { event(serial, activeId, "open", null, 0, null); }
                    public void message(String data) { event(serial, activeId, "message", data, 0, null); }
                    public void closed(int code, String reason) { event(serial, activeId, "close", null, code, reason); }
                    public void failed(Exception error) { event(serial, activeId, "error", null, 0, internet ? "Internet service connection or certificate verification failed." : "Host connection failed or certificate changed."); }
                };
                PinnedRoomClient client = verifiedInternet ? new PinnedRoomClient(internetService, listener) : new PinnedRoomClient(invitation, listener);
                socket = client; socketId = activeId; reply(id, json("ok", true)); client.connect();
            } else if ("sendSocket".equals(method)) {
                JSONObject options = (JSONObject)args;
                if (socket == null || !socket.isOpen() || !socketId.equals(options.getString("socketId"))) throw new IllegalArgumentException("Socket is not open.");
                String data = options.getString("data");
                if (!validSocketMessage(data, true)) throw new IllegalArgumentException("Invalid or oversized room message.");
                if (internetService != null) {
                    JSONObject outgoing = new JSONObject(data); String operation = outgoing.optString("type");
                    if (roomMembership.endForOutbound(operation)) {
                        clearRoomState("Internet room changed locally.");
                        if ("join".equals(operation) || "join-device".equals(operation)) roomMembership.expectAdmission(outgoing.optString("roomId"), "join-device".equals(operation));
                    }
                }
                socket.send(data); reply(id, json("ok", true));
                if (!foreground && !transportPage()) stopSession("Room ended while Glance-Port was in the background.");
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
            // A disconnected background session cannot retain WebView media or
            // projection consent, even while an approved projection was active.
            if (!foreground && ("close".equals(type) || "error".equals(type))) { stopSession("Connection ended while Glance-Port was in the background."); return; }
            if (!foreground && ownPermissionPause() && !projectionSession() && !callSession()) {
                int bytes = data == null ? 0 : data.getBytes(java.nio.charset.StandardCharsets.UTF_8).length;
                if (pausedEvents.size() >= 64 || pausedEventBytes + bytes > 1048576) { stopSession(); return; }
                pausedEventBytes += bytes;
                pausedEvents.add(() -> { pausedEventBytes -= bytes; event(serial, id, type, data, code, reason); }); return;
            }
            if (!transportPage()) return;
            if ("message".equals(type) && !validSocketMessage(data, false)) { stopSession("The service sent an invalid room message."); return; }
            if ("message".equals(type) && !observeBroker(data)) return;
            if (!foreground && !transportPage()) { stopSession("Room ended while Glance-Port was in the background."); return; }
            deliver(json("event", "socket", "socketId", id, "type", type, "data", data == null ? JSONObject.NULL : data,
                "code", code, "reason", reason == null ? "" : reason, "message", reason == null ? "" : reason));
            if ("close".equals(type)) { closeSocket(); }
            else if ("error".equals(type)) { closeSocket(); deliver(json("event", "socket", "socketId", id, "type", "close", "code", 1006, "reason", "Connection failed")); }
        });
    }
    private void closeSocket() {
        PinnedRoomClient previous = socket; socket = null; socketId = null;
        clearRoomState("Room connection closed.");
        if (previous != null) previous.cancel();
    }
    private boolean validSocketMessage(String raw, boolean outbound) {
        if (raw == null || raw.length() > RelayMediaPolicy.WIRE_LIMIT) return false;
        try {
            JSONObject message = new JSONObject(raw), data = message.optJSONObject("data");
            if (data == null || !data.has("relay")) return raw.getBytes(java.nio.charset.StandardCharsets.UTF_8).length <= RelayMediaPolicy.SIGNAL_LIMIT;
            if (internetService == null || !websocketRelayEnabled || !"signal".equals(message.opt("type")) || message.length() != 3 || data.length() != 1 || !roomMembership.hasRoom()) return false;
            Object peer = message.opt(outbound ? "to" : "from");
            if (!(peer instanceof String) || !roomMembership.allows((String)peer)) return false;
            JSONObject relay = data.optJSONObject("relay");
            if (relay == null || !(relay.opt("version") instanceof Number) || !(relay.opt("counter") instanceof Number) ||
                !(relay.opt("epoch") instanceof String) || !(relay.opt("nonce") instanceof String) || !(relay.opt("ciphertext") instanceof String)) return false;
            return RelayMediaPolicy.valid(relay.length(), ((Number)relay.opt("version")).doubleValue(), (String)relay.opt("epoch"),
                ((Number)relay.opt("counter")).doubleValue(), (String)relay.opt("nonce"), (String)relay.opt("ciphertext")) &&
                raw.getBytes(java.nio.charset.StandardCharsets.UTF_8).length <= RelayMediaPolicy.WIRE_LIMIT;
        } catch (Exception malformed) { return false; }
    }
    private void clearRoomState(String reason) {
        roomMembership.clear(); websocketRelayEnabled = false; String pendingProjection = projectionRequest; clearProjectionRequest();
        if (pendingProjection != null) reject(pendingProjection, reason);
        revokeControl(reason); ScreenShareService.stopCurrent(reason);
        stopCallService(reason);
        if (mediaRequest != null) { mediaRequest.deny(); mediaRequest = null; }
        mediaPermissionCode = 0; runtimePermissionsPending = false; permissionResultDeferred = false;
        if (callAudio != null) callAudio.stop();
    }
    private void ensureCallService(int types, Runnable ready, Runnable failed) {
        if (!localDocument() || !roomMembership.hasRoom() || socket == null || !socket.isOpen()) { failed.run(); return; }
        if (CallSessionService.active(callId)) {
            boolean sensitive = (types & ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE) != 0;
            if ((!sensitive || trustedPage()) && CallSessionService.addMediaTypes(callId, types)) ready.run(); else failed.run();
            return;
        }
        // Android 14+ checks while-in-use microphone permission when
        // creating the service. Starting a new call always requires visibility.
        if (!trustedPage()) { failed.run(); return; }
        callRequiredTypes |= types; callReady.add(ready); callFailed.add(failed);
        if (callStarting) return;
        callStarting = true; callId = java.util.UUID.randomUUID().toString();
        final String ticket = callId; final long serial = roomMembership.epoch();
        CallSessionService.prepare(ticket, new CallSessionService.Listener() {
            public void started() {
                if (destroyed || !ticket.equals(callId) || roomMembership.epoch() != serial || !localDocument()) {
                    CallSessionService.stop(ticket, "Call start was superseded."); return;
                }
                callStarting = false;
                if (!CallSessionService.addMediaTypes(ticket, callRequiredTypes)) { stopCallService("Android could not activate call media."); return; }
                ArrayList<Runnable> completions = new ArrayList<>(callReady); callReady.clear(); callFailed.clear();
                for (Runnable completion : completions) completion.run();
            }
            public void stopped(String reason) {
                if (destroyed || !ticket.equals(callId) || roomMembership.epoch() != serial) return;
                stopSession(reason);
            }
        });
        try { startForegroundService(new Intent(this, CallSessionService.class).putExtra("ticket", ticket).putExtra("types", callRequiredTypes)); }
        catch (RuntimeException denied) {
            stopCallService("Android could not start an active call service.");
            deliver(json("event", "media-error", "reason", "Android could not keep this call active. Return to Glance-Port and reconnect."));
        }
    }
    private void stopCallService(String reason) {
        String previous = callId; callId = null; callStarting = false; callRequiredTypes = 0;
        ArrayList<Runnable> failures = new ArrayList<>(callFailed); callReady.clear(); callFailed.clear();
        if (previous != null) CallSessionService.stop(previous, reason);
        for (Runnable failure : failures) failure.run();
    }
    private boolean observeBroker(String data) {
        try {
            JSONObject message = new JSONObject(data); String type = message.optString("type");
            if ("welcome".equals(type)) {
                if (internetService != null && !roomMembership.acceptsWelcome(message.optString("selfId"), message.optJSONObject("room") == null ? "" : message.optJSONObject("room").optString("id"))) return false;
                clearRoomState("Room admission changed.");
                JSONArray peers = message.optJSONArray("peers"); ArrayList<String> identities = new ArrayList<>();
                if (peers != null) for (int index = 0; index < peers.length(); index++) identities.add(peers.getJSONObject(index).getString("id"));
                if (!roomMembership.begin(message.getString("selfId"), identities)) return false;
                websocketRelayEnabled = internetService != null && roomMembership.hasRoom() && message.optBoolean("websocketRelayEnabled", false) &&
                    message.opt("relayKey") instanceof String && RelayMediaPolicy.validKey((String)message.opt("relayKey"));
                if (roomMembership.hasRoom()) ensureCallService(ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE, () -> {},
                    () -> stopSession("Android could not keep the room open. Return to Glance-Port and reconnect."));
            } else if ("pending".equals(type) && internetService != null) {
                if (!roomMembership.observePending(message.optString("selfId"), message.optJSONObject("room") == null ? "" : message.optJSONObject("room").optString("id"))) return false;
            } else if ("peer-joined".equals(type)) roomMembership.add(message.getJSONObject("peer").getString("id"));
            else if ("peer-left".equals(type)) {
                String peer = message.optString("peerId", message.optString("id")); roomMembership.remove(peer);
                AttendedAccessibilityService service = AttendedAccessibilityService.current();
                if (service != null && peer.equals(service.controller())) revokeControl("Controller disconnected.");
            } else if ("control-granted".equals(type)) {
                AttendedAccessibilityService service = AttendedAccessibilityService.current();
                if (service != null && roomMembership.hasRoom() && roomMembership.selfId().equals(message.optString("targetId")) && roomMembership.allows(message.optString("peerId"))) service.confirm(message.optString("peerId"), message.optString("sessionId"));
            } else if ("control-revoked".equals(type)) {
                AttendedAccessibilityService service = AttendedAccessibilityService.current();
                if (service != null && service.matches(message.optString("peerId"), message.optString("sessionId"))) revokeControl(message.optString("reason", "Room owner revoked control."));
            } else if (roomMembership.endForEvent(type)) {
                // The Internet directory socket can stay online after leaving;
                // no native media or control approval may survive that room.
                clearRoomState("Room ended.");
            }
        } catch (Exception ignored) { /* Renderer handles malformed/unrecognized room messages. */ }
        return true;
    }
    private void clearProjectionRequest() {
        main.removeCallbacks(projectionDeadline); ScreenShareService.cancelPreparation(projectionId);
        projectionRequest = null; projectionOptions = null; projectionPermissionPending = false; projectionStarting = false;
        projectionId = null;
        projectionPermissionCode = 0; notificationPermissionCode = 0;
        deferredProjectionResult = false; deferredProjectionConsent = null; notificationLaunchDeferred = false;
    }
    private void startProjection(String requestId, JSONObject options) {
        if (!trustedPage() || socket == null || !socket.isOpen() || !roomMembership.hasRoom()) { reject(requestId, "Join an approved room before sharing the phone."); return; }
        if (projectionRequest != null || ScreenShareService.active()) { reject(requestId, "Phone screen sharing is already starting or active."); return; }
        projectionRequest = requestId; projectionId = java.util.UUID.randomUUID().toString(); projectionGeneration = roomMembership.epoch(); projectionOptions = options; projectionPermissionPending = true;
        main.postDelayed(projectionDeadline, 120000);
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            // A visible stop notification matters while another app is being
            // shared. Denial is respected and does not prevent screen consent.
            try { notificationPermissionCode = newPermissionCode(); requestPermissions(new String[] {Manifest.permission.POST_NOTIFICATIONS}, notificationPermissionCode); }
            catch (Exception failure) { launchScreenConsent(); }
        } else launchScreenConsent();
    }
    private boolean notificationsAvailable() {
        return (Build.VERSION.SDK_INT < 33 || checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) &&
            ((android.app.NotificationManager)getSystemService(NOTIFICATION_SERVICE)).areNotificationsEnabled();
    }
    private void launchScreenConsent() {
        final String requestId = projectionRequest;
        if (requestId == null || projectionPermissionCode != 0) return;
        if (!trustedPage() || projectionGeneration != roomMembership.epoch() || socket == null || !socket.isOpen() || !roomMembership.hasRoom()) {
            clearProjectionRequest(); reject(requestId, "Return to the active room and try sharing again."); return;
        }
        MediaProjectionManager manager = (MediaProjectionManager)getSystemService(MEDIA_PROJECTION_SERVICE);
        try {
            // Full-display capture is required to map control coordinates safely.
            Intent captureIntent = Build.VERSION.SDK_INT >= 34 ? manager.createScreenCaptureIntent(MediaProjectionConfig.createConfigForDefaultDisplay()) : manager.createScreenCaptureIntent();
            projectionPermissionCode = newPermissionCode(); startActivityForResult(captureIntent, projectionPermissionCode);
        } catch (Exception failure) { clearProjectionRequest(); reject(requestId, "Android could not open screen sharing permission."); }
    }
    @Override protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode != projectionPermissionCode || projectionRequest == null) return;
        projectionPermissionCode = 0;
        if (!foreground) { deferredProjectionResult = true; deferredProjectionCode = resultCode; deferredProjectionConsent = data; return; }
        finishProjectionPermission(resultCode, data);
    }
    private void finishProjectionPermission(int resultCode, Intent data) {
        final String requestId = projectionRequest; final long serial = projectionGeneration;
        if (requestId == null) return;
        if (resultCode != RESULT_OK || data == null || !trustedPage() || serial != roomMembership.epoch() || socket == null || !socket.isOpen() || !roomMembership.hasRoom()) {
            clearProjectionRequest(); reject(requestId, "Screen sharing was canceled or the room ended."); return;
        }
        projectionPermissionPending = false; projectionStarting = true;
        final JSONObject options = projectionOptions; final String ticket = projectionId;
        ScreenShareService.prepare(ticket, new ScreenShareService.Listener() {
            public void started(int width, int height, int maxEdge) {
                if (destroyed || roomMembership.epoch() != serial || !ticket.equals(projectionId) || !requestId.equals(projectionRequest)) { ScreenShareService.stopCurrent(ticket, "Screen start was superseded."); return; }
                projectionRequest = null; projectionOptions = null; projectionStarting = false; main.removeCallbacks(projectionDeadline);
                reply(requestId, json("id", "android-screen", "captureId", ticket, "name", "Phone display", "width", width, "height", height, "fps", 12, "maxEdge", maxEdge, "notificationAvailable", notificationsAvailable()));
            }
            public void frame(long seq, String jpeg, int width, int height) {
                if (roomMembership.epoch() == serial && roomMembership.hasRoom() && ticket.equals(projectionId) && localDocument()) deliver(json("event", "screen", "type", "frame", "captureId", ticket, "seq", seq, "data", "data:image/jpeg;base64," + jpeg, "width", width, "height", height));
            }
            public void stopped(String reason) {
                if (destroyed || roomMembership.epoch() != serial || !ticket.equals(projectionId)) return;
                String pending = projectionRequest; clearProjectionRequest();
                if (pending != null) reject(pending, reason);
                if (foreground || callSession()) deliver(json("event", "screen", "type", "stopped", "captureId", ticket, "reason", reason));
                else stopSession("Screen sharing ended while Glance-Port was in the background.");
            }
        });
        Intent service = new Intent(this, ScreenShareService.class).putExtra("ticket", ticket).putExtra("consent", data)
            .putExtra("maxEdge", "1080p".equals(options.optString("quality")) ? 1920 : 1280)
            .putExtra("microphone", options.optBoolean("microphone", false));
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
            !roomMembership.allows(peerId) || !AttendedControlPolicy.validIdentity(peerId) || !AttendedControlPolicy.validIdentity(sessionId) || sessionId.length() < 16) {
            reply(requestId, json("ok", false, "reason", "Share your full phone display and select an approved room member first.")); return;
        }
        final AttendedAccessibilityService service = AttendedAccessibilityService.current();
        if (service == null) {
            controlDialog = new AlertDialog.Builder(this).setTitle("Enable attended phone control")
                .setMessage("Android requires the Glance-Port attended control accessibility service. Enable it in Settings, return to Glance-Port, then approve a new control request. The service can tap, swipe and edit ordinary text fields only while you share your screen and approve a controller. For a sideloaded APK, Android may first require Allow restricted settings in App info.")
                .setPositiveButton("Open Settings", (dialog, which) -> { reply(requestId, json("ok", false, "reason", "Enable Glance-Port attended control in Accessibility Settings, return, and approve again.")); startActivity(new Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS)); })
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
                if (!trustedPage() || generation != serial || controlGeneration != approval || !roomMembership.allows(peerId) || !ScreenShareService.activeFullDisplay()) { reply(requestId, json("ok", false, "reason", "Approval expired or the room changed.")); return; }
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
        if (!trustedPage() || !roomMembership.hasRoom() || !"https".equals(request.getOrigin().getScheme()) || !HOST.equals(request.getOrigin().getHost()) ||
            request.getOrigin().getPort() != -1 || mediaRequest != null) { request.deny(); return; }
        ArrayList<String> needed = new ArrayList<>();
        for (String resource : request.getResources()) {
            String permission = PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(resource) ? Manifest.permission.RECORD_AUDIO : null;
            if (permission == null) { request.deny(); return; }
            if (checkSelfPermission(permission) != PackageManager.PERMISSION_GRANTED) needed.add(permission);
        }
        mediaRequest = request; mediaGeneration = roomMembership.epoch();
        if (needed.isEmpty()) completeMedia(); else {
            runtimePermissionsPending = true;
            try { mediaPermissionCode = newPermissionCode(); requestPermissions(needed.toArray(new String[0]), mediaPermissionCode); }
            catch (Exception failure) { runtimePermissionsPending = false; mediaRequest = null; request.deny(); }
        }
    }
    private void completeMedia() {
        PermissionRequest request = mediaRequest; mediaRequest = null; if (request == null) return;
        if (!trustedPage() || !roomMembership.hasRoom() || mediaGeneration != roomMembership.epoch() || socket == null || !socket.isOpen()) { request.deny(); return; }
        ArrayList<String> granted = new ArrayList<>();
        for (String resource : request.getResources()) {
            if (!PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(resource)) { request.deny(); return; }
            if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(resource) && checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) granted.add(resource);
        }
        if (granted.isEmpty()) request.deny(); else {
            int required = ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE;
            if (Build.VERSION.SDK_INT >= 30 && granted.contains(PermissionRequest.RESOURCE_AUDIO_CAPTURE)) required |= ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE;
            final long serial = mediaGeneration;
            ensureCallService(required, () -> {
                if (!trustedPage() || roomMembership.epoch() != serial || !roomMembership.hasRoom() || !CallSessionService.active(callId)) { request.deny(); return; }
                try {
                if (ScreenShareService.active() && Build.VERSION.SDK_INT >= 30) {
                    int types = 0;
                    if (granted.contains(PermissionRequest.RESOURCE_AUDIO_CAPTURE)) types |= ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE;
                    ScreenShareService.addMediaTypes(types);
                }
                    request.grant(granted.toArray(new String[0]));
                } catch (Exception failure) { request.deny(); deliver(json("event", "media-error", "reason", "Android could not keep the microphone active. Return to the app and retry.")); }
            }, () -> { request.deny(); deliver(json("event", "media-error", "reason", "Android could not start the microphone service. Return to the app and retry.")); });
        }
    }
    @Override public void onRequestPermissionsResult(int code, String[] permissions, int[] results) {
        super.onRequestPermissionsResult(code, permissions, results);
        if (code == mediaPermissionCode && mediaRequest != null) {
            mediaPermissionCode = 0;
            // Android may pause this Activity for its own permission dialog.
            // Grant only after our page has returned to the foreground.
            if (foreground) { runtimePermissionsPending = false; completeMedia(); }
            else permissionResultDeferred = true;
        } else if (code == notificationPermissionCode && projectionRequest != null) {
            notificationPermissionCode = 0;
            // Notification permission is optional. Continue with a separately
            // owned screen sharing consent when this document returns.
            if (foreground) launchScreenConsent(); else notificationLaunchDeferred = true;
        }
    }
    private void applyPresentationBars() {
        if (Build.VERSION.SDK_INT >= 30) {
            WindowInsetsController controller = getWindow().getInsetsController();
            if (controller != null) {
                controller.setSystemBarsBehavior(WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
                if (presentationFullscreen) controller.hide(WindowInsets.Type.systemBars());
                else controller.show(WindowInsets.Type.systemBars());
            }
        } else {
            getWindow().getDecorView().setSystemUiVisibility(presentationFullscreen ?
                View.SYSTEM_UI_FLAG_LAYOUT_STABLE | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION |
                View.SYSTEM_UI_FLAG_FULLSCREEN | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY : View.SYSTEM_UI_FLAG_LAYOUT_STABLE);
        }
        if (root != null) root.requestApplyInsets();
    }
    private void setPresentationFullscreen(boolean active) {
        boolean changed = presentationFullscreen != active;
        presentationFullscreen = active; applyPresentationBars();
        // Android 16 no longer dispatches legacy onBackPressed for target 36.
        // Intercept Back only while presentation is open, preserving the
        // normal system back-to-home gesture everywhere else in the app.
        if (Build.VERSION.SDK_INT >= 33) {
            if (active && !presentationBackRegistered) {
                if (presentationBack == null) presentationBack = () -> exitFullscreen();
                getOnBackInvokedDispatcher().registerOnBackInvokedCallback(android.window.OnBackInvokedDispatcher.PRIORITY_DEFAULT, presentationBack);
                presentationBackRegistered = true;
            } else if (!active && presentationBackRegistered) {
                getOnBackInvokedDispatcher().unregisterOnBackInvokedCallback(presentationBack);
                presentationBackRegistered = false;
            }
        }
        if (changed) deliver(json("event", "presentation-fullscreen", "fullscreen", active));
    }
    private void exitFullscreen() {
        if (fullscreen != null) {
            root.removeView(fullscreen); fullscreen = null;
            if (webView != null) webView.setVisibility(View.VISIBLE);
            WebChromeClient.CustomViewCallback callback = fullscreenCallback; fullscreenCallback = null;
            if (callback != null) callback.onCustomViewHidden();
        }
        setPresentationFullscreen(false);
    }
    @Override public void onBackPressed() { if (fullscreen != null || presentationFullscreen) exitFullscreen(); else super.onBackPressed(); }
    private void showDisplayRecovery() {
        if (!displayRecoveryPending || isFinishing() || isDestroyed()) return;
        displayRecoveryPending = false;
        new AlertDialog.Builder(this).setTitle("Call display stopped")
            .setMessage("Android stopped the display process. Your room, screen share and control approval have ended. Reopen Glance-Port to connect again.")
            .setPositiveButton("Reopen", (dialog, which) -> recreate())
            .setNegativeButton("Close", (dialog, which) -> finish()).setOnCancelListener(dialog -> finish()).show();
    }
    private void stopSession() { stopSession("Android ended this session. Return to Glance-Port and reconnect."); }
    private void stopSession(String reason) {
        // Actual loss of the native session destroys media tracks/channels.
        // Ordinary Activity pause uses pauseIdleSession and retains the page.
        if (webView != null) {
            lastSessionEnd = reason;
            deliver(json("event", "session-stop", "reason", reason));
            foreground = false; generation++; invitation = null; internetService = null; closeSocket();
            clearProjectionRequest(); revokeControl("Android session ended."); if (callAudio != null) callAudio.stop();
            runtimePermissionsPending = false; permissionResultDeferred = false; pausedEvents.clear(); pausedEventBytes = 0;
            if (mediaRequest != null) { mediaRequest.deny(); mediaRequest = null; }
            exitFullscreen(); invitationListenerReady = false; webView.loadUrl("about:blank"); webView.onPause();
        }
    }
    private void pauseIdleSession() {
        // Do not navigate away from the document for an ordinary app switch.
        // An unadmitted directory/pending connection has no room foreground
        // service. Close it while retaining the selected page on return.
        if (socket != null || roomMembership.hasRoom()) deliver(json("event", "session-stop", "reason", "The inactive room closed while Glance-Port was in the background."));
        generation++; invitation = null; internetService = null; closeSocket();
        runtimePermissionsPending = false; permissionResultDeferred = false; pausedEvents.clear(); pausedEventBytes = 0;
        foreground = false; if (webView != null) webView.onPause();
    }
    @Override protected void onPause() {
        if (runtimePermissionsPending && mediaRequest != null || projectionPermissionPending || projectionSession() || callSession()) foreground = false;
        else pauseIdleSession();
        super.onPause();
    }
    @Override protected void onStop() { super.onStop(); }
    @Override protected void onResume() {
        super.onResume(); foreground = true;
        applyPresentationBars();
        if (callAudio != null && !callAudio.resume()) deliver(json("event", "media-error", "reason", callAudio.lastError()));
        if (webView != null) {
            webView.onResume();
            if (!localDocument()) webView.loadUrl(PAGE);
            else {
                deliver(json("event", "session-resume"));
                while (!pausedEvents.isEmpty()) pausedEvents.poll().run();
                if (permissionResultDeferred) { permissionResultDeferred = false; runtimePermissionsPending = false; completeMedia(); }
                if (notificationLaunchDeferred) { notificationLaunchDeferred = false; launchScreenConsent(); }
                if (deferredProjectionResult) {
                    int code = deferredProjectionCode; Intent consent = deferredProjectionConsent; deferredProjectionResult = false; deferredProjectionConsent = null;
                    finishProjectionPermission(code, consent);
                }
                deliverPendingInvitation();
            }
        }
        if (displayRecoveryPending) showDisplayRecovery();
    }
    @Override protected void onDestroy() {
        destroyed = true; foreground = false; generation++; closeSocket(); workers.shutdownNow();
        exitFullscreen();
        clearProjectionRequest(); revokeControl("Android app closed."); if (callAudio != null) callAudio.stop();
        main.removeCallbacksAndMessages(null);
        if (webView != null) { webView.removeJavascriptInterface("AuralinkNative"); webView.destroy(); webView = null; }
        super.onDestroy();
    }
}
