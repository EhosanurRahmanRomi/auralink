package local.auralink.mobile;

import java.io.FileInputStream;
import java.security.cert.CertificateFactory;
import java.security.cert.X509Certificate;
import java.util.Properties;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;

/** Executes the APK's real, Android-independent invitation and pinned socket code. */
public final class AndroidSecurityHarness {
  private static int checks;
  private interface Operation { void run() throws Exception; }
  private static void check(boolean valid, String label) {
    if (!valid) throw new AssertionError(label);
    checks++;
  }
  private static void refuses(Operation operation, String label) throws Exception {
    try { operation.run(); } catch (Exception expected) { checks++; return; }
    throw new AssertionError(label);
  }
  private static X509Certificate certificate(String filename) throws Exception {
    try (FileInputStream input = new FileInputStream(filename)) {
      return (X509Certificate) CertificateFactory.getInstance("X.509").generateCertificate(input);
    }
  }
  private static void policies(Properties values) throws Exception {
    String link = values.getProperty("invitation");
    final String fp = values.getProperty("fingerprint");
    String key = values.getProperty("roomKey");
    Invitation invitation = Invitation.parse(link);
    check(invitation.origin.equals(values.getProperty("origin")), "Origin is canonical");
    check(invitation.roomKey.equals(key), "Room key remains in invitation data");
    check(invitation.fingerprint.equals(fp), "Exact leaf fingerprint is retained");
    check(invitation.matchesSocket(invitation.socketUri().toString()), "Current room WSS is accepted");
    String socket = invitation.socketUri().toString();
    final String fragment = "/#key=" + key + "&fp=" + fp;
    Invitation uppercase = Invitation.parse("HTTPS://EXAMPLE.COM:443/#key=" + key + "&fp=" + fp.toUpperCase(java.util.Locale.ROOT));
    check(uppercase.origin.equals("https://example.com") && uppercase.fingerprint.equals(fp), "Case and default port normalize");
    check(uppercase.matchesSocket("wss://example.com/ws"), "Normalized default port socket is accepted");
    Invitation ipv6 = Invitation.parse("https://[::1]:12345" + fragment);
    check(ipv6.origin.equals("https://[::1]:12345") && ipv6.matchesSocket("wss://[::1]:12345/ws"), "IPv6 endpoint normalizes safely");
    final String[] badInvites = {
      "http://127.0.0.1:443" + fragment,
      "file:///" + fragment,
      "https://user:password@127.0.0.1" + fragment,
      "https://127.0.0.1/other/#key=" + key + "&fp=" + fp,
      "https://127.0.0.1/?key=" + key + "#fp=" + fp,
      "https://127.0.0.1/#key=weak&fp=" + fp,
      "https://127.0.0.1/#key=" + key,
      "https://127.0.0.1/#key=" + key + "&fp=invalid",
      "https://127.0.0.1:70000" + fragment,
      "https://127.0.0.1:0" + fragment,
      "https://127.0.0.1/#key=" + key + "&fp=" + fp + "\n<script>",
      "https://127.0.0.1/#key=" + key + "&key=" + key + "&fp=" + fp,
      "https://127.0.0.1/#key=" + key + "&fp=" + fp + "&fp=" + fp,
    };
    for (final String invalid : badInvites) refuses(() -> Invitation.parse(invalid), "Malformed invitation is refused");
    check(!invitation.matchesSocket(socket.replace("wss:", "ws:")), "Cleartext websocket is refused");
    check(!invitation.matchesSocket(socket + "?key=" + key), "Socket query credentials are refused");
    check(!invitation.matchesSocket(socket + "#anything"), "Socket fragment is refused");
    check(!invitation.matchesSocket(socket.replace("/ws", "/other")), "Wrong socket path is refused");
    check(!invitation.matchesSocket("wss://different.example/ws"), "Different host is refused");
    check(!invitation.matchesSocket("wss://127.0.0.1:1/ws"), "Different port is refused");
    final X509Certificate valid = certificate(values.getProperty("validCertificate"));
    PinnedTls.verifyCertificate(valid, fp); checks++;
    refuses(() -> PinnedTls.verifyCertificate(valid, values.getProperty("otherFingerprint")), "Wrong leaf pin is refused");
    refuses(() -> PinnedTls.verifyCertificate(valid, null), "Missing leaf pin is refused");
    refuses(() -> PinnedTls.verifyCertificate(valid, "invalid"), "Malformed leaf pin is refused");
    final X509Certificate expired = certificate(values.getProperty("expiredCertificate"));
    refuses(() -> PinnedTls.verifyCertificate(expired, values.getProperty("expiredFingerprint")), "Expired leaf is refused even with correct pin");
    final X509Certificate future = certificate(values.getProperty("futureCertificate"));
    refuses(() -> PinnedTls.verifyCertificate(future, values.getProperty("futureFingerprint")), "Future leaf is refused even with correct pin");
    check(PinnedTls.context(invitation) != javax.net.ssl.SSLContext.getDefault(), "Pinned context is instance scoped");
    controlPolicies();
    System.out.println("POLICIES_PASS checks=" + checks);
  }
  private static void controlPolicies() {
    String peer = "room-peer-1234", session = "session-approved-1234";
    AttendedControlPolicy gate = new AttendedControlPolicy();
    check(!gate.grant(peer, "short", 0), "Short control sessions cannot be granted");
    check(!gate.grant("remote\npeer", session, 0), "Control identity rejects control characters");
    check(!gate.grant(peer, session, -1), "Negative control clock is refused");
    check(!gate.grant(peer, session, Long.MAX_VALUE), "Control clock overflow is refused");
    check(gate.grant(peer, session, 1000), "Owner can create a pending control grant");
    check(!gate.accepts(peer, session, 1, "down", 1001), "Native input is blocked before room confirmation");
    check(!gate.confirm("other-peer", session), "Another peer cannot confirm a control grant");
    check(!gate.confirm(peer, "different-session-1234"), "Another session cannot confirm a control grant");
    check(gate.confirm(peer, session), "Exact approved peer and session can confirm");
    check(!gate.accepts("other-peer", session, 1, "down", 1002), "Another peer cannot inject input");
    check(!gate.accepts(peer, "different-session-1234", 1, "down", 1002), "Another session cannot inject input");
    check(!gate.accepts(peer, session, 0, "down", 1002), "Input sequence must be positive");
    check(!gate.accepts(peer, session, 1, "shell", 1002), "Unsupported input operation is refused");
    check(gate.accepts(peer, session, 1, "down", 1002), "Bound control input is accepted");
    check(!gate.accepts(peer, session, 1, "move", 1003), "Duplicate input is refused");
    check(!gate.accepts(peer, session, 0, "move", 1003), "Old input is refused");
    check(gate.accepts(peer, session, 2, "up", 1003), "Monotonic release is accepted");
    check(!gate.accepts(peer, session, 3, "down", 1000 + AttendedControlPolicy.DURATION_MS), "Input is refused at the grant deadline");
    gate.revoke(); check(!gate.confirm(peer, session), "Revoked grant cannot be confirmed again");
    check(!gate.accepts(peer, session, 3, "move", 1004), "Revoked grant cannot inject input");
    check(gate.grant(peer, session, 2000) && gate.confirm(peer, session), "Owner can approve a fresh session");
    for (int index = 1; index <= 300; index++) check(gate.accepts(peer, session, index, "move", 2000), "Input budget accepts its bounded burst");
    check(!gate.accepts(peer, session, 301, "move", 2000), "Input burst is rate limited");
    check(gate.accepts(peer, session, 302, "up", 2000), "Button release remains possible after input budget exhaustion");
    check(gate.accepts(peer, session, 303, "keyup", 2000), "Key release remains possible after input budget exhaustion");
    check(gate.accepts(peer, session, 304, "move", 2010), "Input budget recovers with monotonic time");
    check(!AttendedControlPolicy.validSequence(1.5), "Fractional JSON sequence is refused");
    check(!AttendedControlPolicy.validSequence("1"), "String JSON sequence is refused");
    check(!AttendedControlPolicy.validSequence(Double.NaN), "NaN sequence is refused");
    check(!AttendedControlPolicy.validSequence(Double.POSITIVE_INFINITY), "Infinite sequence is refused");
    check(!AttendedControlPolicy.validSequence(9007199254740992d), "Unsafe JSON integer sequence is refused");
    check(AttendedControlPolicy.validSequence(9007199254740991d), "Largest safe JSON sequence is accepted");
  }
  private static void socket(Properties values, boolean shouldOpen) throws Exception {
    Invitation invitation = Invitation.parse(values.getProperty("invitation"));
    CountDownLatch finished = new CountDownLatch(1);
    AtomicBoolean opened = new AtomicBoolean(false);
    AtomicBoolean pending = new AtomicBoolean(false);
    AtomicBoolean welcome = new AtomicBoolean(false);
    AtomicReference<Exception> failure = new AtomicReference<>();
    AtomicReference<PinnedRoomClient> current = new AtomicReference<>();
    PinnedRoomClient client = new PinnedRoomClient(invitation, new PinnedRoomClient.Listener() {
      @Override public void opened() {
        opened.set(true);
        current.get().send("{\"type\":\"join\",\"name\":\"Android JVM security fixture\",\"roomKey\":\"" + invitation.roomKey + "\"}");
      }
      @Override public void message(String message) {
        if (message.contains("\"type\":\"pending\"")) pending.set(true);
        if (message.contains("\"type\":\"welcome\"")) { welcome.set(true); finished.countDown(); }
      }
      @Override public void closed(int code, String reason) { finished.countDown(); }
      @Override public void failed(Exception error) { failure.set(error); finished.countDown(); }
    });
    current.set(client);
    client.connect();
    try {
      check(finished.await(15, TimeUnit.SECONDS), "Socket completed within deadline");
      if (shouldOpen) {
        check(opened.get(), "Pinned TLS opened");
        check(pending.get(), "Guest awaited owner admission");
        check(welcome.get(), "Host approval delivered through real native WSS client");
        check(failure.get() == null, "No native transport error");
        System.out.println("SOCKET_JOIN_PASS pending=true welcome=true");
      } else {
        check(!opened.get(), "Mismatched certificate never opened a socket");
        check(!pending.get() && !welcome.get(), "No join data crossed an untrusted TLS connection");
        check(failure.get() != null, "TLS refusal was reported");
        System.out.println("SOCKET_REFUSAL_PASS opened=false join=false");
      }
    } finally {
      client.closeConnection(1000, "Fixture finished");
      if (client.getSocket() != null) client.getSocket().close();
    }
  }
  public static void main(String[] args) throws Exception {
    Properties values = new Properties();
    try (FileInputStream input = new FileInputStream(args[1])) { values.load(input); }
    switch (args[0]) {
      case "policies": policies(values); break;
      case "join": socket(values, true); break;
      case "refuse": socket(values, false); break;
      default: throw new IllegalArgumentException("Unknown test mode");
    }
  }
}
