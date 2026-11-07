package dev.e2e.swing.agent;

import java.awt.Component;
import java.awt.Dialog;
import java.awt.EventQueue;
import java.awt.Toolkit;
import java.awt.Window;
import java.awt.event.InputEvent;
import java.awt.event.MouseEvent;
import java.lang.reflect.InvocationTargetException;
import java.util.concurrent.atomic.AtomicReference;
import javax.accessibility.Accessible;
import javax.swing.SwingUtilities;
import javax.swing.text.JTextComponent;

/**
 * Runs one action on a node from the newest snapshot.
 *
 * <p>An action may open a modal dialog, and a modal dialog does not return control until it closes.
 * So the action never runs inside {@code invokeAndWait}: it is queued, and then an empty
 * {@code invokeAndWait} waits for the queue to reach it. A modal dialog keeps processing the queue,
 * so that wait ends even while the dialog is open.
 *
 * <p>The value of a {@code fill} may be a password. It must not appear in any message or log.
 */
final class Perform {
    static final int INVALID_PARAMS = -32602;
    /** The node is gone or no longer showing. Finding it again may succeed. */
    static final int NODE_STALE = -32001;
    /** The node exists but cannot take the action now: disabled, read-only, or behind a modal dialog. */
    static final int NOT_ACTIONABLE = -32002;
    /** This kind of node cannot take the action at all. */
    static final int UNSUPPORTED = -32003;

    /** The action was refused before anything reached the app, so it is safe to report and retry. */
    static final class Refused extends Exception {
        private static final long serialVersionUID = 1L;

        final int code;

        private Refused(int code, String message) {
            super(message);
            this.code = code;
        }
    }

    private Perform() {
    }

    /**
     * Checks the node and runs the action. Must not be called on the event dispatch thread.
     *
     * @param value the text for {@code fill}; unused by {@code tap}
     * @throws Refused if the action did not run
     */
    static void run(String nodeId, String action, String value)
            throws Refused, InterruptedException, InvocationTargetException {
        var refusal = new AtomicReference<Refused>();
        SwingUtilities.invokeAndWait(() -> {
            try {
                queue(nodeId, action, value);
            } catch (Refused e) {
                refusal.set(e);
            }
        });
        if (refusal.get() != null) {
            throw refusal.get();
        }
        // Runs after the queued action, or as soon as the action's modal dialog is processing events.
        SwingUtilities.invokeAndWait(() -> { });
    }

    private static void queue(String nodeId, String action, String value) throws Refused {
        switch (action) {
            case "tap" -> queueTap(actionableComponent(nodeId, action));
            case "fill" -> {
                if (value == null) {
                    throw new Refused(INVALID_PARAMS, "fill needs a value");
                }
                queueFill(actionableComponent(nodeId, action), value);
            }
            default -> throw new Refused(INVALID_PARAMS, "unknown action");
        }
    }

    private static Component actionableComponent(String nodeId, String action) throws Refused {
        Accessible node = NodeIds.find(nodeId);
        if (node == null) {
            throw new Refused(NODE_STALE, "the node is gone");
        }
        if (!(node instanceof Component component)) {
            throw new Refused(UNSUPPORTED, action + " needs a component, and this node is not one");
        }
        if (!component.isShowing()) {
            throw new Refused(NODE_STALE, "the node is not showing");
        }
        if (!component.isEnabled()) {
            throw new Refused(NOT_ACTIONABLE, "the node is disabled");
        }
        if (isBlockedByModalDialog(component)) {
            throw new Refused(NOT_ACTIONABLE, "a modal dialog blocks the node");
        }
        return component;
    }

    /**
     * AWT silently drops input to a blocked window and does not expose whether a window is blocked,
     * so this works it out: another showing modal dialog blocks a window unless it owns that window.
     *
     * <p>This treats every modal type alike, and two modal dialogs where neither owns the other block
     * each other. Both can only refuse an action that would have worked, never let one get lost.
     */
    private static boolean isBlockedByModalDialog(Component component) {
        Window target = component instanceof Window window ? window : SwingUtilities.getWindowAncestor(component);
        for (Window other : Window.getWindows()) {
            if (other instanceof Dialog dialog && dialog != target && dialog.isShowing() && dialog.isModal()
                    && !isOwnedBy(target, dialog)) {
                return true;
            }
        }
        return false;
    }

    private static boolean isOwnedBy(Window window, Window owner) {
        for (Window w = window; w != null; w = w.getOwner()) {
            if (w == owner) {
                return true;
            }
        }
        return false;
    }

    /** Posts the events of one left click at the center of the component, so its listeners react as to a user. */
    private static void queueTap(Component component) throws Refused {
        int x = component.getWidth() / 2;
        int y = component.getHeight() / 2;
        if (component.getWidth() == 0 || component.getHeight() == 0) {
            throw new Refused(NOT_ACTIONABLE, "the node has no size");
        }
        EventQueue queue = Toolkit.getDefaultToolkit().getSystemEventQueue();
        long now = System.currentTimeMillis();
        queue.postEvent(new MouseEvent(component, MouseEvent.MOUSE_ENTERED, now, 0, x, y, 0, false, MouseEvent.NOBUTTON));
        queue.postEvent(new MouseEvent(component, MouseEvent.MOUSE_PRESSED, now, InputEvent.BUTTON1_DOWN_MASK, x, y, 1, false, MouseEvent.BUTTON1));
        queue.postEvent(new MouseEvent(component, MouseEvent.MOUSE_RELEASED, now, 0, x, y, 1, false, MouseEvent.BUTTON1));
        queue.postEvent(new MouseEvent(component, MouseEvent.MOUSE_CLICKED, now, 0, x, y, 1, false, MouseEvent.BUTTON1));
    }

    private static void queueFill(Component component, String value) throws Refused {
        if (!(component instanceof JTextComponent text)) {
            throw new Refused(UNSUPPORTED, "fill needs a text component, and this node is not one");
        }
        if (!text.isEditable()) {
            throw new Refused(NOT_ACTIONABLE, "the node is read-only");
        }
        EventQueue.invokeLater(() -> text.setText(value));
    }
}
