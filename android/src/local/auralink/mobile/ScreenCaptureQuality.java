package local.auralink.mobile;

/** The phone's supported resolution ceilings, without upscaling captured content. */
final class ScreenCaptureQuality {
    static int maxEdge(String quality) {
        if ("720p".equals(quality)) return 1280;
        if ("1080p".equals(quality)) return 1920;
        throw new IllegalArgumentException("Phone sharing supports 720p or 1080p.");
    }
    static int[] dimensions(int width, int height, int maxEdge) {
        if (width < 1 || height < 1 || width > 32768 || height > 32768 || (maxEdge != 1280 && maxEdge != 1920))
            throw new IllegalArgumentException("Invalid phone screen dimensions or quality.");
        float scale = Math.min(1f, maxEdge / (float)Math.max(width, height));
        return new int[]{Math.max(2, Math.round(width * scale) / 2 * 2), Math.max(2, Math.round(height * scale) / 2 * 2)};
    }
}
