package local.auralink.qa;

import android.accessibilityservice.AccessibilityServiceInfo;
import android.app.Activity;
import android.app.Instrumentation;
import android.app.UiAutomation;
import android.graphics.Rect;
import android.os.Bundle;
import android.os.SystemClock;
import android.util.Xml;
import android.view.accessibility.AccessibilityNodeInfo;
import android.view.accessibility.AccessibilityWindowInfo;
import org.xmlpull.v1.XmlSerializer;
import java.io.File;
import java.io.FileOutputStream;
import java.util.List;

/** Isolated test observer. Never connects with the default service-suppressing flags. */
public final class HierarchyInstrumentation extends Instrumentation {
    private static final int MAX_NODES = 20000;
    private static final int MAX_DEPTH = 128;
    private int nodeCount;

    @Override public void onCreate(Bundle arguments) { super.onCreate(arguments); start(); }

    @Override public void onStart() {
        Bundle result = new Bundle();
        File destination = new File(getContext().getFilesDir(), "hierarchy.xml");
        File temporary = new File(getContext().getFilesDir(), "hierarchy.tmp");
        // A failed invocation must not expose a previous successful snapshot.
        destination.delete(); temporary.delete();
        try {
            UiAutomation automation = getUiAutomation(UiAutomation.FLAG_DONT_SUPPRESS_ACCESSIBILITY_SERVICES);
            if (automation == null) throw new IllegalStateException("UiAutomation unavailable");
            AccessibilityServiceInfo info = automation.getServiceInfo();
            info.flags |= AccessibilityServiceInfo.FLAG_RETRIEVE_INTERACTIVE_WINDOWS | AccessibilityServiceInfo.FLAG_REPORT_VIEW_IDS;
            info.flags &= ~AccessibilityServiceInfo.FLAG_INCLUDE_NOT_IMPORTANT_VIEWS;
            automation.setServiceInfo(info);
            // A video call need not become idle. Wait only for nonempty window
            // roots, then serialize actual current nodes without interacting.
            long deadline = SystemClock.uptimeMillis() + 5000;
            List<AccessibilityWindowInfo> windows;
            do {
                windows = automation.getWindows();
                if (windows != null && !windows.isEmpty()) break;
                SystemClock.sleep(100);
            } while (SystemClock.uptimeMillis() < deadline);
            try (FileOutputStream stream = new FileOutputStream(temporary)) {
                XmlSerializer xml = Xml.newSerializer(); xml.setOutput(stream, "UTF-8");
                xml.startDocument("UTF-8", true); xml.startTag(null, "hierarchy");
                xml.attribute(null, "observation-flags", "dont-suppress-accessibility-services");
                if (windows != null) {
                    for (AccessibilityWindowInfo window : windows) {
                        try {
                            AccessibilityNodeInfo root = window.getRoot();
                            if (root == null) continue;
                            xml.startTag(null, "window");
                            xml.attribute(null, "id", Integer.toString(window.getId()));
                            xml.attribute(null, "type", Integer.toString(window.getType()));
                            writeNode(xml, root, 0, 0); xml.endTag(null, "window");
                        } finally { window.recycle(); }
                    }
                }
                if (nodeCount == 0) {
                    AccessibilityNodeInfo root = automation.getRootInActiveWindow();
                    if (root != null) writeNode(xml, root, 0, 0);
                }
                if (nodeCount == 0) throw new IllegalStateException("No accessible window roots");
                xml.endTag(null, "hierarchy"); xml.endDocument(); stream.getFD().sync();
            }
            if (!temporary.renameTo(destination)) throw new IllegalStateException("Snapshot replacement failed");
            result.putString("qa_hierarchy", "ok");
            result.putString("output", "files/hierarchy.xml");
            result.putInt("nodes", nodeCount);
            result.putBoolean("accessibility_services_preserved", true);
            finish(Activity.RESULT_OK, result);
        } catch (Exception failure) {
            temporary.delete(); destination.delete();
            // Never put UI text, invitations or raw exception messages in CI logs.
            result.putString("qa_hierarchy", "failed");
            result.putString("failure_type", failure.getClass().getSimpleName());
            finish(Activity.RESULT_CANCELED, result);
        }
    }

    private void writeNode(XmlSerializer xml, AccessibilityNodeInfo node, int index, int depth) throws Exception {
        try {
            if (depth > MAX_DEPTH || ++nodeCount > MAX_NODES) throw new IllegalStateException("Hierarchy exceeds observer bounds");
            xml.startTag(null, "node");
            attribute(xml, "index", Integer.toString(index));
            attribute(xml, "text", node.getText());
            attribute(xml, "resource-id", node.getViewIdResourceName());
            attribute(xml, "class", node.getClassName());
            attribute(xml, "package", node.getPackageName());
            attribute(xml, "content-desc", node.getContentDescription());
            attribute(xml, "checkable", Boolean.toString(node.isCheckable()));
            attribute(xml, "checked", Boolean.toString(node.isChecked()));
            attribute(xml, "clickable", Boolean.toString(node.isClickable()));
            attribute(xml, "enabled", Boolean.toString(node.isEnabled()));
            attribute(xml, "focusable", Boolean.toString(node.isFocusable()));
            attribute(xml, "focused", Boolean.toString(node.isFocused()));
            attribute(xml, "scrollable", Boolean.toString(node.isScrollable()));
            attribute(xml, "long-clickable", Boolean.toString(node.isLongClickable()));
            attribute(xml, "password", Boolean.toString(node.isPassword()));
            attribute(xml, "selected", Boolean.toString(node.isSelected()));
            attribute(xml, "visible-to-user", Boolean.toString(node.isVisibleToUser()));
            Rect bounds = new Rect(); node.getBoundsInScreen(bounds);
            attribute(xml, "bounds", bounds.toShortString());
            for (int childIndex = 0; childIndex < node.getChildCount(); childIndex++) {
                AccessibilityNodeInfo child = node.getChild(childIndex);
                if (child != null && child.isVisibleToUser()) writeNode(xml, child, childIndex, depth + 1);
                else if (child != null) child.recycle();
            }
            xml.endTag(null, "node");
        } finally { node.recycle(); }
    }

    private void attribute(XmlSerializer xml, String name, CharSequence value) throws Exception {
        String text = value == null ? "" : value.toString();
        StringBuilder clean = new StringBuilder();
        for (int offset = 0; offset < text.length();) {
            int code = text.codePointAt(offset); offset += Character.charCount(code);
            if (code == 9 || code == 10 || code == 13 || code >= 0x20 && code <= 0xd7ff ||
                code >= 0xe000 && code <= 0xfffd || code >= 0x10000 && code <= 0x10ffff) clean.appendCodePoint(code);
            else clean.append('\ufffd');
        }
        xml.attribute(null, name, clean.toString());
    }
}
