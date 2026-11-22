package io.github.sdumliu.momonotes;

import android.net.ConnectivityManager;
import android.net.LinkAddress;
import android.net.LinkProperties;
import android.net.Network;
import android.net.NetworkCapabilities;
import java.io.IOException;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.util.concurrent.TimeUnit;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import okhttp3.Call;
import okhttp3.Callback;
import okhttp3.HttpUrl;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.WebSocket;
import okhttp3.WebSocketListener;
import org.json.JSONObject;

@CapacitorPlugin(name = "MomoSync")
public class MomoSyncPlugin extends Plugin {
    private final OkHttpClient client = new OkHttpClient.Builder()
        .connectTimeout(5, TimeUnit.SECONDS).readTimeout(5, TimeUnit.SECONDS)
        .followRedirects(false).followSslRedirects(false).build();

    private java.io.OutputStream backupStream;
    private android.net.Uri backupUri;
    private String backupToken;

    @PluginMethod
    public void wifiAddress(PluginCall call) {
        ConnectivityManager manager = getContext().getSystemService(ConnectivityManager.class);
        Network network = manager == null ? null : manager.getActiveNetwork();
        if (network != null) {
            NetworkCapabilities capabilities = manager.getNetworkCapabilities(network);
            LinkProperties properties = manager.getLinkProperties(network);
            if (properties != null && capabilities != null
                    && capabilities.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)
                    && !capabilities.hasTransport(NetworkCapabilities.TRANSPORT_VPN)) {
                for (LinkAddress link : properties.getLinkAddresses()) {
                    InetAddress address = link.getAddress();
                    if (address instanceof Inet4Address && !address.isLoopbackAddress() && !address.isLinkLocalAddress()) {
                        JSObject result = new JSObject();
                        result.put("address", address.getHostAddress());
                        call.resolve(result);
                        return;
                    }
                }
            }
        }
        call.reject("请在 Wi-Fi 网络详情中查看设备地址");
    }

    @PluginMethod
    public void saveBackup(PluginCall call) {
        android.content.Intent intent = new android.content.Intent(android.content.Intent.ACTION_CREATE_DOCUMENT);
        intent.addCategory(android.content.Intent.CATEGORY_OPENABLE);
        intent.setType("application/octet-stream");
        intent.putExtra(android.content.Intent.EXTRA_TITLE, "桃桃便签.momobackup");
        startActivityForResult(call, intent, "backupDestination");
    }

    @com.getcapacitor.annotation.ActivityCallback
    private synchronized void backupDestination(PluginCall call, androidx.activity.result.ActivityResult result) {
        if (call == null) return;
        android.content.Intent data = result.getData();
        if (result.getResultCode() != android.app.Activity.RESULT_OK || data == null || data.getData() == null) {
            call.reject("保存已取消");
            return;
        }
        if (backupStream != null) { call.reject("已有备份正在写入"); return; }
        try {
            backupUri = data.getData();
            backupStream = getContext().getContentResolver().openOutputStream(backupUri, "wt");
            if (backupStream == null) throw new IOException();
            backupToken = java.util.UUID.randomUUID().toString();
            JSObject answer = new JSObject();
            answer.put("token", backupToken);
            call.resolve(answer);
        } catch (Exception error) { call.reject("无法创建迁移包"); }
    }

    @PluginMethod
    public synchronized void appendBackup(PluginCall call) {
        if (backupToken == null || !backupToken.equals(call.getString("token"))) { call.reject("备份已结束"); return; }
        String encoded = call.getString("part");
        if (encoded == null || encoded.length() > 400000) { call.reject("无效的备份数据块"); return; }
        try {
            backupStream.write(android.util.Base64.decode(encoded, android.util.Base64.NO_WRAP));
            call.resolve();
        } catch (Exception error) { call.reject("备份写入失败，请检查可用空间"); }
    }

    private void finishBackup(boolean abort) throws IOException {
        try {
            if (backupStream != null) backupStream.close();
        } catch (IOException error) { abort = true; throw error; }
        finally {
            if (abort && backupUri != null) {
                try { android.provider.DocumentsContract.deleteDocument(getContext().getContentResolver(), backupUri); }
                catch (Exception ignored) { }
            }
            backupToken = null; backupStream = null; backupUri = null;
        }
    }

    @PluginMethod
    public synchronized void closeBackup(PluginCall call) {
        if (backupToken == null || !backupToken.equals(call.getString("token"))) { call.reject("备份已结束"); return; }
        try { finishBackup(call.getBoolean("abort", false)); call.resolve(); }
        catch (Exception error) { call.reject("迁移包保存失败"); }
    }

    @Override
    protected synchronized void handleOnDestroy() {
        try { finishBackup(true); } catch (IOException ignored) { }
        super.handleOnDestroy();
    }

    @PluginMethod
    public void diagnose(PluginCall call) {
        HttpUrl origin;
        try {
            origin = HttpUrl.get(call.getString("relay", ""));
        } catch (IllegalArgumentException error) {
            call.reject("同步服务地址无效");
            return;
        }
        String room = call.getString("room", "");
        String token = call.getString("token", "");
        if (!origin.isHttps() || !origin.username().isEmpty() || !origin.password().isEmpty() ||
                !origin.encodedPath().equals("/") || origin.query() != null || origin.fragment() != null ||
                !room.matches("[a-f0-9]{64}") || !token.matches("join\\.[a-f0-9]{64}")) {
            call.reject("同步服务地址或配对码无效");
            return;
        }

        Request upgrade = request(origin.newBuilder().addPathSegment("v1").addPathSegment(room).build())
            .header("Sec-WebSocket-Protocol", "momo-sync-v1, " + token).build();
        client.newWebSocket(upgrade, new WebSocketListener() {
            @Override
            public void onOpen(WebSocket socket, Response response) {
                socket.close(1000, null);
                result(call, "websocket_unavailable");
            }

            @Override
            public void onFailure(WebSocket socket, Throwable error, Response response) {
                // A peer probe never sends data. HTTP errors from the relay's upgrade identify the failure.
                int status = response == null ? 0 : response.code();
                if (status == 503) result(call, "host_offline");
                else if (status == 403 && "0".equals(response.header("Content-Length"))) result(call, "unauthorized");
                else if (status == 429 && "0".equals(response.header("Content-Length"))) result(call, "room_full");
                else checkHealth(call, origin);
            }
        });
    }

    private Request.Builder request(HttpUrl url) {
        return new Request.Builder().url(url).header("User-Agent", "MomoNotes Android");
    }

    private void checkHealth(PluginCall call, HttpUrl origin) {
        Request health = request(origin.newBuilder().addPathSegment("health").build()).build();
        Call healthCall = client.newCall(health);
        healthCall.timeout().timeout(5, TimeUnit.SECONDS);
        healthCall.enqueue(new Callback() {
            @Override
            public void onFailure(Call request, IOException error) {
                result(call, "service_unavailable");
            }

            @Override
            public void onResponse(Call request, Response response) {
                String status = "service_unavailable";
                try (Response closeable = response) {
                    if (response.isSuccessful() && response.body() != null) {
                        String body = response.peekBody(1024).string();
                        if ("momo-sync".equals(new JSONObject(body).optString("service"))) status = "websocket_unavailable";
                    }
                } catch (Exception ignored) {}
                result(call, status);
            }
        });
    }

    private void result(PluginCall call, String status) {
        JSObject payload = new JSObject();
        payload.put("status", status);
        call.resolve(payload);
    }

    @PluginMethod
    public void updateWidget(PluginCall call) {
        TodayWidget.save(getContext(), call.getString("date", ""), call.getInt("count", 0),
            call.getString("preview", ""));
        call.resolve();
    }
}
