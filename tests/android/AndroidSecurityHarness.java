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
    internetPolicies(invitation);
    membershipPolicies();
    relayPolicies();
    appInvitationPolicies();
    controlPolicies();
    System.out.println("POLICIES_PASS checks=" + checks);
  }
  private static void internetPolicies(Invitation lan) throws Exception {
    InternetServiceEndpoint endpoint = InternetServiceEndpoint.parse("HTTPS://SERVICE.EXAMPLE:443/");
    check(endpoint.origin.equals("https://service.example"), "Internet origin canonicalizes independently of LAN invitation");
    check(endpoint.matchesSocket("wss://service.example/internet/ws"), "Internet socket uses its separate exact endpoint");
    check(!endpoint.matchesSocket("wss://service.example/ws"), "Internet service cannot become a LAN room socket");
    check(!lan.matchesSocket(lan.origin.replace("https:", "wss:") + "/internet/ws"), "LAN pin cannot authorize Internet endpoint");
    for (final String invalid : new String[]{"http://service.example", "file:///", "https://user:pass@service.example", "https://service.example/path",
      "https://service.example/a/..", "https://service.example/?", "https://service.example/#", "https://service.example/?token=secret",
      "https://service.example/#fp=anything", "https://service.example:0", "https://service.example:70000", "https://service.example\n"})
      refuses(() -> InternetServiceEndpoint.parse(invalid), "Internet origin rejects non-root, unsafe or credential-bearing address");
    for (String invalid : new String[]{"ws://service.example/internet/ws", "wss://other.example/internet/ws", "wss://service.example:1234/internet/ws",
      "wss://service.example/internet/ws?", "wss://service.example/internet/ws#", "wss://user:pass@service.example/internet/ws", "wss://service.example/internet/other"})
      check(!endpoint.matchesSocket(invalid), "Only the verified Internet origin and exact socket path are authorized");
    PinnedRoomClient.Listener noop = new PinnedRoomClient.Listener() {
      public void opened() {} public void message(String value) {} public void closed(int code, String reason) {} public void failed(Exception error) {}
    };
    javax.net.ssl.SSLParameters internet = new javax.net.ssl.SSLParameters();
    new PinnedRoomClient(endpoint, noop).onSetSSLParameters(internet);
    check("HTTPS".equals(internet.getEndpointIdentificationAlgorithm()), "Internet WSS requires HTTPS hostname validation");
    javax.net.ssl.SSLParameters pinned = new javax.net.ssl.SSLParameters();
    new PinnedRoomClient(lan, noop).onSetSSLParameters(pinned);
    check(pinned.getEndpointIdentificationAlgorithm() == null, "LAN pin verification remains separately scoped");
  }
  private static void membershipPolicies() throws Exception {
    RoomMembership membership = new RoomMembership();
    String owner = "owner-123", controller = "controller-456";
    check(!membership.hasRoom() && !membership.allows(controller), "Directory connection alone authorizes no native room access");
    check(!membership.add(controller), "Peer traffic before authenticated room welcome cannot admit a controller");
    check(membership.begin(owner, java.util.Arrays.asList(controller)), "Authenticated room welcome admits the listed controller");
    check(membership.hasRoom() && membership.allows(controller), "Welcome grants room membership only");
    long firstRoom = membership.epoch();
    check(!membership.endForEvent("registered") && membership.allows(controller), "Directory events do not grant or remove room privileges");
    check(membership.endForEvent("room-left"), "Internet room-left is an authoritative exit event");
    check(!membership.hasRoom() && membership.selfId() == null && !membership.allows(controller), "Room-left clears native membership even while directory socket remains connected");
    check(membership.epoch() != firstRoom, "Room-left invalidates pending media and capture callback epochs without replacing the directory socket");
    check(!membership.add(controller), "Stale peer-joined after leaving cannot restore room membership");
    check(membership.begin(owner, java.util.Arrays.asList(controller)) && membership.endForEvent("room-ended") && !membership.allows(controller), "Room-ended removes native authorization");
    check(membership.begin(owner, java.util.Arrays.asList(controller)) && membership.endForEvent("rejected") && !membership.allows(controller), "Rejected admission removes native authorization");
    check(!membership.begin("invalid\nowner", java.util.Arrays.asList(controller)) && !membership.hasRoom(), "Malformed room identity fails closed");
    check(!membership.begin(owner, java.util.Arrays.asList(controller, controller)) && !membership.hasRoom(), "Duplicate admitted identities fail closed");
    check(membership.begin(owner, java.util.Arrays.asList(controller)), "A fresh authenticated welcome may admit a new room");
    membership.remove(controller); check(!membership.allows(controller), "Peer departure immediately removes admission");
    membership.clear(); check(!membership.hasRoom(), "Transport closure clears native room membership");
    for (String operation : java.util.Arrays.asList("leave", "join", "join-device", "create-room", "forget")) {
      check(membership.begin(owner, java.util.Arrays.asList(controller)), "Fresh welcome restores owner-approved room admission");
      long oldRoom = membership.epoch();
      check(membership.endForOutbound(operation) && !membership.hasRoom() && !membership.allows(controller) && membership.epoch() != oldRoom,
        "Outgoing room transition invalidates native admission and old media epoch before a network response");
    }
    check(!membership.endForOutbound("register") && !membership.hasRoom(), "Directory registration cannot grant native room authorization");
    check(!membership.acceptsWelcome(owner, "room-123"), "Unrequested Internet welcome cannot authorize room membership");
    check(membership.expectAdmission("room-123", false), "An explicit Internet room join awaits only that room");
    check(!membership.acceptsWelcome(owner, "other-room"), "Internet welcome cannot substitute an unrelated room");
    check(membership.observePending(owner, "room-123"), "Authenticated pending event binds this join to the assigned identity");
    check(!membership.acceptsWelcome(controller, "room-123"), "Internet welcome cannot substitute a different pending identity");
    check(membership.acceptsWelcome(owner, "room-123") && membership.begin(owner, java.util.Arrays.asList(controller)), "The expected authenticated welcome grants membership once");
    check(!membership.acceptsWelcome(owner, "room-123"), "A duplicate Internet welcome cannot recreate native room state");
    check(membership.expectAdmission(null, true) && membership.observePending(owner, "device-room"), "Device joins learn the exact room from authenticated pending admission");
    check(!membership.observePending(controller, "device-room") && !membership.acceptsWelcome(owner, "other-room"), "A pending device join cannot replace its assigned identity or room");
    check(membership.endForOutbound("leave") && !membership.acceptsWelcome(owner, "device-room"), "Leave before admission prevents a late welcome from resurrecting membership");
    check(!membership.expectAdmission("invalid\nroom", false) && !membership.acceptsWelcome(owner, "room-123"), "Malformed explicit room join fails closed");
    projectionOwnershipPolicies();
  }
  private static void projectionOwnershipPolicies() throws Exception {
    check(ScreenCaptureQuality.maxEdge("720p")==1280 && ScreenCaptureQuality.maxEdge("1080p")==1920,"Phone capture exposes only its supported resolution ceilings");
    for(final String quality:new String[]{null,"auto","480p","1440p","1080"," 720p","720P"})
      refuses(()->ScreenCaptureQuality.maxEdge(quality),"Unsupported or malformed capture quality is rejected");
    check(java.util.Arrays.equals(ScreenCaptureQuality.dimensions(1080,1920,1280),new int[]{720,1280}),"Portrait capture scales to actual 720p output dimensions");
    check(java.util.Arrays.equals(ScreenCaptureQuality.dimensions(1080,1920,1920),new int[]{1080,1920}),"Portrait 1080p retains native pixels");
    check(java.util.Arrays.equals(ScreenCaptureQuality.dimensions(1920,1080,1280),new int[]{1280,720}),"Landscape capture keeps its orientation and aspect ratio");
    check(java.util.Arrays.equals(ScreenCaptureQuality.dimensions(720,1280,1920),new int[]{720,1280}),"Selecting a higher ceiling never upscales a smaller display");
    int[] odd=ScreenCaptureQuality.dimensions(1081,1921,1280);
    check(odd[0]%2==0 && odd[1]%2==0 && Math.max(odd[0],odd[1])<=1280,"Scaled image dimensions stay even and within the selected bound");
    for(final int[] invalid:new int[][]{{0,1920,1280},{1080,-1,1920},{32769,1920,1280},{1080,1920,2560}})
      refuses(()->ScreenCaptureQuality.dimensions(invalid[0],invalid[1],invalid[2]),"Malformed source geometry or ceiling is rejected");
    ProjectionOwnership ownership = new ProjectionOwnership();
    String oldTicket = "old-owner-consent", replacement = "new-owner-consent";
    ownership.prepare(oldTicket);
    ownership.prepare(replacement);
    check(!ownership.claim(oldTicket) && ownership.pendingMatches(replacement), "Delayed old service intent cannot claim a replacement owner consent");
    check(!ownership.cancelPending(oldTicket) && ownership.pendingMatches(replacement), "Old permission cleanup cannot cancel a replacement pending ticket");
    check(ownership.claim(replacement) && ownership.activeMatches(replacement), "Exact pending owner ticket can start its projection");
    check(!ownership.claim(oldTicket) && !ownership.release(oldTicket) && ownership.activeMatches(replacement), "Old intent and teardown cannot stop an active replacement projection");
    check(!ownership.claim(replacement), "Duplicate start intent cannot restart an active projection");
    ownership.prepare(oldTicket);
    check(!ownership.claim(oldTicket) && ownership.pendingMatches(oldTicket), "A live projection cannot consume a second owner consent");
    check(ownership.release(replacement) && ownership.pendingMatches(oldTicket), "Stopping the active projection preserves a different pending consent");
    check(ownership.claim(oldTicket) && ownership.activeMatches(oldTicket), "Replacement consent can claim only after the old projection releases ownership");
    check(!ownership.release(replacement) && ownership.activeMatches(oldTicket), "Delayed prior teardown cannot release the newly started projection");
    check(ownership.release(oldTicket) && !ownership.activeMatches(oldTicket), "Owner stop releases exact active capture ownership");
  }
  private static void relayPolicies() {
    String epoch = java.util.Base64.getUrlEncoder().withoutPadding().encodeToString(new byte[12]);
    String small = java.util.Base64.getUrlEncoder().withoutPadding().encodeToString(new byte[16]);
    String maximum = java.util.Base64.getUrlEncoder().withoutPadding().encodeToString(new byte[180000]);
    check(RelayMediaPolicy.valid(5, 1, epoch, 1, epoch, small), "Smallest encrypted media envelope is accepted");
    check(RelayMediaPolicy.valid(5, 1, epoch, 9007199254740991d, epoch, maximum), "Largest bounded encrypted frame and safe counter are accepted");
    check(!RelayMediaPolicy.valid(6, 1, epoch, 1, epoch, small), "Additional encrypted envelope fields are rejected");
    check(!RelayMediaPolicy.valid(4, 1, epoch, 1, epoch, small), "Missing encrypted envelope fields are rejected");
    check(!RelayMediaPolicy.valid(5, 2, epoch, 1, epoch, small), "Unknown encrypted media version is rejected");
    for (double counter : new double[] {0, -1, 1.5, Double.NaN, Double.POSITIVE_INFINITY, 9007199254740992d})
      check(!RelayMediaPolicy.valid(5, 1, epoch, counter, epoch, small), "Nonpositive, fractional and unsafe counters are rejected");
    check(!RelayMediaPolicy.valid(5, 1, epoch + "A", 1, epoch, small), "Malformed encrypted stream epoch is rejected");
    check(!RelayMediaPolicy.valid(5, 1, epoch, 1, epoch.substring(1), small), "Malformed encrypted nonce is rejected");
    check(!RelayMediaPolicy.valid(5, 1, epoch, 1, epoch, small.substring(1)), "Ciphertext smaller than an authentication tag is rejected");
    check(!RelayMediaPolicy.valid(5, 1, epoch, 1, epoch, maximum + "AA"), "Oversized encrypted frame is rejected before decoding");
    check(!RelayMediaPolicy.valid(5, 1, epoch, 1, epoch, small + "="), "Padded noncanonical ciphertext is rejected");
    check(!RelayMediaPolicy.valid(5, 1, epoch, 1, epoch, small.substring(0, small.length() - 1) + "B"), "Noncanonical trailing ciphertext bits are rejected");
    check(RelayMediaPolicy.validKey(java.util.Base64.getUrlEncoder().withoutPadding().encodeToString(new byte[32])), "Exact 32-byte admitted room key is accepted");
    check(!RelayMediaPolicy.validKey(small), "Undersized admitted room key is rejected");
    check(RelayMediaPolicy.SIGNAL_LIMIT == 65536 && RelayMediaPolicy.WIRE_LIMIT == 262144, "Only encrypted Internet media has a larger transport limit");
  }
  private static void appInvitationPolicies() throws Exception {
    final String key = java.util.Base64.getUrlEncoder().withoutPadding().encodeToString(new byte[32]);
    final String code = "A1.550e8400-e29b-41d4-a716-446655440000." + key;
    final String link = "auralink://join#code=" + code;
    check(AppInvitation.parse(link).equals(code), "An external app link supplies only its exact room capability");
    for (final String invalid : new String[] {
      "https://join#code=" + code, "auralink://other#code=" + code, "auralink://user@join#code=" + code,
      "auralink://join:443#code=" + code, "auralink://join/#code=" + code, "auralink://join?other=1#code=" + code,
      link + "&extra=1", link + "\n", "auralink://join#code=" + code.replace("A1.", "A1%2e"),
      "auralink://join#code=" + code.replace("550e8400-e29b-41d4-a716-446655440000", "invalid-room"),
      "auralink://join#code=" + code.substring(0, code.length() - 1) + "B", "auralink://join#code="
    }) refuses(() -> AppInvitation.parse(invalid), "Malformed external app link cannot change the current room");
    refuses(() -> AppInvitation.parse(null), "Missing external app link is rejected");
  }
  private static void internetSocket(Properties values, boolean shouldOpen) throws Exception {
    InternetServiceEndpoint endpoint = InternetServiceEndpoint.parse(values.getProperty("service"));
    CountDownLatch finished = new CountDownLatch(1);
    AtomicBoolean opened = new AtomicBoolean(false), registered = new AtomicBoolean(false);
    AtomicReference<Exception> failure = new AtomicReference<>();
    AtomicReference<PinnedRoomClient> current = new AtomicReference<>();
    PinnedRoomClient client = new PinnedRoomClient(endpoint, new PinnedRoomClient.Listener() {
      public void opened() { opened.set(true); current.get().send("{\"type\":\"register\",\"deviceToken\":\"test-only-credential\"}"); }
      public void message(String message) { if (message.contains("\"type\":\"registered\"")) { registered.set(true); finished.countDown(); } }
      public void closed(int code, String reason) { finished.countDown(); }
      public void failed(Exception error) { failure.set(error); finished.countDown(); }
    });
    current.set(client); client.connect();
    try {
      check(finished.await(15, TimeUnit.SECONDS), "Internet socket completed within deadline");
      if (shouldOpen) {
        check(opened.get() && registered.get() && failure.get() == null, "System CA plus matching hostname permits Internet registration");
        System.out.println("INTERNET_SOCKET_PASS systemPKI=true registered=true");
      } else {
        check(!opened.get() && !registered.get() && failure.get() != null, "Untrusted chain or mismatched hostname cannot send registration credentials");
        System.out.println("INTERNET_REFUSAL_PASS opened=false registration=false");
      }
    } finally { client.cancel(); }
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
      case "internet-join": internetSocket(values, true); break;
      case "internet-refuse": internetSocket(values, false); break;
      default: throw new IllegalArgumentException("Unknown test mode");
    }
  }
}
