package io.github._77web.e2eswing.agent;

import java.awt.Component;
import java.awt.Dimension;
import java.awt.Point;
import java.awt.Window;
import java.lang.reflect.InvocationTargetException;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.atomic.AtomicReference;
import javax.accessibility.Accessible;
import javax.accessibility.AccessibleComponent;
import javax.accessibility.AccessibleContext;
import javax.accessibility.AccessibleRole;
import javax.accessibility.AccessibleState;
import javax.accessibility.AccessibleValue;
import javax.swing.JLabel;
import javax.swing.JPasswordField;
import javax.swing.SwingUtilities;
import javax.swing.text.JTextComponent;

/**
 * Reads the showing windows as a tree of plain maps and lists, ready for {@link Json#write}.
 *
 * <p>This reports facts only: raw accessible roles and class names. Mapping roles to the engine
 * contract and pruning nodes belong to the TypeScript side.
 */
final class Snapshot {
    /**
     * Role and state names must not depend on the JVM's locale. {@code Locale.ROOT} is used instead
     * of {@code Locale.ENGLISH} because a resource bundle lookup for a locale it has no bundle for
     * falls back to the default locale, not to the base bundle.
     */
    private static final Locale NAMES_LOCALE = Locale.ROOT;

    private Snapshot() {
    }

    /**
     * Reads the tree on the event dispatch thread and waits for the result. Must not be called on
     * that thread. A modal dialog keeps dispatching events, so this returns while one is open.
     */
    static Map<String, Object> capture() throws InterruptedException, InvocationTargetException {
        var result = new AtomicReference<Map<String, Object>>();
        SwingUtilities.invokeAndWait(() -> result.set(readWindows()));
        return result.get();
    }

    private static Map<String, Object> readWindows() {
        NodeIds.startSnapshot();
        var windows = new ArrayList<Object>();
        for (Window window : Window.getWindows()) {
            if (window.isShowing()) {
                addNode(windows, window);
            }
        }
        var result = new LinkedHashMap<String, Object>();
        result.put("windows", windows);
        return result;
    }

    private static void addNode(List<Object> nodes, Accessible accessible) {
        AccessibleContext context = accessible.getAccessibleContext();
        if (context != null) {
            nodes.add(readNode(accessible, context));
        }
    }

    private static Map<String, Object> readNode(Accessible accessible, AccessibleContext context) {
        var node = new LinkedHashMap<String, Object>();
        node.put("id", NodeIds.idOf(accessible));
        AccessibleRole role = context.getAccessibleRole();
        if (role != null) {
            node.put("role", role.toDisplayString(NAMES_LOCALE));
        }
        putIfPresent(node, "name", context.getAccessibleName());
        if (accessible instanceof Component component) {
            putIfPresent(node, "testId", component.getName());
        }
        node.put("className", accessible.getClass().getName());
        putIfPresent(node, "rect", readRect(context.getAccessibleComponent()));
        node.put("states", readStates(context));

        if (isSecure(accessible, role)) {
            node.put("secure", true);
        } else {
            putIfPresent(node, "text", readText(accessible));
            putIfPresent(node, "value", readValue(context.getAccessibleValue()));
        }

        var children = new ArrayList<Object>();
        for (int i = 0; i < context.getAccessibleChildrenCount(); i++) {
            Accessible child = context.getAccessibleChild(i);
            if (child != null) {
                addNode(children, child);
            }
        }
        node.put("children", children);
        return node;
    }

    /** A secure node's text and value are never read, so they cannot reach the output. */
    private static boolean isSecure(Accessible accessible, AccessibleRole role) {
        return accessible instanceof JPasswordField || AccessibleRole.PASSWORD_TEXT.equals(role);
    }

    /**
     * Reads the text from the component. {@code AccessibleText} has no whole-text getter, and the
     * accessible name can differ: the status label is named "Status" whatever it displays.
     */
    private static String readText(Accessible accessible) {
        if (accessible instanceof JTextComponent textComponent) {
            return textComponent.getText();
        }
        if (accessible instanceof JLabel label) {
            return label.getText();
        }
        return null;
    }

    private static Number readValue(AccessibleValue value) {
        return value == null ? null : value.getCurrentAccessibleValue();
    }

    /** Returns screen coordinates, or null when the node has no position, such as when hidden. */
    private static Map<String, Object> readRect(AccessibleComponent component) {
        if (component == null) {
            return null;
        }
        Point location = component.getLocationOnScreen();
        Dimension size = component.getSize();
        if (location == null || size == null) {
            return null;
        }
        var rect = new LinkedHashMap<String, Object>();
        rect.put("x", location.x);
        rect.put("y", location.y);
        rect.put("width", size.width);
        rect.put("height", size.height);
        return rect;
    }

    private static List<Object> readStates(AccessibleContext context) {
        var states = new ArrayList<Object>();
        if (context.getAccessibleStateSet() != null) {
            for (AccessibleState state : context.getAccessibleStateSet().toArray()) {
                states.add(state.toDisplayString(NAMES_LOCALE));
            }
        }
        return states;
    }

    private static void putIfPresent(Map<String, Object> node, String key, Object value) {
        if (value != null) {
            node.put(key, value);
        }
    }
}
