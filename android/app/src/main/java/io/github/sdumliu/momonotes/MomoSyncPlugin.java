package io.github.sdumliu.momonotes;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

@CapacitorPlugin(name = "MomoSync")
public class MomoSyncPlugin extends Plugin {
    private static final int LIMIT = 32 * 1024 * 1024;
    private final ExecutorService transfers = Executors.newFixedThreadPool(3);

    @PluginMethod
    public void updateWidget(PluginCall call) {
        TodayWidget.save(getContext(), call.getString("date", ""), call.getInt("count", 0),
            call.getString("preview", ""));
        call.resolve();
    }

    @PluginMethod
    public void exchange(PluginCall call) {
        String host = call.getString("host", "");
        String message = call.getString("message", "");
        if (!host.matches("\\d{1,3}(\\.\\d{1,3}){3}") || message.length() > LIMIT || message.contains("\n")) {
            call.reject("同步请求无效");
            return;
        }
        for (String part : host.split("\\.")) {
            if (Integer.parseInt(part) > 255) {
                call.reject("主机地址无效");
                return;
            }
        }
        transfers.execute(() -> transfer(call, host, message));
    }

    private void transfer(PluginCall call, String host, String message) {
        try (Socket socket = new Socket()) {
            socket.connect(new InetSocketAddress(host, 38425), 6000);
            socket.setSoTimeout(65000);
            socket.getOutputStream().write((message + "\n").getBytes(StandardCharsets.US_ASCII));
            InputStream input = socket.getInputStream();
            ByteArrayOutputStream buffer = new ByteArrayOutputStream();
            byte[] chunk = new byte[8192];
            int size;
            while ((size = input.read(chunk)) != -1) {
                int end = 0;
                while (end < size && chunk[end] != 10) end++;
                if (buffer.size() + end > LIMIT) throw new IllegalStateException("Response too large");
                buffer.write(chunk, 0, end);
                if (end < size) {
                    JSObject result = new JSObject();
                    result.put("message", buffer.toString("US-ASCII"));
                    call.resolve(result);
                    return;
                }
            }
        } catch (Exception error) {
            call.reject("没有收到主机回复", "SYNC_CONNECTION");
            return;
        }
        call.reject("主机未接受配对", "SYNC_AUTH");
    }

    @Override
    protected void handleOnDestroy() { transfers.shutdownNow(); }
}
