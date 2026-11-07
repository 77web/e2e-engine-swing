package dev.e2e.swing.agent;

import java.io.IOException;
import java.security.SecureRandom;
import java.util.HexFormat;

public final class Agent {
    public static void premain(String args) throws IOException {
        // generate token
        var bytes = new byte[32];
        new SecureRandom().nextBytes(bytes);
        var token = HexFormat.of().formatHex(bytes);

        // start server
        Server server = Server.bind(token);
        System.out.println("E2E_SWING_AGENT {\"port\":" + server.port() + ",\"token\":\"" + token + "\"}");
        System.out.flush();

        Thread t = new Thread(server::serve, "e2e-swing-agent");
        t.setDaemon(true);
        t.start();
    }
}
