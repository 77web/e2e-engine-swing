package dev.e2e.swing.agent;

import java.awt.Component;
import java.awt.Container;
import java.awt.Dialog;
import java.awt.Dimension;
import java.awt.EventQueue;
import java.awt.KeyboardFocusManager;
import java.awt.Rectangle;
import java.awt.Window;
import javax.accessibility.Accessible;
import javax.swing.JComponent;
import javax.swing.JList;
import javax.swing.JScrollBar;
import javax.swing.JScrollPane;
import javax.swing.SwingUtilities;

/**
 * The {@code scrollIntoView} and {@code swipe} actions. Call only on the event dispatch thread; the
 * scrolling itself is queued, like every action (see {@link Perform}).
 */
final class Scrolling {
    /** The way the content moves: {@code DOWN} reveals what is below, as in the engine contract. */
    enum Direction {
        UP("up", true, -1), DOWN("down", true, 1), LEFT("left", false, -1), RIGHT("right", false, 1);

        final String wire;
        final boolean vertical;
        final int sign;

        Direction(String wire, boolean vertical, int sign) {
            this.wire = wire;
            this.vertical = vertical;
            this.sign = sign;
        }
    }

    /** How far one swipe scrolls, in visible areas. No momentum given scrolls one visible area. */
    enum Momentum {
        NONE("none", 0.5), SLOW("slow", 1), FAST("fast", 3), DEFAULT(null, 1);

        final String wire;
        final double screens;

        Momentum(String wire, double screens) {
            this.wire = wire;
            this.screens = screens;
        }
    }

    private Scrolling() {
    }

    /**
     * Scrolls every scroll pane around the node so the node is in view. A list item is scrolled with
     * {@link JList#ensureIndexIsVisible}. A node already in view, or outside any scroll pane, is left
     * as it is.
     */
    static void queueScrollIntoView(Accessible node) throws Perform.Refused {
        if (node instanceof Component component) {
            requireShowing(component);
            if (component instanceof JComponent jc) {
                EventQueue.invokeLater(() -> jc.scrollRectToVisible(new Rectangle(0, 0, jc.getWidth(), jc.getHeight())));
            }
            return;
        }
        Component owner = Perform.owningComponent(node);
        if (owner == null) {
            throw new Perform.Refused(Perform.UNSUPPORTED, "scrollIntoView needs a node drawn by a component");
        }
        requireShowing(owner);
        Rectangle bounds = Perform.boundsInOwner(node, owner, false);
        if (bounds == null) {
            throw new Perform.Refused(Perform.NODE_STALE, "the node is gone");
        }
        int index = node.getAccessibleContext().getAccessibleIndexInParent();
        if (owner instanceof JList<?> list && NodeIds.owningList(node) == list) {
            EventQueue.invokeLater(() -> list.ensureIndexIsVisible(index));
        } else if (owner instanceof JComponent jc) {
            EventQueue.invokeLater(() -> jc.scrollRectToVisible(bounds));
        }
    }

    /**
     * Scrolls the scroll pane that holds the node, or with no node, the largest scroll pane of the
     * front window. Moves the scroll bar, which notifies the app's listeners as a user's scrolling
     * does. A swipe past the end stops at the end without an error, as a user's swipe would.
     */
    static void queueSwipe(Accessible node, Direction direction, Momentum momentum) throws Perform.Refused {
        JScrollPane pane = node == null ? largestScrollPane(frontWindow()) : enclosingScrollPane(node);
        if (pane == null) {
            throw new Perform.Refused(Perform.UNSUPPORTED,
                    node == null ? "the front window has no scrollable area" : "the node is not in a scrollable area");
        }
        JScrollBar bar = direction.vertical ? pane.getVerticalScrollBar() : pane.getHorizontalScrollBar();
        Dimension visible = pane.getViewport().getExtentSize();
        int extent = direction.vertical ? visible.height : visible.width;
        int delta = direction.sign * Math.max(1, (int) Math.round(extent * momentum.screens));
        // The bar's model clamps the value to the scrollable range.
        EventQueue.invokeLater(() -> bar.setValue(bar.getValue() + delta));
    }

    private static JScrollPane enclosingScrollPane(Accessible node) throws Perform.Refused {
        Component component = node instanceof Component c ? c : Perform.owningComponent(node);
        if (component == null) {
            throw new Perform.Refused(Perform.UNSUPPORTED, "swipe needs a node drawn by a component");
        }
        Perform.checkActionable(component);
        if (component instanceof JScrollPane pane) {
            return pane;
        }
        return (JScrollPane) SwingUtilities.getAncestorOfClass(JScrollPane.class, component);
    }

    /** The node must still be on screen; being behind a modal dialog does not stop scrolling. */
    private static void requireShowing(Component component) throws Perform.Refused {
        if (!component.isShowing()) {
            throw new Perform.Refused(Perform.NODE_STALE, "the node is not showing");
        }
    }

    /**
     * Returns the window a user would scroll: the active one, or else, since AWT does not expose the
     * stacking order, the newest showing modal dialog, or else the newest showing window. A window
     * behind a modal dialog is skipped, since it takes no input.
     */
    static Window frontWindow() {
        Window active = KeyboardFocusManager.getCurrentKeyboardFocusManager().getActiveWindow();
        if (active != null && active.isShowing() && !Perform.isBlockedByModalDialog(active)) {
            return active;
        }
        Window newestDialog = null;
        Window newest = null;
        for (Window window : Window.getWindows()) {
            if (!window.isShowing() || Perform.isBlockedByModalDialog(window)) {
                continue;
            }
            newest = window;
            if (window instanceof Dialog dialog && dialog.isModal()) {
                newestDialog = window;
            }
        }
        return newestDialog != null ? newestDialog : newest;
    }

    private static JScrollPane largestScrollPane(Container root) {
        if (root == null) {
            return null;
        }
        JScrollPane best = null;
        long bestArea = 0;
        for (Component child : root.getComponents()) {
            JScrollPane candidate = null;
            if (child instanceof JScrollPane pane && pane.isShowing()) {
                candidate = pane;
            } else if (child instanceof Container container && child.isShowing()) {
                candidate = largestScrollPane(container);
            }
            if (candidate != null) {
                long area = (long) candidate.getWidth() * candidate.getHeight();
                if (area > bestArea) {
                    best = candidate;
                    bestArea = area;
                }
            }
        }
        return best;
    }
}
