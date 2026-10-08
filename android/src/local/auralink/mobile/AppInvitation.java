package local.auralink.mobile;

/** External links supply only a room capability; they never grant device access. */
public final class AppInvitation {
    private static final String PREFIX = "auralink://join#code=";
    private AppInvitation() { }
    public static String parse(String raw) {
        if (raw == null || raw.length() > 2048 || !raw.startsWith(PREFIX)) throw new IllegalArgumentException("Invalid Glance-Port invitation.");
        String code = raw.substring(PREFIX.length());
        if (!code.matches("A1\\.[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\\.[A-Za-z0-9_-]{43}") ||
            !RelayMediaPolicy.validKey(code.substring(code.lastIndexOf('.') + 1))) throw new IllegalArgumentException("Invalid Glance-Port room code.");
        return code;
    }
}
