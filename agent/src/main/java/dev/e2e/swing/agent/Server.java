package dev.e2e.swing.agent;

import java.io.*;
import java.lang.reflect.InvocationTargetException;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Accepts client connections on the loopback interface.
 */
final class Server {
    private final ServerSocket socket;
    private final String token;
    private static final int AUTH_TIMEOUT_MILLIS = 5000;
    private static final int MAX_LINE_BYTES = 4096;

    private Server(ServerSocket socket, String token) {
        this.socket = socket;
        this.token = token;
    }

    /** Starts listening on a free port on 127.0.0.1. */
    static Server bind(String token) throws IOException {
        return new Server(new ServerSocket(0, 50, InetAddress.getLoopbackAddress()), token);
    }

    int port() {
        return this.socket.getLocalPort();
    }

    /**
     * Accepts client connections one at a time. Does not return until the server socket closes.
     */
    void serve() {
        while (!socket.isClosed()) {
            try (Socket client = socket.accept()) {
                handle(client);
            } catch (IOException | Json.ParseException e) {
                System.err.println("e2e-swing-agent: connection failed: " + e);
            }
        }
    }

    /**
     * Handles one connection. Returns without replying unless the first line is a valid
     * {@code auth} request; the caller then closes the socket. After a valid {@code auth}, answers
     * requests until the client disconnects.
     */
    private void handle(Socket client) throws IOException, Json.ParseException {
        client.setSoTimeout(AUTH_TIMEOUT_MILLIS);
        InputStream in = new BufferedInputStream(client.getInputStream());
        OutputStream out = client.getOutputStream();

        String line = readLine(in);
        if (line == null) {
            return;
        }
        if (!(Json.parse(line) instanceof Map<?, ?> request)
                || !(request.get("id") instanceof Long id)
                || !"auth".equals(request.get("method"))
                || !(request.get("params") instanceof Map<?, ?> params)
                || !(params.get("token") instanceof String candidate)
                || !tokenMatches(candidate)) {
            System.err.println("e2e-swing-agent: rejected a connection");
            return;
        }
        send(out, result(id, Map.of()));

        // The client is authenticated and may stay idle between requests.
        client.setSoTimeout(0);
        while ((line = readLine(in)) != null) {
            send(out, dispatch(line));
        }

    }

    /** Runs one request and returns its response. A malformed request ends the connection. */
    private static Map<String, Object> dispatch(String line) throws IOException, Json.ParseException {
        if (!(Json.parse(line) instanceof Map<?, ?> request)
                || !(request.get("id") instanceof Long id)) {
            throw new IOException("malformed request");
        }
        if (!"snapshot".equals(request.get("method"))) {
            return error(id, -32601, "method not found");
        }
        try {
            return result(id, Snapshot.capture());
        } catch (InvocationTargetException e) {
            System.err.println("e2e-swing-agent: snapshot failed: " + e.getCause());
            return error(id, -32603, "snapshot failed");
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            return error(id, -32603, "snapshot interrupted");
        }
    }

    private static Map<String, Object> error(Long id, int code, String message) {
        var details = new LinkedHashMap<String, Object>();
        details.put("code", code);
        details.put("message", message);
        var response = new LinkedHashMap<String, Object>();
        response.put("id", id);
        response.put("error", details);
        return response;
    }

    private void send(OutputStream out, Map<String, Object> response) throws IOException{
        out.write((Json.write(response) + "\n").getBytes(StandardCharsets.UTF_8));
        out.flush();
    }

    private static LinkedHashMap<String, Object> result(Long id, Object result) {
        var response = new LinkedHashMap<String, Object>();
        response.put("id", id);
        response.put("result", result);

        return response;
    }

    /**
     * Compares with {@link MessageDigest#isEqual} so the time taken does not reveal how much of
     * the token matched.
     */
    private boolean tokenMatches(String candidate) {
        return MessageDigest.isEqual(
                candidate.getBytes(StandardCharsets.UTF_8),
                token.getBytes(StandardCharsets.UTF_8));
    }

    /**
     * Reads up to the next {@code \n} and decodes the bytes as UTF-8. The newline is not included.
     *
     * @return the line, or null if the client disconnected between lines
     * @throws IOException if the line exceeds {@link #MAX_LINE_BYTES} bytes, the stream ends
     *     before a newline, or the read times out
     */
    private static String readLine(InputStream in) throws IOException{
        var bytes = new ByteArrayOutputStream();
        while (true) {
            int b = in.read();
            if (b == -1) {
                if (bytes.size() == 0) {
                    return null;
                }
                throw new IOException("connection closed before a full line");
            }
            if (b == '\n') {
                return bytes.toString(StandardCharsets.UTF_8);
            }
            if (bytes.size() == MAX_LINE_BYTES) {
                throw new IOException("line too long");
            }
            bytes.write(b);
        }
    }
}
