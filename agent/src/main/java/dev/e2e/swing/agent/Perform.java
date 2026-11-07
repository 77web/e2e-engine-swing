package dev.e2e.swing.agent;

import java.awt.Component;
import java.awt.Dialog;
import java.awt.EventQueue;
import java.awt.Point;
import java.awt.Rectangle;
import java.awt.Toolkit;
import java.awt.Window;
import java.awt.event.InputEvent;
import java.awt.event.MouseEvent;
import java.lang.reflect.InvocationTargetException;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.atomic.AtomicReference;
import javax.accessibility.Accessible;
import javax.accessibility.AccessibleComponent;
import javax.accessibility.AccessibleContext;
import javax.swing.JComboBox;
import javax.swing.JList;
import javax.swing.JTabbedPane;
import javax.swing.JToggleButton;
import javax.swing.ListModel;
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
 *
 * <p>The request fields, beside {@code node} and {@code action}:
 * <ul>
 *   <li>{@code value}: the text of a {@code fill}
 *   <li>{@code key}: the key of a {@code press}; see {@link Keys#parseKey}
 *   <li>{@code option}: {@code {"label": ...}} or {@code {"index": ...}} for a {@code selectOption}
 *   <li>{@code direction} ({@code up}, {@code down}, {@code left}, {@code right}) and an optional
 *       {@code momentum} ({@code none}, {@code slow}, {@code fast}) for a {@code swipe}. A swipe
 *       with no {@code node} scrolls the front window; see {@link Scrolling}.
 * </ul>
 */
final class Perform {
    static final int INVALID_PARAMS = -32602;
    /** The node is gone or no longer showing. Finding it again may succeed. */
    static final int NODE_STALE = -32001;
    /**
     * The node exists but cannot take the action now: disabled, read-only, behind a modal dialog, or
     * a toggle that did not change state when clicked.
     */
    static final int NOT_ACTIONABLE = -32002;
    /** This kind of node cannot take the action at all. */
    static final int UNSUPPORTED = -32003;

    /**
     * The action was refused. Every refusal is raised before anything reaches the app, except a
     * {@code check} or {@code uncheck} whose click left the state as it was.
     */
    static final class Refused extends Exception {
        private static final long serialVersionUID = 1L;

        final int code;

        Refused(int code, String message) {
            super(message);
            this.code = code;
        }
    }

    /** A check that runs on the event dispatch thread once the queued action has been processed. */
    private interface Verify {
        void run() throws Refused;
    }

    /** What to wait for, off the event dispatch thread, after the action is queued. */
    interface After {
        void await() throws Refused, InterruptedException, InvocationTargetException;
    }

    /** Queues an action on the event dispatch thread and returns what to wait for, or null. */
    interface Queued {
        After queue() throws Refused;
    }

    private Perform() {
    }

    /**
     * Checks the node and runs the action. Must not be called on the event dispatch thread.
     *
     * @param params the request's params; {@code action} must be a string
     * @throws Refused if the action did not run, or a toggle did not change
     */
    static void run(Map<?, ?> params) throws Refused, InterruptedException, InvocationTargetException {
        runQueued(() -> queue(params));
    }

    /**
     * Queues an action, waits for the queue to reach it, then waits for what the action returned.
     * Must not be called on the event dispatch thread.
     */
    static void runQueued(Queued queued) throws Refused, InterruptedException, InvocationTargetException {
        var refusal = new AtomicReference<Refused>();
        var after = new AtomicReference<After>();
        SwingUtilities.invokeAndWait(() -> {
            try {
                after.set(queued.queue());
            } catch (Refused e) {
                refusal.set(e);
            }
        });
        if (refusal.get() != null) {
            throw refusal.get();
        }
        // Runs after the queued action, or as soon as the action's modal dialog is processing events.
        SwingUtilities.invokeAndWait(() -> { });
        if (after.get() != null) {
            after.get().await();
        }
    }

    /** Waits for a chain of queued steps, such as key events, to finish. */
    static After awaiting(CompletableFuture<Void> done) {
        return () -> {
            try {
                done.get();
            } catch (ExecutionException e) {
                throw new InvocationTargetException(e.getCause());
            }
            SwingUtilities.invokeAndWait(() -> { });
        };
    }

    /** Runs a check on the event dispatch thread. */
    private static After verifying(Verify verify) {
        return () -> {
            var refusal = new AtomicReference<Refused>();
            SwingUtilities.invokeAndWait(() -> {
                try {
                    verify.run();
                } catch (Refused e) {
                    refusal.set(e);
                }
            });
            if (refusal.get() != null) {
                throw refusal.get();
            }
        };
    }

    /** Checks the node, queues the action, and returns a check to run afterwards, or null. */
    private static After queue(Map<?, ?> params) throws Refused {
        String action = (String) params.get("action");
        String nodeId = params.get("node") instanceof String id ? id : null;
        if (nodeId == null) {
            if (!"swipe".equals(action)) {
                throw new Refused(INVALID_PARAMS, action + " needs a node");
            }
            Scrolling.queueSwipe(null, direction(params), momentum(params));
            return null;
        }
        switch (action) {
            case "tap" -> queueClick(clickTarget(nodeId, action), MouseEvent.BUTTON1, 1);
            case "doubleTap" -> queueClick(clickTarget(nodeId, action), MouseEvent.BUTTON1, 2);
            case "secondaryTap" -> queueClick(clickTarget(nodeId, action), MouseEvent.BUTTON3, 1);
            case "fill" -> {
                if (!(params.get("value") instanceof String value)) {
                    throw new Refused(INVALID_PARAMS, "fill needs a value");
                }
                JTextComponent text = editableText(nodeId, action);
                Keys.remember(text);
                queueSetText(text, value);
            }
            case "clear" -> queueSetText(editableText(nodeId, action), "");
            case "focus" -> {
                return awaiting(Keys.queueFocus(actionableComponent(nodeId, action)));
            }
            case "press" -> {
                return awaiting(Keys.queuePress(keyTarget(nodeId), params.get("key")));
            }
            case "check" -> {
                return queueToggle(nodeId, action, true);
            }
            case "uncheck" -> {
                return queueToggle(nodeId, action, false);
            }
            case "selectOption" -> queueSelect(nodeId, option(params));
            case "scrollIntoView" -> Scrolling.queueScrollIntoView(foundNode(nodeId));
            case "swipe" -> Scrolling.queueSwipe(foundNode(nodeId), direction(params), momentum(params));
            default -> throw new Refused(INVALID_PARAMS, "unknown action");
        }
        return null;
    }

    // ---- Finding and checking the target -------------------------------------------------------

    /** Returns the node of the newest snapshot with this id. */
    static Accessible foundNode(String nodeId) throws Refused {
        Accessible node = NodeIds.find(nodeId);
        if (node == null) {
            throw new Refused(NODE_STALE, "the node is gone");
        }
        return node;
    }

    /**
     * Returns the component a {@code press} goes to: the node, or for a node that is not a component,
     * such as a list item, the component that draws it.
     */
    private static Component keyTarget(String nodeId) throws Refused {
        Accessible node = foundNode(nodeId);
        Component component = node instanceof Component c ? c : owningComponent(node);
        if (component == null) {
            throw new Refused(UNSUPPORTED, "press needs a node drawn by a component, and this node is not");
        }
        checkActionable(component);
        return component;
    }

    private static Component actionableComponent(String nodeId, String action) throws Refused {
        if (!(foundNode(nodeId) instanceof Component component)) {
            throw new Refused(UNSUPPORTED, action + " needs a component, and this node is not one");
        }
        checkActionable(component);
        return component;
    }

    /** Refuses a component that is gone from the screen, disabled, or behind a modal dialog. */
    static void checkActionable(Component component) throws Refused {
        if (!component.isShowing()) {
            throw new Refused(NODE_STALE, "the node is not showing");
        }
        if (!component.isEnabled()) {
            throw new Refused(NOT_ACTIONABLE, "the node is disabled");
        }
        if (isBlockedByModalDialog(component)) {
            throw new Refused(NOT_ACTIONABLE, "a modal dialog blocks the node");
        }
    }

    /**
     * AWT silently drops input to a blocked window and does not expose whether a window is blocked,
     * so this works it out: another showing modal dialog blocks a window unless it owns that window.
     *
     * <p>This treats every modal type alike, and two modal dialogs where neither owns the other block
     * each other. Both can only refuse an action that would have worked, never let one get lost.
     */
    static boolean isBlockedByModalDialog(Component component) {
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

    /** Returns the nearest component among the node's accessible ancestors, or null. */
    static Component owningComponent(Accessible node) {
        Accessible current = node;
        while (current != null) {
            AccessibleContext context = current.getAccessibleContext();
            if (context == null) {
                return null;
            }
            current = context.getAccessibleParent();
            if (current instanceof Component component) {
                return component;
            }
        }
        return null;
    }

    // ---- Clicks --------------------------------------------------------------------------------

    /** Where a click goes: a component, and a point in that component's coordinates. */
    private record ClickTarget(Component component, Point point) {
    }

    /**
     * Finds where to click the node. A component is clicked at its center. A node that is not a
     * component, such as a tab or a list item, is drawn by the nearest component above it, so that
     * component is clicked at the center of the node's bounds. A list item is first scrolled into
     * view, as a user would scroll before clicking.
     */
    private static ClickTarget clickTarget(String nodeId, String action) throws Refused {
        Accessible node = foundNode(nodeId);
        if (node instanceof Component component) {
            checkActionable(component);
            if (component.getWidth() == 0 || component.getHeight() == 0) {
                throw new Refused(NOT_ACTIONABLE, "the node has no size");
            }
            return new ClickTarget(component, new Point(component.getWidth() / 2, component.getHeight() / 2));
        }
        Component owner = owningComponent(node);
        if (owner == null) {
            throw new Refused(UNSUPPORTED, action + " needs a node drawn by a component, and this node is not");
        }
        checkActionable(owner);
        Rectangle bounds = boundsInOwner(node, owner, true);
        if (bounds == null || bounds.isEmpty()) {
            throw new Refused(NOT_ACTIONABLE, "the node has no size");
        }
        return new ClickTarget(owner, new Point(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2));
    }

    /**
     * Returns the node's bounds in the owner's coordinates, or null. Lists and tabbed panes report
     * their items' bounds themselves, and a list item is scrolled into view when {@code reveal} is
     * set. Any other node is placed from its screen position.
     */
    static Rectangle boundsInOwner(Accessible node, Component owner, boolean reveal) {
        int index = node.getAccessibleContext().getAccessibleIndexInParent();
        if (owner instanceof JList<?> list && NodeIds.owningList(node) == list) {
            if (index < 0 || index >= list.getModel().getSize()) {
                return null;
            }
            if (reveal) {
                list.ensureIndexIsVisible(index);
            }
            return list.getCellBounds(index, index);
        }
        if (owner instanceof JTabbedPane tabs && index >= 0 && index < tabs.getTabCount()) {
            return tabs.getBoundsAt(index);
        }
        AccessibleComponent component = node.getAccessibleContext().getAccessibleComponent();
        if (component == null) {
            return null;
        }
        Point nodeOnScreen = component.getLocationOnScreen();
        if (nodeOnScreen == null || component.getSize() == null) {
            return null;
        }
        Point ownerOnScreen = owner.getLocationOnScreen();
        return new Rectangle(nodeOnScreen.x - ownerOnScreen.x, nodeOnScreen.y - ownerOnScreen.y,
                component.getSize().width, component.getSize().height);
    }

    /**
     * Posts the mouse events of a click at the target point, so the component's listeners react as
     * to a user. A double click is two clicks, the second with a click count of 2. A right click
     * marks the press as the popup trigger, or the release on Windows, as each platform does.
     */
    private static void queueClick(ClickTarget target, int button, int clicks) {
        Component c = target.component();
        Keys.remember(c);
        int x = target.point().x;
        int y = target.point().y;
        int downMask = button == MouseEvent.BUTTON3 ? InputEvent.BUTTON3_DOWN_MASK : InputEvent.BUTTON1_DOWN_MASK;
        boolean popupOnPress = button == MouseEvent.BUTTON3 && !isWindows();
        boolean popupOnRelease = button == MouseEvent.BUTTON3 && isWindows();
        EventQueue queue = Toolkit.getDefaultToolkit().getSystemEventQueue();
        long now = System.currentTimeMillis();
        queue.postEvent(new MouseEvent(c, MouseEvent.MOUSE_ENTERED, now, 0, x, y, 0, false, MouseEvent.NOBUTTON));
        for (int count = 1; count <= clicks; count++) {
            queue.postEvent(new MouseEvent(c, MouseEvent.MOUSE_PRESSED, now, downMask, x, y, count, popupOnPress, button));
            queue.postEvent(new MouseEvent(c, MouseEvent.MOUSE_RELEASED, now, 0, x, y, count, popupOnRelease, button));
            queue.postEvent(new MouseEvent(c, MouseEvent.MOUSE_CLICKED, now, 0, x, y, count, false, button));
        }
    }

    private static boolean isWindows() {
        return System.getProperty("os.name", "").startsWith("Windows");
    }

    // ---- Text ----------------------------------------------------------------------------------

    private static JTextComponent editableText(String nodeId, String action) throws Refused {
        if (!(actionableComponent(nodeId, action) instanceof JTextComponent text)) {
            throw new Refused(UNSUPPORTED, action + " needs a text component, and this node is not one");
        }
        if (!text.isEditable()) {
            throw new Refused(NOT_ACTIONABLE, "the node is read-only");
        }
        return text;
    }

    private static void queueSetText(JTextComponent text, String value) {
        EventQueue.invokeLater(() -> text.setText(value));
    }

    // ---- Toggles -------------------------------------------------------------------------------

    /**
     * Clicks a checkbox, radio button, or toggle button when it is not yet in the wanted state, and
     * returns a check that the click changed it. A click that did nothing, such as on a selected
     * radio button for {@code uncheck}, is {@code NOT_ACTIONABLE}.
     */
    private static After queueToggle(String nodeId, String action, boolean wanted) throws Refused {
        Accessible node = foundNode(nodeId);
        if (!(node instanceof JToggleButton button)) {
            throw new Refused(UNSUPPORTED, action + " needs a checkbox, radio button, or toggle button");
        }
        ClickTarget target = clickTarget(nodeId, action);
        if (button.isSelected() == wanted) {
            return null;
        }
        queueClick(target, MouseEvent.BUTTON1, 1);
        return verifying(() -> {
            if (button.isSelected() != wanted) {
                throw new Refused(NOT_ACTIONABLE, "the click did not change the state");
            }
        });
    }

    // ---- Selection -----------------------------------------------------------------------------

    /** An option to select: a label, or a zero-based index when {@code label} is null. */
    private record Option(String label, int index) {
    }

    /**
     * Selects an item of a combo box or a list with {@code setSelectedIndex}, which notifies the
     * app's listeners as a user's choice does, without opening the popup. A label is matched against
     * each item's {@code toString}.
     */
    private static void queueSelect(String nodeId, Option option) throws Refused {
        Component component = actionableComponent(nodeId, "selectOption");
        ListModel<?> model;
        if (component instanceof JComboBox<?> combo) {
            model = combo.getModel();
        } else if (component instanceof JList<?> list) {
            model = list.getModel();
        } else {
            throw new Refused(UNSUPPORTED, "selectOption needs a combo box or a list");
        }
        int index = indexOf(model, option);
        if (index < 0) {
            throw new Refused(NOT_ACTIONABLE, "the node has no such option");
        }
        if (component instanceof JComboBox<?> combo) {
            EventQueue.invokeLater(() -> combo.setSelectedIndex(index));
        } else {
            JList<?> list = (JList<?>) component;
            EventQueue.invokeLater(() -> {
                list.setSelectedIndex(index);
                list.ensureIndexIsVisible(index);
            });
        }
    }

    private static int indexOf(ListModel<?> model, Option option) {
        if (option.label() == null) {
            return option.index() < model.getSize() ? option.index() : -1;
        }
        for (int i = 0; i < model.getSize(); i++) {
            if (option.label().equals(String.valueOf(model.getElementAt(i)))) {
                return i;
            }
        }
        return -1;
    }

    // ---- Params --------------------------------------------------------------------------------

    private static Option option(Map<?, ?> params) throws Refused {
        if (params.get("option") instanceof Map<?, ?> option) {
            if (option.get("label") instanceof String label) {
                return new Option(label, -1);
            }
            if (option.get("index") instanceof Long index && index >= 0 && index <= Integer.MAX_VALUE) {
                return new Option(null, index.intValue());
            }
        }
        throw new Refused(INVALID_PARAMS, "selectOption needs an option with a label or a non-negative index");
    }

    private static Scrolling.Direction direction(Map<?, ?> params) throws Refused {
        if (params.get("direction") instanceof String direction) {
            for (Scrolling.Direction d : Scrolling.Direction.values()) {
                if (d.wire.equals(direction)) {
                    return d;
                }
            }
        }
        throw new Refused(INVALID_PARAMS, "swipe needs a direction: up, down, left, or right");
    }

    private static Scrolling.Momentum momentum(Map<?, ?> params) throws Refused {
        Object value = params.get("momentum");
        if (value == null) {
            return Scrolling.Momentum.DEFAULT;
        }
        if (value instanceof String momentum) {
            for (Scrolling.Momentum m : Scrolling.Momentum.values()) {
                if (m.wire != null && m.wire.equals(momentum)) {
                    return m;
                }
            }
        }
        throw new Refused(INVALID_PARAMS, "swipe momentum must be none, slow, or fast");
    }
}
