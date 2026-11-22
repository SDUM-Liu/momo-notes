package io.github.sdumliu.momonotes;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.net.SocketTimeoutException;
import java.util.Arrays;
import java.util.Base64;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.ScheduledThreadPoolExecutor;
import java.util.concurrent.TimeUnit;

/** A foreground-only stream to a locally installed SSH server. */
final class LocalSsh {
    private static final int CHUNK = 16 * 1024;
    private static final int CONNECT_MS = 4000;
    private static final long IDLE_NS = TimeUnit.MINUTES.toNanos(10);
    private static final String CLOSED = "设备连接已结束";
    private final ExecutorService reader = Executors.newSingleThreadExecutor();
    private final ExecutorService writer = Executors.newSingleThreadExecutor();
    private final ScheduledThreadPoolExecutor timer = new ScheduledThreadPoolExecutor(1);
    private Session active;
    private boolean foreground;

    LocalSsh() { timer.setRemoveOnCancelPolicy(true); }

    private static final class Session {
        final String id = UUID.randomUUID().toString();
        final Socket socket = new Socket();
        volatile long lastData = System.nanoTime();
        byte[] banner;
        ScheduledFuture<?> idleCheck;
        boolean ready, reading, writing;
    }

    synchronized void setForeground(boolean value) {
        foreground = value;
        if (!value && active != null) drop(active);
    }

    synchronized void destroy() {
        setForeground(false);
        // Queued operations must still settle their futures after their sockets have closed.
        reader.shutdown();
        writer.shutdown();
        timer.shutdownNow();
    }

    synchronized CompletableFuture<String> open(Integer port) {
        if (!foreground) return failed("请保持桃桃便签在前台");
        if (port == null || port < 1 || port > 65535) return failed("SSH 端口无效");
        if (active != null) return failed("已有设备连接正在使用");
        Session session = new Session();
        active = session;
        session.idleCheck = timer.scheduleWithFixedDelay(() -> {
            if (System.nanoTime() - session.lastData >= IDLE_NS) drop(session);
        }, 30, 30, TimeUnit.SECONDS);
        return CompletableFuture.supplyAsync(() -> {
            try {
                session.socket.connect(new InetSocketAddress("127.0.0.1", port), CONNECT_MS);
                session.socket.setTcpNoDelay(true);
                session.banner = readBanner(session.socket);
                session.socket.setSoTimeout(1000);
                synchronized (this) {
                    if (active != session) throw new IOException(CLOSED);
                    session.ready = true;
                }
                return session.id;
            } catch (IOException error) {
                drop(session);
                throw problem("无法连接本机 SSH 服务，请确认端口和服务状态", error);
            }
        }, reader);
    }

    private static byte[] readBanner(Socket socket) throws IOException {
        long deadline = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(CONNECT_MS);
        InputStream input = socket.getInputStream();
        ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        while (bytes.size() < 255) {
            long remaining = deadline - System.nanoTime();
            if (remaining <= 0) throw new SocketTimeoutException();
            socket.setSoTimeout((int) Math.max(1, TimeUnit.NANOSECONDS.toMillis(remaining)));
            int next = input.read();
            if (next < 0) break;
            bytes.write(next);
            if (next == '\n') {
                if (!bytes.toString("US-ASCII").matches("SSH-2\\.0-[!-~]+(?: [ -~]*)?\\r?\\n")) break;
                return bytes.toByteArray();
            }
        }
        throw new IOException("服务未返回有效的 SSH-2.0 标识");
    }

    synchronized CompletableFuture<String> read(String id) {
        Session s = session(id);
        if (s == null) return failed(CLOSED);
        if (s.reading) return failed("已有读取正在进行");
        if (s.banner != null) {
            String data = Base64.getEncoder().encodeToString(s.banner);
            s.banner = null;
            return CompletableFuture.completedFuture(data);
        }
        s.reading = true;
        return CompletableFuture.supplyAsync(() -> {
            try {
                byte[] bytes = new byte[CHUNK];
                int count = s.socket.getInputStream().read(bytes);
                if (count < 0) {
                    drop(s);
                    return null;
                }
                s.lastData = System.nanoTime();
                return Base64.getEncoder().encodeToString(Arrays.copyOf(bytes, count));
            } catch (SocketTimeoutException timeout) {
                return "";
            } catch (IOException error) {
                drop(s);
                throw problem(CLOSED, error);
            } finally {
                synchronized (this) { s.reading = false; }
            }
        }, reader);
    }

    synchronized CompletableFuture<Void> write(String id, String data) {
        Session s = session(id);
        if (s == null) return failed(CLOSED);
        if (s.writing) return failed("已有写入正在进行");
        if (data == null || data.isEmpty() || data.length() > ((CHUNK + 2) / 3) * 4) return failed("无效的数据块");
        byte[] bytes;
        try { bytes = Base64.getDecoder().decode(data); }
        catch (IllegalArgumentException e) { return failed("无效的数据块"); }
        if (bytes.length > CHUNK) return failed("数据块过大");
        s.writing = true;
        ScheduledFuture<?> timeout = timer.schedule(() -> drop(s), 10, TimeUnit.SECONDS);
        return CompletableFuture.runAsync(() -> {
            try {
                s.socket.getOutputStream().write(bytes);
                s.lastData = System.nanoTime();
            } catch (IOException error) {
                drop(s);
                throw problem(CLOSED, error);
            } finally {
                timeout.cancel(false);
                synchronized (this) { s.writing = false; }
            }
        }, writer);
    }

    synchronized void close(String id) {
        Session s = session(id);
        if (s != null) drop(s);
    }

    private Session session(String id) {
        return active != null && active.ready && active.id.equals(id) ? active : null;
    }

    private synchronized void drop(Session s) {
        if (s != active) return;
        active = null;
        s.idleCheck.cancel(false);
        try { s.socket.close(); } catch (IOException ignored) { }
    }

    private static CompletionException problem(String message, Exception cause) {
        return new CompletionException(new IOException(message, cause));
    }

    private static <T> CompletableFuture<T> failed(String message) {
        CompletableFuture<T> future = new CompletableFuture<>();
        future.completeExceptionally(new IOException(message));
        return future;
    }
}
