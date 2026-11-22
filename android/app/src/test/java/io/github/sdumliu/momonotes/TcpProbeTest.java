package io.github.sdumliu.momonotes;

import static org.junit.Assert.*;
import java.io.ByteArrayInputStream;
import java.io.DataInputStream;
import java.io.IOException;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import org.junit.Test;

public class TcpProbeTest {
    private static final int COOKIE = 0x2112a442;
    private static final byte[] TX = {1,2,3,4,5,6,7,8,9,10,11,12};
    private static final String ID = "0123456789abcdef0123456789abcdef";

    @Test public void acceptsOnlyPublicNumericIpv4AndNonPrivilegedPorts() throws Exception {
        assertEquals(65535, TcpProbe.endpoint("8.8.8.8:65535").getPort());
        for (String address : new String[]{"foo:1234", "[::1]:1234", "127.0.0.1:8888", "10.0.0.1:5555",
            "169.254.5.1:9876", "100.64.0.1:9999", "172.31.1.1:8888", "192.168.0.1:1234",
            "0.0.0.0:1234", "198.18.0.1:1234", "224.1.2.3:1234", "240.0.0.0:1234", "203.0.113.1:1234",
            "008.8.8.8:1234", "8.8.8.8:09999", "8.8.8.8:80", "8.8.8.8:65536", "8.8.8.8:9000/"}) {
            assertThrows(address, IOException.class, () -> TcpProbe.endpoint(address));
        }
    }

    private static byte[] reply() {
        return ByteBuffer.allocate(40).putShort((short)0x101).putShort((short)20).putInt(COOKIE).put(TX)
            .putShort((short)0x8022).putShort((short)1).putInt(0) // ignored attribute with 3 padding bytes
            .putShort((short)0x20).putShort((short)8).putShort((short)1)
            .putShort((short)(45000 ^ (COOKIE >>> 16))).putInt(0x08080404 ^ COOKIE).array();
    }

    private static String decode(byte[] bytes) throws IOException {
        return TcpProbe.binding(new DataInputStream(new ByteArrayInputStream(bytes)), TX);
    }

    @Test public void validatesBindingTransactionAndXorAddress() throws Exception {
        assertEquals("8.8.4.4:45000", decode(reply()));
        for (int index : new int[]{0,3,4,8,22,29,31,33}) {
            byte[] bad = reply(); bad[index] ^= 1;
            assertThrows("bad byte " + index, IOException.class, () -> decode(bad));
        }
        byte[] local = reply();
        ByteBuffer.wrap(local).putInt(36, 0x7f000001 ^ COOKIE);
        assertThrows(IOException.class, () -> decode(local));
        assertThrows(IOException.class, () -> decode(Arrays.copyOf(reply(), 39)));
    }

    private static byte[] mac(byte[] key, String label, byte[] first, byte[] second) throws Exception {
        Mac mac = Mac.getInstance("HmacSHA256"); mac.init(new SecretKeySpec(key, "HmacSHA256"));
        mac.update(("momo-tcp-diagnostic-v1/" + label).getBytes(StandardCharsets.UTF_8));
        mac.update(first); return mac.doFinal(second);
    }

    // The peer implements the Go wire format independently. Reflection, wrong proof,
    // and a peer which can send the proof but cannot confirm reception all fail.
    private void handshake(String mode, boolean accepted) throws Exception {
        InetAddress loopback = InetAddress.getByName("127.0.0.1");
        byte[] key = new byte[32]; Arrays.fill(key, (byte)0x5a);
        try (ServerSocket listener = new ServerSocket(0, 1, loopback)) {
            CompletableFuture<Boolean> checked = CompletableFuture.supplyAsync(() -> {
                try (Socket socket = listener.accept()) { return TcpProbe.authenticate(socket, key); }
                catch (Exception failure) { throw new RuntimeException(failure); }
            });
            try (Socket peer = new Socket(loopback, listener.getLocalPort())) {
                peer.setSoTimeout(3000);
                DataInputStream input = new DataInputStream(peer.getInputStream());
                byte[] hello = new byte[32], own = new byte[32], received = new byte[32];
                Arrays.fill(own, (byte)0x42); input.readFully(hello);
                peer.getOutputStream().write(mode.equals("reflect") ? hello : own);
                if (!mode.equals("reflect")) {
                    for (String label : new String[]{"proof","ack"}) {
                        input.readFully(received);
                        assertArrayEquals(mac(key, label, hello, own), received);
                        byte[] response = mac(key, label, own, hello);
                        if (mode.equals(label)) response[0] ^= 1;
                        peer.getOutputStream().write(response);
                        if (mode.equals(label)) break;
                    }
                }
                assertEquals(accepted, checked.get(4, TimeUnit.SECONDS));
            }
        }
    }

    @Test public void verifiesBothProofAndAckFromTheOtherPeer() throws Exception {
        handshake("ok", true); handshake("reflect", false); handshake("proof", false); handshake("ack", false);
    }

    @Test public void cancellationClosesOnlyTheForegroundOwnerAndSettlesPendingPrepare() throws Exception {
        CountDownLatch release = new CountDownLatch(1);
        TcpProbe probe = new TcpProbe(host -> {
            assertEquals("stunserver2025.stunprotocol.org", host);
            try { release.await(3, TimeUnit.SECONDS); } catch (InterruptedException stop) { Thread.currentThread().interrupt(); }
            return new InetAddress[0];
        });
        try {
            assertEquals("cancelled", probe.prepare(ID).get().reason);
            probe.foreground(true);
            assertEquals("invalid_id", probe.prepare("unknown").get().reason);
            CompletableFuture<TcpProbe.Result> opening = probe.prepare(ID);
            probe.cancel("unrelated");
            assertEquals("busy", probe.prepare(ID).get().reason);
            probe.foreground(false);
            assertEquals("cancelled", opening.get(2, TimeUnit.SECONDS).reason);
            assertEquals("expired", probe.run(ID, "8.8.8.8:12345", "").get().reason);
        } finally { release.countDown(); probe.destroy(); }
    }
}
