package io.github.sdumliu.momonotes;

import static org.junit.Assert.*;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.Base64;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.TimeUnit;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;

public class LocalSshTest {
    private final LocalSsh bridge = new LocalSsh();
    private ServerSocket server;
    private static final byte[] BANNER = "SSH-2.0-Test_Server test\r\n".getBytes(StandardCharsets.US_ASCII);

    @Before public void setUp() throws Exception {
        server = new ServerSocket(0, 1, InetAddress.getByName("127.0.0.1"));
        server.setSoTimeout(5000);
        bridge.setForeground(true);
    }

    @After public void tearDown() throws Exception {
        bridge.destroy();
        server.close();
    }

    private static <T> T result(CompletableFuture<T> future) throws Exception {
        return future.get(6, TimeUnit.SECONDS);
    }

    private static void rejects(CompletableFuture<?> future) throws Exception {
        try { result(future); fail("Operation should fail"); }
        catch (ExecutionException expected) { assertNotNull(expected.getCause()); }
    }

    @Test public void fullDuplexPreservesBannerAndEof() throws Exception {
        CompletableFuture<String> opening = bridge.open(server.getLocalPort());
        try (Socket peer = server.accept()) {
            peer.setSoTimeout(3000);
            rejects(bridge.open(server.getLocalPort()));
            peer.getOutputStream().write(BANNER, 0, 5);
            peer.getOutputStream().write(BANNER, 5, BANNER.length - 5);
            peer.getOutputStream().write(new byte[]{0, 7, (byte) 255});
            String id = result(opening);
            assertArrayEquals(BANNER, Base64.getDecoder().decode(result(bridge.read(id))));
            assertArrayEquals(new byte[]{0, 7, (byte) 255}, Base64.getDecoder().decode(result(bridge.read(id))));
            assertEquals("", result(bridge.read(id)));
            CompletableFuture<String> pending = bridge.read(id);
            rejects(bridge.read(id));
            result(bridge.write(id, "YQ=="));
            assertEquals('a', peer.getInputStream().read());
            peer.getOutputStream().write('b');
            assertEquals("Yg==", result(pending));
            rejects(bridge.write(id, "%%%"));
            rejects(bridge.write(id, Base64.getEncoder().encodeToString(new byte[16385])));
            peer.shutdownOutput();
            assertNull(result(bridge.read(id)));
            rejects(bridge.write(id, "YQ=="));
        }
    }

    @Test public void onlyVerifiedLocalServerWhileInForeground() throws Exception {
        rejects(bridge.open(0));
        CompletableFuture<String> bad = bridge.open(server.getLocalPort());
        try (Socket peer = server.accept()) {
            peer.getOutputStream().write("HTTP/1.1 200 OK\r\n".getBytes(StandardCharsets.US_ASCII));
            rejects(bad);
        }
        CompletableFuture<String> opening = bridge.open(server.getLocalPort());
        try (Socket peer = server.accept()) {
            peer.setSoTimeout(3000);
            peer.getOutputStream().write(BANNER);
            String id = result(opening);
            result(bridge.read(id));
            bridge.close("wrong-id");
            CompletableFuture<String> pending = bridge.read(id);
            bridge.setForeground(false);
            rejects(pending);
            assertEquals(-1, peer.getInputStream().read());
            rejects(bridge.open(server.getLocalPort()));
            bridge.setForeground(true);
            rejects(bridge.read(id));
        }
    }

    @Test public void unfinishedBannerCannotReservePortIndefinitely() throws Exception {
        CompletableFuture<String> silent = bridge.open(server.getLocalPort());
        try (Socket peer = server.accept()) {
            peer.getOutputStream().write("SSH-2.0-Test".getBytes(StandardCharsets.US_ASCII));
            rejects(silent);
        }
        CompletableFuture<String> tooLong = bridge.open(server.getLocalPort());
        try (Socket peer = server.accept()) {
            peer.getOutputStream().write(new byte[256]);
            rejects(tooLong);
        }
    }
}
