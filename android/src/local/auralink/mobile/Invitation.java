package local.auralink.mobile;

import java.net.URI;
import java.net.URLDecoder;
import java.util.HashMap;
import java.util.Map;

/** A room invitation authenticates one exact host certificate, not a global CA. */
public final class Invitation {
    public final String origin, roomKey, fingerprint;
    private final String host;
    private final int port;
    private Invitation(String origin, String host, int port, String key, String pin) {
        this.origin = origin; this.host = host; this.port = port; roomKey = key; fingerprint = pin;
    }
    public static Invitation parse(String value) throws Exception {
        if (value == null || value.length() > 4096 || value.matches("(?s).*[^\\x20-\\x7e].*"))
            throw new IllegalArgumentException("Paste a complete HTTPS room invitation.");
        URI uri = new URI(value.trim());
        if (!"https".equalsIgnoreCase(uri.getScheme()) || uri.getHost() == null || uri.getUserInfo() != null ||
            uri.getRawQuery() != null || !(uri.getRawPath().isEmpty() || "/".equals(uri.getRawPath())))
            throw new IllegalArgumentException("Invitation must use HTTPS and a room root address.");
        int port = uri.getPort() == -1 ? 443 : uri.getPort();
        if (port < 1 || port > 65535 || uri.getRawFragment() == null) throw new IllegalArgumentException("Invalid room address.");
        Map<String,String> values = new HashMap<>();
        for (String part : uri.getRawFragment().split("&")) {
            String[] pair = part.split("=", 2);
            if (pair.length != 2) throw new IllegalArgumentException("Invalid invitation fields.");
            String key = URLDecoder.decode(pair[0], "UTF-8");
            if (values.put(key, URLDecoder.decode(pair[1], "UTF-8")) != null) throw new IllegalArgumentException("Duplicate invitation field.");
        }
        String key = values.get("key"), pin = values.get("fp");
        if (key == null || !key.matches("[A-Za-z0-9_-]{32,128}") || pin == null || !pin.matches("[A-Fa-f0-9]{64}"))
            throw new IllegalArgumentException("The room key or certificate fingerprint is missing.");
        String normalizedHost = uri.getHost().toLowerCase(java.util.Locale.ROOT);
        String origin = new URI("https", null, normalizedHost, port == 443 ? -1 : port, "", null, null).toString();
        return new Invitation(origin, normalizedHost, port, key, pin.toLowerCase(java.util.Locale.ROOT));
    }
    public URI socketUri() throws Exception { return new URI(origin.replaceFirst("^https:", "wss:") + "/ws"); }
    public boolean matchesSocket(String value) {
        try { return socketUri().equals(new URI(value)); } catch (Exception ignored) { return false; }
    }
    public boolean matchesHost(String name) { return host.equalsIgnoreCase(name); }
}
