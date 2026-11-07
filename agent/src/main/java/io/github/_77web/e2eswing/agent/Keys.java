package io.github._77web.e2eswing.agent;

import java.awt.AWTKeyStroke;
import java.awt.Component;
import java.awt.Container;
import java.awt.Dialog;
import java.awt.EventQueue;
import java.awt.FocusTraversalPolicy;
import java.awt.KeyboardFocusManager;
import java.awt.Window;
import java.awt.event.FocusEvent;
import java.awt.event.InputEvent;
import java.awt.event.KeyEvent;
import java.lang.ref.WeakReference;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import javax.swing.SwingUtilities;
import javax.swing.text.JTextComponent;

/**
 * Key input: the {@code press} action on a node, and the {@code keyboard} method's {@code type} and
 * {@code press}, which go to whatever holds focus. Call only on the event dispatch thread.
 *
 * <p>Key events posted to the event queue go through AWT's focus manager, which sends them to the
 * component that holds the real focus. While the app's window is not the active window (a terminal
 * or another app is in front, or on CI), nothing holds it and the keys are dropped. So the keys are
 * delivered straight to the target with {@link KeyboardFocusManager#redispatchEvent}, whether the
 * window is active or not, and focus is handled here:
 * <ul>
 *   <li>The target is asked for the real focus with {@code requestFocusInWindow}, which works when
 *       its window is active.
 *   <li>When its window is not active, the target is sent a synthetic {@code FOCUS_GAINED}, and the
 *       component that had the synthetic focus before a {@code FOCUS_LOST}. Swing's text actions
 *       depend on it: a text field's Enter fires only in the field Swing last saw gain focus.
 *   <li>Focus traversal keys (Tab, Shift+Tab) are handled by AWT's focus manager, which redispatching
 *       skips, so they move the focus here with the focus traversal policy instead of being sent.
 * </ul>
 *
 * <p>The synthetic focus is believed by Swing components only. AWT still reports no focus owner, so
 * an app that reads the focus manager, or moves focus itself, sees something a real user would not.
 *
 * <p>Typed text may be a password. It must not appear in any message or log.
 */
final class Keys {
    /** The component last tapped, filled, focused, or sent keys: where keys go when nothing holds real focus. */
    private static WeakReference<Component> remembered = new WeakReference<>(null);

    /** The component that was last sent a synthetic {@code FOCUS_GAINED}. */
    private static WeakReference<Component> faked = new WeakReference<>(null);

    private static final boolean MAC = System.getProperty("os.name", "").startsWith("Mac");

    private Keys() {
    }

    /** Records the component an action went to, as the target of later keyboard input. */
    static void remember(Component component) {
        remembered = new WeakReference<>(component);
    }

    // ---- Keys as steps -------------------------------------------------------------------------

    /** One step of key input. Steps run in order, each after the events the previous one caused. */
    private sealed interface Step permits Press, SelectAll {
    }

    /** One key with its modifiers. */
    private record Press(Key key) implements Step {
    }

    /** Selects all the text of the target, so the next Backspace deletes it. */
    private record SelectAll() implements Step {
    }

    /** One key event, built when it runs so its source is the current target. */
    private record Event(int id, int keyCode, char keyChar, int modifiers) {
    }

    /** A key of the contract grammar, parsed by the TypeScript side: modifiers and a key code. */
    private record Key(List<Modifier> modifiers, int keyCode, char keyChar) {
        int mask() {
            int mask = 0;
            for (Modifier m : modifiers) {
                mask |= m.mask;
            }
            return mask;
        }
    }

    private enum Modifier {
        SHIFT(KeyEvent.VK_SHIFT, InputEvent.SHIFT_DOWN_MASK),
        CONTROL(KeyEvent.VK_CONTROL, InputEvent.CTRL_DOWN_MASK),
        ALT(KeyEvent.VK_ALT, InputEvent.ALT_DOWN_MASK),
        META(KeyEvent.VK_META, InputEvent.META_DOWN_MASK);

        final int keyCode;
        final int mask;

        Modifier(int keyCode, int mask) {
            this.keyCode = keyCode;
            this.mask = mask;
        }
    }

    /**
     * Reads a key from the wire: {@code {"modifiers": [...], "name": "Enter"}} or
     * {@code {"modifiers": [...], "char": "a"}}, with the names of the contract's key grammar.
     * {@code ControlOrMeta} is Meta on macOS and Control elsewhere.
     */
    static Key parseKey(Object wire) throws Perform.Refused {
        if (!(wire instanceof Map<?, ?> key) || !(key.get("modifiers") instanceof List<?> names)) {
            throw new Perform.Refused(Perform.INVALID_PARAMS, "press needs a key with modifiers and a name or a char");
        }
        var modifiers = new ArrayList<Modifier>();
        for (Object name : names) {
            Modifier modifier = switch (String.valueOf(name)) {
                case "Shift" -> Modifier.SHIFT;
                case "Control" -> Modifier.CONTROL;
                case "Alt" -> Modifier.ALT;
                case "Meta" -> Modifier.META;
                case "ControlOrMeta" -> MAC ? Modifier.META : Modifier.CONTROL;
                default -> throw new Perform.Refused(Perform.INVALID_PARAMS, "unknown modifier");
            };
            if (!modifiers.contains(modifier)) {
                modifiers.add(modifier);
            }
        }
        if (key.get("char") instanceof String text && text.codePointCount(0, text.length()) == 1) {
            if (text.length() != 1) {
                throw new Perform.Refused(Perform.UNSUPPORTED, "a character outside the Basic Multilingual Plane cannot be pressed as one key");
            }
            char c = text.charAt(0);
            return new Key(modifiers, KeyEvent.getExtendedKeyCodeForChar(c), c);
        }
        if (key.get("name") instanceof String name) {
            return named(modifiers, name);
        }
        throw new Perform.Refused(Perform.INVALID_PARAMS, "press needs a key with a name or one char");
    }

    private static Key named(List<Modifier> modifiers, String name) throws Perform.Refused {
        char none = KeyEvent.CHAR_UNDEFINED;
        return switch (name) {
            case "Enter" -> new Key(modifiers, KeyEvent.VK_ENTER, '\n');
            case "Escape" -> new Key(modifiers, KeyEvent.VK_ESCAPE, (char) 27);
            case "Tab" -> new Key(modifiers, KeyEvent.VK_TAB, '\t');
            case "Backspace" -> new Key(modifiers, KeyEvent.VK_BACK_SPACE, '\b');
            case "Delete" -> new Key(modifiers, KeyEvent.VK_DELETE, (char) 127);
            case "Insert" -> new Key(modifiers, KeyEvent.VK_INSERT, none);
            case "Space" -> new Key(modifiers, KeyEvent.VK_SPACE, ' ');
            case "ArrowUp" -> new Key(modifiers, KeyEvent.VK_UP, none);
            case "ArrowDown" -> new Key(modifiers, KeyEvent.VK_DOWN, none);
            case "ArrowLeft" -> new Key(modifiers, KeyEvent.VK_LEFT, none);
            case "ArrowRight" -> new Key(modifiers, KeyEvent.VK_RIGHT, none);
            case "Home" -> new Key(modifiers, KeyEvent.VK_HOME, none);
            case "End" -> new Key(modifiers, KeyEvent.VK_END, none);
            case "PageUp" -> new Key(modifiers, KeyEvent.VK_PAGE_UP, none);
            case "PageDown" -> new Key(modifiers, KeyEvent.VK_PAGE_DOWN, none);
            default -> {
                if (name.matches("F([1-9]|1[0-2])")) {
                    yield new Key(modifiers, KeyEvent.VK_F1 + Integer.parseInt(name.substring(1)) - 1, none);
                }
                throw new Perform.Refused(Perform.UNSUPPORTED, "unknown key name");
            }
        };
    }

    /**
     * The events of one key: each modifier pressed in order, the key pressed, typed when it makes a
     * character and no Control, Alt, or Meta is held, and released, then the modifiers released in
     * reverse.
     */
    private static List<Event> events(Key key) {
        var events = new ArrayList<Event>();
        int mask = 0;
        for (Modifier m : key.modifiers()) {
            mask |= m.mask;
            events.add(new Event(KeyEvent.KEY_PRESSED, m.keyCode, KeyEvent.CHAR_UNDEFINED, mask));
        }
        events.add(new Event(KeyEvent.KEY_PRESSED, key.keyCode(), key.keyChar(), mask));
        int commandMask = InputEvent.CTRL_DOWN_MASK | InputEvent.ALT_DOWN_MASK | InputEvent.META_DOWN_MASK;
        if (key.keyChar() != KeyEvent.CHAR_UNDEFINED && (mask & commandMask) == 0) {
            events.add(new Event(KeyEvent.KEY_TYPED, KeyEvent.VK_UNDEFINED, key.keyChar(), mask));
        }
        events.add(new Event(KeyEvent.KEY_RELEASED, key.keyCode(), key.keyChar(), mask));
        for (int i = key.modifiers().size() - 1; i >= 0; i--) {
            Modifier m = key.modifiers().get(i);
            mask &= ~m.mask;
            events.add(new Event(KeyEvent.KEY_RELEASED, m.keyCode, KeyEvent.CHAR_UNDEFINED, mask));
        }
        return events;
    }

    // ---- The three operations ------------------------------------------------------------------

    /** The {@code press} action: moves focus to the component, then sends the key. */
    static CompletableFuture<Void> queuePress(Component component, Object wireKey) throws Perform.Refused {
        Key key = parseKey(wireKey);
        return queueSteps(component, List.of(new Press(key)));
    }

    /** The {@code focus} action: real focus where the window allows it, synthetic focus otherwise. */
    static CompletableFuture<Void> queueFocus(Component component) {
        return queueSteps(component, List.of());
    }

    /**
     * The {@code keyboard} method. {@code press} sends one key, {@code type} sends the key events of
     * each character, after selecting all the text and deleting it with Backspace when
     * {@code replace} is set.
     *
     * @throws Perform.Refused {@code NOT_ACTIONABLE} when no target holds focus, or for {@code type},
     *     when the target is not an enabled, editable text component
     */
    static CompletableFuture<Void> queueKeyboard(Map<?, ?> params) throws Perform.Refused {
        Component target = focusTarget();
        if (target == null) {
            throw new Perform.Refused(Perform.NOT_ACTIONABLE, "nothing has focus");
        }
        var steps = new ArrayList<Step>();
        switch (String.valueOf(params.get("action"))) {
            case "press" -> steps.add(new Press(parseKey(params.get("key"))));
            case "type" -> {
                if (!(params.get("text") instanceof String text)) {
                    throw new Perform.Refused(Perform.INVALID_PARAMS, "type needs a text");
                }
                if (!(target instanceof JTextComponent field) || !field.isEditable() || !field.isEnabled()) {
                    throw new Perform.Refused(Perform.NOT_ACTIONABLE, "the focused node does not accept text");
                }
                if (Boolean.TRUE.equals(params.get("replace"))) {
                    steps.add(new SelectAll());
                    steps.add(new Press(new Key(List.of(), KeyEvent.VK_BACK_SPACE, '\b')));
                }
                for (int i = 0; i < text.length(); i++) {
                    char c = text.charAt(i);
                    steps.add(new Press(switch (c) {
                        case '\n' -> new Key(List.of(), KeyEvent.VK_ENTER, '\n');
                        case '\t' -> new Key(List.of(), KeyEvent.VK_TAB, '\t');
                        default -> new Key(List.of(), KeyEvent.getExtendedKeyCodeForChar(c), c);
                    }));
                }
            }
            default -> throw new Perform.Refused(Perform.INVALID_PARAMS, "keyboard needs an action: type or press");
        }
        return queueSteps(target, steps);
    }

    /**
     * Returns where keyboard input goes: the real focus owner; else the remembered component, while
     * it is showing and not behind a modal dialog; else the newest modal dialog's most recent focus
     * owner, or its first focusable component. Null when there is none.
     */
    static Component focusTarget() {
        Component owner = KeyboardFocusManager.getCurrentKeyboardFocusManager().getFocusOwner();
        if (owner != null && owner.isShowing()) {
            return owner;
        }
        Component last = remembered.get();
        if (last != null && last.isShowing() && !Perform.isBlockedByModalDialog(last)) {
            return last;
        }
        Window front = Scrolling.frontWindow();
        if (front instanceof Dialog dialog && dialog.isModal()) {
            Component recent = dialog.getMostRecentFocusOwner();
            if (recent != null && recent.isShowing()) {
                return recent;
            }
            FocusTraversalPolicy policy = dialog.getFocusTraversalPolicy();
            return policy == null ? null : policy.getInitialComponent(dialog);
        }
        return null;
    }

    // ---- Running steps -------------------------------------------------------------------------

    /**
     * Moves focus to the target, then runs the steps one at a time. Each step is queued only after
     * the previous one has run, so it comes after the focus events and any other events the previous
     * step caused; and when a step opens a modal dialog, the dialog's event loop runs the rest.
     *
     * @return completes once the last step has run
     */
    private static CompletableFuture<Void> queueSteps(Component target, List<Step> steps) {
        remember(target);
        var done = new CompletableFuture<Void>();
        var current = new Component[] {target};
        EventQueue.invokeLater(() -> {
            moveFocus(target);
            runStep(current, steps, 0, done);
        });
        return done;
    }

    private static void runStep(Component[] current, List<Step> steps, int index, CompletableFuture<Void> done) {
        if (index == steps.size()) {
            done.complete(null);
            return;
        }
        Runnable next = () -> runStep(current, steps, index + 1, done);
        EventQueue.invokeLater(() -> {
            Step step = steps.get(index);
            Component target = current[0];
            if (step instanceof SelectAll) {
                if (target instanceof JTextComponent field) {
                    field.selectAll();
                }
                next.run();
            } else if (step instanceof Press press && isTraversalKey(target, press.key(), true)) {
                // AWT's focus manager would consume the key and move the focus; redispatching skips it.
                current[0] = traverse(target, true);
                next.run();
            } else if (step instanceof Press press && isTraversalKey(target, press.key(), false)) {
                current[0] = traverse(target, false);
                next.run();
            } else if (step instanceof Press press) {
                runEvent(target, events(press.key()), 0, next);
            }
            // runEvent queues its first event; the traversal and SelectAll branches queue the next step.
        });
    }

    /**
     * Sends the events of one key one at a time, then runs {@code next}.
     *
     * <p>The step that will send the following event is queued before this event is dispatched. If
     * the dispatch opens a modal dialog, it does not return until the dialog closes, but the dialog's
     * event loop runs that step, so the keys go on and the action can report back. If the dispatch
     * returns, that step is reached before the events the dispatch posted, such as focus events, and
     * queues the next event again behind them.
     */
    private static void runEvent(Component target, List<Event> events, int index, Runnable next) {
        EventQueue.invokeLater(() -> {
            if (index == events.size()) {
                next.run();
                return;
            }
            EventQueue.invokeLater(() -> runEvent(target, events, index + 1, next));
            try {
                Event e = events.get(index);
                var event = new KeyEvent(target, e.id(), System.currentTimeMillis(), e.modifiers(), e.keyCode(), e.keyChar());
                KeyboardFocusManager.getCurrentKeyboardFocusManager().redispatchEvent(target, event);
            } catch (RuntimeException e) {
                // A listener of the app failed. Log only the class: the message could quote typed text.
                System.err.println("e2e-swing-agent: a key event failed in the app: " + e.getClass().getName());
            }
        });
    }

    /** Whether the key is one of the target's forward (or backward) focus traversal keys. */
    private static boolean isTraversalKey(Component target, Key key, boolean forward) {
        int which = forward ? KeyboardFocusManager.FORWARD_TRAVERSAL_KEYS : KeyboardFocusManager.BACKWARD_TRAVERSAL_KEYS;
        return target.getFocusTraversalKeysEnabled()
                && target.getFocusTraversalKeys(which).contains(AWTKeyStroke.getAWTKeyStroke(key.keyCode(), key.mask(), false));
    }

    /** Moves the focus along the focus traversal policy and returns the new target. */
    private static Component traverse(Component from, boolean forward) {
        Container root = from instanceof Container c && c.isFocusCycleRoot() ? c : from.getFocusCycleRootAncestor();
        if (root == null || root.getFocusTraversalPolicy() == null) {
            return from;
        }
        FocusTraversalPolicy policy = root.getFocusTraversalPolicy();
        Component next = forward ? policy.getComponentAfter(root, from) : policy.getComponentBefore(root, from);
        if (next == null) {
            return from;
        }
        remember(next);
        moveFocus(next);
        return next;
    }

    /**
     * Asks for the real focus, and when the component's window is not the focused window, where that
     * request does nothing, gives it the synthetic focus.
     */
    private static void moveFocus(Component component) {
        KeyboardFocusManager manager = KeyboardFocusManager.getCurrentKeyboardFocusManager();
        if (manager.getFocusOwner() == component) {
            return;
        }
        component.requestFocusInWindow();
        Window window = component instanceof Window w ? w : SwingUtilities.getWindowAncestor(component);
        if (manager.getFocusedWindow() != window) {
            fakeFocus(component);
        }
    }

    private static void fakeFocus(Component component) {
        Component previous = faked.get();
        if (previous == component) {
            return;
        }
        KeyboardFocusManager manager = KeyboardFocusManager.getCurrentKeyboardFocusManager();
        if (previous != null) {
            manager.redispatchEvent(previous, new FocusEvent(previous, FocusEvent.FOCUS_LOST, false, component));
        }
        manager.redispatchEvent(component, new FocusEvent(component, FocusEvent.FOCUS_GAINED, false, previous));
        faked = new WeakReference<>(component);
    }
}
