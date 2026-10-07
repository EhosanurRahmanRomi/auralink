package local.auralink.mobile;

import java.net.URI;
import java.util.Locale;

/** Public signaling uses the system CA store and DNS identity, never a LAN pin. */
public final class InternetServiceEndpoint {
    public final String origin;
    private InternetServiceEndpoint(String origin) { this.origin = origin; }
    public static InternetServiceEndpoint parse(String value) throws Exception {
        if (value == null || value.length() > 2048 || value.matches("(?s).*[^\\x20-\\x7e].*"))
            throw new IllegalArgumentException("Enter the Internet service's HTTPS root address.");
        URI uri = new URI(value.trim());
        if (!"https".equalsIgnoreCase(uri.getScheme()) || uri.getHost() == null || uri.getUserInfo() != null ||
            uri.getRawQuery() != null || uri.getRawFragment() != null ||
            !(uri.getRawPath().isEmpty() || "/".equals(uri.getRawPath())))
            throw new IllegalArgumentException("Internet service must use HTTPS without a path, credentials, query or fragment.");
        int port = uri.getPort() == -1 ? 443 : uri.getPort();
        if (port < 1 || port > 65535) throw new IllegalArgumentException("Invalid Internet service port.");
        String origin = new URI("https", null, uri.getHost().toLowerCase(Locale.ROOT), port == 443 ? -1 : port, "", null, null).toString();
        return new InternetServiceEndpoint(origin);
    }
    public URI socketUri() throws Exception { return new URI(origin.replaceFirst("^https:", "wss:") + "/internet/ws"); }
    public boolean matchesSocket(String value) {
        try { return socketUri().equals(new URI(value)); } catch (Exception ignored) { return false; }
    }
}
