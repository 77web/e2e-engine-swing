package dev.e2e.swing.agent;

import java.util.HashMap;
import java.util.Map;
import java.util.WeakHashMap;
import javax.accessibility.Accessible;

/**
 * Gives each node an id that stays the same across snapshots while the node lives, and finds a node
 * again from its id. Use only on the event dispatch thread, which is what makes the plain maps safe.
 */
final class NodeIds {
    /** Weak keys: holding an id must not keep a closed window's components in memory. */
    private static final Map<Accessible, String> ids = new WeakHashMap<>();

    /** The nodes of the newest snapshot. An id from an older snapshot that is not here is stale. */
    private static Map<String, Accessible> latest = new HashMap<>();

    private static long lastId = 0;

    private NodeIds() {
    }

    /** Forgets the previous snapshot's nodes. Call before reading a new tree. */
    static void startSnapshot() {
        latest = new HashMap<>();
    }

    /** Returns the node's id, minting one the first time, and records the node as current. */
    static String idOf(Accessible accessible) {
        String id = ids.computeIfAbsent(accessible, key -> "n" + (++lastId));
        latest.put(id, accessible);
        return id;
    }

    /** Returns the node with this id in the newest snapshot, or null if there is none. */
    static Accessible find(String id) {
        return latest.get(id);
    }
}
