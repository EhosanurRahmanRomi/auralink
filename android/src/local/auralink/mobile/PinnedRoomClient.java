package local.auralink.mobile;

import java.util.Collections;
import javax.net.ssl.SSLContext;
import javax.net.ssl.SSLParameters;
import org.java_websocket.client.WebSocketClient;
import org.java_websocket.drafts.Draft_6455;
import org.java_websocket.extensions.IExtension;
import org.java_websocket.handshake.ServerHandshake;

/** Signaling only. WebRTC media remains in the local WebView. */
public final class PinnedRoomClient extends WebSocketClient {
    public interface Listener {
        void opened(); void message(String data); void closed(int code, String reason); void failed(Exception error);
    }
    private final Listener listener;
    private final boolean internet;
    public PinnedRoomClient(Invitation invitation, Listener listener) throws Exception {
        super(invitation.socketUri(), new Draft_6455(Collections.<IExtension>emptyList(), 65536), Collections.<String,String>emptyMap(), 10000);
        this.listener = listener; this.internet = false;
        setSocketFactory(PinnedTls.context(invitation).getSocketFactory());
        setConnectionLostTimeout(20);
    }
    public PinnedRoomClient(InternetServiceEndpoint service, Listener listener) throws Exception {
        super(service.socketUri(), new Draft_6455(Collections.<IExtension>emptyList(), 65536), Collections.<String,String>emptyMap(), 10000);
        this.listener = listener; this.internet = true;
        // Normal platform certificate-chain validation; no invitation trust manager.
        setSocketFactory(SSLContext.getDefault().getSocketFactory());
        setConnectionLostTimeout(20);
    }
    @Override protected void onSetSSLParameters(SSLParameters parameters) {
        // Only a LAN room's ephemeral certificate uses its exact invitation
        // pin instead of a public DNS identity. Internet services always check
        // the normal CA chain and the selected hostname on this socket.
        parameters.setEndpointIdentificationAlgorithm(internet ? "HTTPS" : null);
        parameters.setProtocols(new String[]{"TLSv1.3", "TLSv1.2"});
    }
    @Override public void onOpen(ServerHandshake handshake) { listener.opened(); }
    @Override public void onMessage(String message) { if (message.length() <= 65536) listener.message(message); else cancel(); }
    @Override public void onClose(int code, String reason, boolean remote) { listener.closed(code, reason); }
    @Override public void onError(Exception error) { listener.failed(error); }
    public void cancel() {
        close();
        try { if (getSocket() != null) getSocket().close(); } catch (Exception ignored) { }
        closeConnection(1000, "Session closed");
    }
}
