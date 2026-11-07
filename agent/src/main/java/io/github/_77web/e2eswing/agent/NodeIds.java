package io.github._77web.e2eswing.agent;

import java.lang.ref.WeakReference;
import java.util.HashMap;
import java.util.Map;
import java.util.WeakHashMap;
import javax.accessibility.Accessible;
import javax.accessibility.AccessibleContext;
import javax.swing.JList;
import javax.swing.ListModel;

/**
 * Gives each node an id that stays the same across snapshots while the node lives, and finds a node
 * again from its id. Use only on the event dispatch thread, which is what makes the plain maps safe.
 *
 * <p>Most nodes are the same object from one snapshot to the next, so the object is the key. The
 * items of a {@link JList} are not: the list makes a new object every time a child is asked for. An
 * item is keyed by its list, its index, and the model element at that index, compared by identity.
 * When an item is removed, the element that moves into its index is a different object, so it gets
 * a new id and the removed item's id goes stale instead of pointing at its neighbour.
 */
final class NodeIds {
    /** Weak keys: holding an id must not keep a closed window's components in memory. */
    private static final Map<Accessible, String> ids = new WeakHashMap<>();

    /** The ids of list items, by list and then by index. */
    private static final Map<JList<?>, Map<Integer, ListItemId>> listItemIds = new WeakHashMap<>();

    /** The nodes of the newest snapshot. An id from an older snapshot that is not here is stale. */
    private static Map<String, Accessible> latest = new HashMap<>();

    /** The list items of the newest snapshot, to check later that the item is still in its place. */
    private static Map<String, ListItemId> latestListItems = new HashMap<>();

    private static long lastId = 0;

    /** The element is held weakly: a removed element must not stay in memory because of its id. */
    private record ListItemId(String id, JList<?> list, int index, WeakReference<Object> element) {
        boolean holds(Object current) {
            return element.get() == current;
        }
    }

    private NodeIds() {
    }

    /** Forgets the previous snapshot's nodes. Call before reading a new tree. */
    static void startSnapshot() {
        latest = new HashMap<>();
        latestListItems = new HashMap<>();
    }

    /** Returns the node's id, minting one the first time, and records the node as current. */
    static String idOf(Accessible accessible) {
        ListItemId item = listItemId(accessible);
        String id = item != null ? item.id() : ids.computeIfAbsent(accessible, key -> mint());
        latest.put(id, accessible);
        if (item != null) {
            latestListItems.put(id, item);
        }
        return id;
    }

    /**
     * Returns the node with this id in the newest snapshot, or null if there is none or if it is a
     * list item whose element has since moved or gone.
     */
    static Accessible find(String id) {
        ListItemId item = latestListItems.get(id);
        if (item != null && !item.holds(elementAt(item.list(), item.index()))) {
            return null;
        }
        return latest.get(id);
    }

    /** Returns the list that owns this node if the node is one of its items, or null. */
    static JList<?> owningList(Accessible accessible) {
        if (accessible instanceof JList<?>) {
            return null;
        }
        AccessibleContext context = accessible.getAccessibleContext();
        if (context != null && context.getAccessibleParent() instanceof JList<?> list) {
            return list;
        }
        return null;
    }

    private static ListItemId listItemId(Accessible accessible) {
        JList<?> list = owningList(accessible);
        if (list == null) {
            return null;
        }
        int index = accessible.getAccessibleContext().getAccessibleIndexInParent();
        Object element = elementAt(list, index);
        if (element == null) {
            return null;
        }
        Map<Integer, ListItemId> byIndex = listItemIds.computeIfAbsent(list, key -> new HashMap<>());
        ListItemId known = byIndex.get(index);
        if (known != null && known.holds(element)) {
            return known;
        }
        var minted = new ListItemId(mint(), list, index, new WeakReference<>(element));
        byIndex.put(index, minted);
        return minted;
    }

    /** Returns the model element at the index, or null when the index is out of range. */
    private static Object elementAt(JList<?> list, int index) {
        ListModel<?> model = list.getModel();
        return index >= 0 && index < model.getSize() ? model.getElementAt(index) : null;
    }

    private static String mint() {
        return "n" + (++lastId);
    }
}
