package io.github.sdumliu.momonotes;

import java.io.Closeable;
import java.io.DataInputStream;
import java.io.IOException;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.SocketOption;
import java.net.StandardSocketOptions;
import java.nio.ByteBuffer;
import java.nio.channels.NetworkChannel;
import java.nio.channels.ServerSocketChannel;
import java.nio.channels.SocketChannel;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.Arrays;
import java.util.HashSet;
import java.util.Set;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.ScheduledThreadPoolExecutor;
import java.util.concurrent.SynchronousQueue;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;

/** A short, foreground-only test. The observer socket holds the NAT mapping until the test ends. */
final class TcpProbe {
    private static final String OBSERVER = "stunserver2025.stunprotocol.org";
    private static final int COOKIE = 0x2112a442;
    private static final int RUN_SECONDS = 22;
    private static final SecureRandom RANDOM = new SecureRandom();
    private static final ThreadFactory THREADS = r -> {
        Thread thread = new Thread(r, "Momo TCP diagnostic");
        thread.setDaemon(true);
        return thread;
    };
    private final ThreadPoolExecutor workers = new ThreadPoolExecutor(0, 3, 15, TimeUnit.SECONDS,
        new SynchronousQueue<>(), THREADS);
    private final ScheduledThreadPoolExecutor clock = new ScheduledThreadPoolExecutor(1, THREADS);
    interface Resolver { InetAddress[] lookup(String host) throws IOException; }
    private final Resolver resolver;
    private Session active;
    private boolean foreground;
    private boolean destroyed;

    TcpProbe() { this(InetAddress::getAllByName); }
    TcpProbe(Resolver resolver) { this.resolver = resolver; clock.setRemoveOnCancelPolicy(true); }

    static final class Result {
        final String endpoint, reason;
        Result(String endpoint, String reason) { this.endpoint = endpoint; this.reason = reason; }
    }

    private static class Session {
        final String id;
        final Set<Closeable> sockets = new HashSet<>();
        final CompletableFuture<Result> prepare = new CompletableFuture<>();
        final CompletableFuture<Result> run = new CompletableFuture<>();
        InetSocketAddress local;
        String mapped;
        boolean running, failedProof;
        int deadlineVersion;
        ScheduledFuture<?> expiry;
        Session(String id) { this.id = id; }
    }

    private static CompletableFuture<Result> failure(String reason) {
        return CompletableFuture.completedFuture(new Result(null, reason));
    }

    synchronized void foreground(boolean enabled) {
        foreground = enabled;
        if (!enabled && active != null) finish(active, "cancelled");
    }

    synchronized void destroy() {
        destroyed = true;
        foreground(false);
        workers.shutdownNow();
        clock.shutdownNow();
    }

    synchronized void cancel(String id) {
        if (active != null && active.id.equals(id)) finish(active, "cancelled");
    }

    private static void close(Closeable socket) {
        try { socket.close(); } catch (IOException ignored) { }
    }

    private synchronized <T extends Closeable> T track(Session session, T socket) throws IOException {
        if (active != session) { close(socket); throw new IOException("cancelled"); }
        session.sockets.add(socket);
        return socket;
    }

    private synchronized void release(Session session, Closeable socket) {
        if (socket != null) { session.sockets.remove(socket); close(socket); }
    }

    private synchronized void finish(Session session, String reason) {
        if (active != session) return;
        active = null;
        if (session.expiry != null) session.expiry.cancel(false);
        for (Closeable socket : session.sockets) close(socket);
        session.sockets.clear();
        Result result = new Result(null, reason);
        session.prepare.complete(result);
        session.run.complete(result);
    }

    private void deadline(Session session, int seconds, String reason) {
        if (session.expiry != null) session.expiry.cancel(false);
        int version = ++session.deadlineVersion;
        session.expiry = clock.schedule(() -> {
            synchronized (TcpProbe.this) {
                if (session.deadlineVersion == version)
                    finish(session, session.failedProof && session.running ? "peer_handshake_failed" : reason);
            }
        }, seconds, TimeUnit.SECONDS);
    }

    synchronized CompletableFuture<Result> prepare(String id) {
        if (id == null || !id.matches("[0-9a-f]{32}")) return failure("invalid_id");
        if (!foreground || destroyed) return failure("cancelled");
        if (active != null) return failure("busy");
        Session session = new Session(id);
        active = session;
        deadline(session, 12, "observer_unavailable");
        try { workers.execute(() -> observe(session)); }
        catch (RejectedExecutionException busy) { finish(session, "busy"); }
        return session.prepare;
    }

    // Some Android versions do not expose SO_REUSEPORT; SO_REUSEADDR is still available.
    private static void reusable(NetworkChannel channel) throws IOException {
        channel.setOption(StandardSocketOptions.SO_REUSEADDR, true);
        for (SocketOption<?> option : channel.supportedOptions()) {
            if ("SO_REUSEPORT".equals(option.name()) && option.type() == Boolean.class) {
                @SuppressWarnings("unchecked") SocketOption<Boolean> reuse = (SocketOption<Boolean>) option;
                try { channel.setOption(reuse, true); } catch (IOException | UnsupportedOperationException ignored) { }
                break;
            }
        }
    }

    private Socket socket(Session session) throws IOException {
        SocketChannel channel = SocketChannel.open();
        try { reusable(channel); return track(session, channel.socket()); }
        catch (IOException | RuntimeException error) { close(channel); throw error; }
    }

    private void observe(Session session) {
        try {
            InetAddress observer = null;
            for (InetAddress address : resolver.lookup(OBSERVER)) {
                if (isPublic(address)) { observer = address; break; }
            }
            if (observer == null) throw new IOException("observer_unavailable");
            Socket stun = socket(session);
            stun.connect(new InetSocketAddress(observer, 3478), 5000);
            stun.setSoTimeout(5000);
            byte[] transaction = new byte[12]; RANDOM.nextBytes(transaction);
            byte[] request = ByteBuffer.allocate(20).putShort((short)1).putShort((short)0)
                .putInt(COOKIE).put(transaction).array();
            stun.getOutputStream().write(request);
            String mapped = binding(new DataInputStream(stun.getInputStream()), transaction);
            synchronized (this) {
                if (active != session) return;
                session.local = (InetSocketAddress) stun.getLocalSocketAddress();
                session.mapped = mapped;
                deadline(session, 55, "expired");
                session.prepare.complete(new Result(mapped, null));
            }
        } catch (IOException | RuntimeException error) { finish(session, "observer_unavailable"); }
    }

    static String binding(DataInputStream in, byte[] transaction) throws IOException {
        int type = in.readUnsignedShort(), length = in.readUnsignedShort(), cookie = in.readInt();
        byte[] reply = new byte[12]; in.readFully(reply);
        if (type != 0x0101 || cookie != COOKIE || !Arrays.equals(transaction, reply) ||
            length > 4096 || length % 4 != 0) throw new IOException("invalid_mapping");
        byte[] data = new byte[length]; in.readFully(data);
        ByteBuffer body = ByteBuffer.wrap(data);
        String mapped = null;
        while (body.remaining() >= 4) {
            int attr = body.getShort() & 0xffff, size = body.getShort() & 0xffff;
            int start = body.position(), padded = (size + 3) & ~3;
            if (padded > body.remaining()) throw new IOException("invalid_mapping");
            if (attr == 0x0020 && size == 8 && body.get(start + 1) == 1 && mapped == null) {
                int port = (body.getShort(start + 2) & 0xffff) ^ (COOKIE >>> 16);
                InetAddress ip = InetAddress.getByAddress(ByteBuffer.allocate(4).putInt(body.getInt(start + 4) ^ COOKIE).array());
                if (!isPublic(ip) || port < 1024) throw new IOException("invalid_mapping");
                mapped = ip.getHostAddress() + ":" + port;
            }
            body.position(start + padded);
        }
        if (mapped == null) throw new IOException("invalid_mapping");
        return mapped;
    }

    private static boolean isPublic(InetAddress ip) {
        if (!(ip instanceof Inet4Address)) return false;
        byte[] bytes = ip.getAddress();
        int a = bytes[0] & 255, b = bytes[1] & 255, c = bytes[2] & 255;
        return a != 0 && a != 10 && a != 127 && a < 224 &&
            !(a == 100 && b >= 64 && b <= 127 || a == 169 && b == 254 || a == 172 && b >= 16 && b <= 31) &&
            !(a == 192 && (b == 168 || b == 0 && (c == 0 || c == 2) || b == 88 && c == 99)) &&
            !(a == 198 && (b == 18 || b == 19 || b == 51 && c == 100) || a == 203 && b == 0 && c == 113);
    }

    static InetSocketAddress endpoint(String value) throws IOException {
        if (value == null || !value.matches("(?:[0-9]{1,3}\\.){3}[0-9]{1,3}:[0-9]{1,5}")) throw new IOException("invalid_peer");
        String[] parts = value.split("[.:]");
        byte[] bytes = new byte[4];
        for (int i = 0; i < 4; i++) {
            int octet = Integer.parseInt(parts[i]);
            if (octet > 255 || !String.valueOf(octet).equals(parts[i])) throw new IOException("invalid_peer");
            bytes[i] = (byte)octet;
        }
        InetAddress ip = InetAddress.getByAddress(bytes);
        int port = Integer.parseInt(parts[4]);
        if (!isPublic(ip) || port < 1024 || port > 65535 || !String.valueOf(port).equals(parts[4])) throw new IOException("invalid_peer");
        return new InetSocketAddress(ip, port);
    }

    synchronized CompletableFuture<Result> run(String id, String target, String token) {
        Session session = active;
        if (session == null || !session.id.equals(id) || session.local == null) return failure("expired");
        if (session.running) return failure("busy");
        InetSocketAddress remote;
        try { remote = endpoint(target); }
        catch (IOException invalid) { finish(session, "invalid_peer"); return session.run; }
        if (target.equals(session.mapped) || token == null || !token.matches("[0-9a-fA-F]{64}")) {
            finish(session, "invalid_peer"); return session.run;
        }
        byte[] key = new byte[32];
        for (int i = 0; i < key.length; i++) key[i] = (byte)Integer.parseInt(token.substring(i*2, i*2+2), 16);
        session.running = true;
        deadline(session, RUN_SECONDS, "no_authenticated_peer");
        try {
            workers.execute(() -> listen(session, remote, key));
            workers.execute(() -> dial(session, remote, key));
        } catch (RejectedExecutionException busy) { finish(session, "busy"); }
        return session.run;
    }

    private synchronized boolean current(Session session) { return active == session; }

    private void listen(Session session, InetSocketAddress remote, byte[] key) {
        ServerSocketChannel channel = null;
        ScheduledFuture<?> stop = null;
        try {
            channel = track(session, ServerSocketChannel.open());
            reusable(channel);
            ServerSocket listener = channel.socket();
            listener.bind(session.local, 4);
            // On kernels without port sharing this leaves the second half for active-only trials.
            stop = clock.schedule(() -> close(listener), RUN_SECONDS/2, TimeUnit.SECONDS);
            while (current(session)) {
                Socket peer = track(session, listener.accept());
                try {
                    if (peer.getInetAddress().equals(remote.getAddress()) && verifyPeer(session, peer, key)) return;
                } finally { release(session, peer); }
            }
        } catch (IOException | RuntimeException ignored) { /* outbound trials still run */ }
        finally { if (stop != null) stop.cancel(false); release(session, channel); }
    }

    private void dial(Session session, InetSocketAddress remote, byte[] key) {
        while (current(session)) {
            Socket peer = null;
            try {
                peer = socket(session);
                peer.bind(session.local);
                peer.connect(remote, 2000);
                if (verifyPeer(session, peer, key)) return;
            } catch (IOException | RuntimeException ignored) { /* retry until deadline */ }
            finally { release(session, peer); }
            try { Thread.sleep(380); } catch (InterruptedException stop) { Thread.currentThread().interrupt(); return; }
        }
    }

    private boolean verifyPeer(Session session, Socket peer, byte[] key) {
        try {
            if (authenticate(peer, key)) { finish(session, null); return true; }
        } catch (IOException | GeneralSecurityException ignored) { }
        synchronized (this) { session.failedProof = true; }
        return false;
    }

    static boolean authenticate(Socket peer, byte[] key) throws IOException, GeneralSecurityException {
        peer.setSoTimeout(1800);
        peer.setTcpNoDelay(true);
        byte[] mine = new byte[32], theirs = new byte[32], reply = new byte[32];
        RANDOM.nextBytes(mine);
        DataInputStream input = new DataInputStream(peer.getInputStream());
        peer.getOutputStream().write(mine);
        input.readFully(theirs);
        if (MessageDigest.isEqual(mine, theirs)) return false;
        Mac mac = Mac.getInstance("HmacSHA256");
        mac.init(new SecretKeySpec(key, "HmacSHA256"));
        for (String label : new String[]{"proof", "ack"}) {
            peer.getOutputStream().write(proof(mac, label, mine, theirs));
            input.readFully(reply);
            if (!MessageDigest.isEqual(reply, proof(mac, label, theirs, mine))) return false;
        }
        return true;
    }

    private static byte[] proof(Mac mac, String label, byte[] from, byte[] to) {
        mac.update(("momo-tcp-diagnostic-v1/" + label).getBytes(StandardCharsets.UTF_8));
        mac.update(from);
        return mac.doFinal(to);
    }
}
