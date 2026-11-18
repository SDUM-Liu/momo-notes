package io.github.sdumliu.momonotes;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.InetSocketAddress;
import java.net.Proxy;
import java.net.URL;
import java.nio.charset.StandardCharsets;

@CapacitorPlugin(name = "MomoProxy")
public class MomoProxyPlugin extends Plugin {
    @PluginMethod
    public void post(PluginCall call) {
        Integer port = call.getInt("port");
        String address = call.getString("url");
        String body = call.getString("body");
        if (port == null || port < 1 || port > 65535 || address == null || body == null) {
            call.reject("API 地址或代理端口无效");
            return;
        }

        HttpURLConnection connection = null;
        try {
            URL url = new URL(address);
            boolean local = url.getHost().equals("localhost") || url.getHost().equals("127.0.0.1")
                || url.getHost().equals("[::1]");
            if (url.getUserInfo() != null || !(url.getProtocol().equals("https") || (local && url.getProtocol().equals("http")))) {
                call.reject("API 地址需使用 HTTPS");
                return;
            }
            Proxy proxy = new Proxy(Proxy.Type.HTTP, new InetSocketAddress("127.0.0.1", port));
            connection = (HttpURLConnection) url.openConnection(proxy);
            connection.setRequestMethod("POST");
            connection.setConnectTimeout(15000);
            connection.setReadTimeout(45000);
            connection.setInstanceFollowRedirects(false);
            connection.setRequestProperty("Content-Type", "application/json");
            String authorization = call.getString("authorization");
            if (authorization != null && !authorization.isEmpty()) {
                connection.setRequestProperty("Authorization", authorization);
            }
            connection.setDoOutput(true);
            try (OutputStream stream = connection.getOutputStream()) {
                stream.write(body.getBytes(StandardCharsets.UTF_8));
            }
            int status = connection.getResponseCode();
            String response = "";
            if (status >= 200 && status < 300) {
                try (InputStream stream = connection.getInputStream(); ByteArrayOutputStream buffer = new ByteArrayOutputStream()) {
                    byte[] chunk = new byte[8192];
                    int count;
                    while ((count = stream.read(chunk)) != -1) {
                        if (buffer.size() + count > 2 * 1024 * 1024) {
                            call.reject("AI 返回内容过长");
                            return;
                        }
                        buffer.write(chunk, 0, count);
                    }
                    response = new String(buffer.toByteArray(), StandardCharsets.UTF_8);
                }
            }
            JSObject result = new JSObject();
            result.put("status", status);
            result.put("body", response);
            call.resolve(result);
        } catch (Exception error) {
            call.reject("连不上 AI API，请检查地址和本地代理端口");
        } finally {
            if (connection != null) connection.disconnect();
        }
    }
}
