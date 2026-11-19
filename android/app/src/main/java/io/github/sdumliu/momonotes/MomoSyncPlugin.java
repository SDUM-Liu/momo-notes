package io.github.sdumliu.momonotes;

import java.io.IOException;
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
