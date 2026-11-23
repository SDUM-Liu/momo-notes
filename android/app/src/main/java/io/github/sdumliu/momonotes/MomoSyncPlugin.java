package io.github.sdumliu.momonotes;

import android.net.ConnectivityManager;
import android.net.LinkAddress;
import android.net.LinkProperties;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Intent;
import android.content.pm.PackageManager;
import java.io.DataInputStream;
import java.io.IOException;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionException;
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
    private static final String TERMUX_PACKAGE = "com.termux";
    private static final int TERMUX_SSH_PORT = 8023;
    private static final String TERMUX_SETUP = "(command -v sshd >/dev/null || pkg install -y openssh)"
        + " && (test -f \"$HOME/.momo-ssh-configured\" || (passwd && touch \"$HOME/.momo-ssh-configured\"))"
        + " && ssh-keygen -A && sshd -f /dev/null"
        + " -o AddressFamily=inet -o ListenAddress=127.0.0.1 -o Port=8023"
        + " -o PidFile=\"$HOME/.momo-sshd.pid\" -o PasswordAuthentication=yes"
        + " -o PermitEmptyPasswords=no -o AllowTcpForwarding=no -o X11Forwarding=no -o GatewayPorts=no";
    private final LocalSsh ssh = new LocalSsh();
    private final TcpProbe tcpProbe = new TcpProbe();
    private final OkHttpClient client = new OkHttpClient.Builder()
        .connectTimeout(5, TimeUnit.SECONDS).readTimeout(5, TimeUnit.SECONDS)
        .followRedirects(false).followSslRedirects(false).build();

    private java.io.OutputStream backupStream;
    private android.net.Uri backupUri;
    private String backupToken;

    @PluginMethod
    public void termuxStatus(PluginCall call) {
        final int uid;
        try {
            uid = getContext().getPackageManager().getApplicationInfo(TERMUX_PACKAGE, 0).uid;
        } catch (PackageManager.NameNotFoundException unavailable) {
            call.resolve(new JSObject().put("installed", false));
            return;
        }
        CompletableFuture.supplyAsync(() -> {
            JSObject state = new JSObject().put("installed", true).put("port", TERMUX_SSH_PORT);
            int appId = uid % 100000;
            if (appId >= 10000 && appId < 20000) {
                state.put("username", "u" + (uid / 100000) + "_a" + (appId - 10000));
            }
            try (Socket socket = new Socket()) {
                socket.connect(new InetSocketAddress("127.0.0.1", TERMUX_SSH_PORT), 900);
                socket.setSoTimeout(900);
                byte[] banner = new byte[4];
                new DataInputStream(socket.getInputStream()).readFully(banner);
                state.put("ready", "SSH-".equals(new String(banner, StandardCharsets.US_ASCII)));
            } catch (IOException unavailable) {
                state.put("ready", false);
            }
            return state;
        }).thenAccept(call::resolve);
    }

    @PluginMethod
    public void openTermuxSetup(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            Intent termux = getContext().getPackageManager().getLaunchIntentForPackage(TERMUX_PACKAGE);
            if (termux == null) { call.reject("请先安装官方 Termux"); return; }
            ClipboardManager clipboard = getContext().getSystemService(ClipboardManager.class);
            if (clipboard == null) { call.reject("无法访问系统剪贴板"); return; }
            clipboard.setPrimaryClip(ClipData.newPlainText("桃桃 Termux 配置", TERMUX_SETUP));
            try {
                getActivity().startActivity(termux);
                call.resolve();
            } catch (android.content.ActivityNotFoundException unavailable) {
                call.reject("无法打开 Termux，请从应用列表打开，再粘贴配置命令");
            }
        });
    }

    @PluginMethod
    public void tcpProbePrepare(PluginCall call) {
        probeReply(call, tcpProbe.prepare(call.getString("id")));
    }

    @PluginMethod
    public void tcpProbeRun(PluginCall call) {
        probeReply(call, tcpProbe.run(call.getString("id"), call.getString("endpoint"), call.getString("token")));
    }

    @PluginMethod
    public void tcpProbeCancel(PluginCall call) {
        tcpProbe.cancel(call.getString("id"));
        call.resolve(new JSObject());
    }

    private void probeReply(PluginCall call, CompletableFuture<TcpProbe.Result> operation) {
        operation.thenAccept(answer -> {
            JSObject result = new JSObject();
            if (answer.endpoint != null) result.put("endpoint", answer.endpoint);
            else result.put("ok", answer.reason == null);
            if (answer.reason != null) result.put("reason", answer.reason);
            call.resolve(result);
        });
    }

    @PluginMethod
    public void sshLocalOpen(PluginCall call) {
        sshReply(call, ssh.open(call.getInt("port")), "id");
    }

    @PluginMethod
    public void sshLocalRead(PluginCall call) {
        sshReply(call, ssh.read(call.getString("id")), "data");
    }

    @PluginMethod
    public void sshLocalWrite(PluginCall call) {
        sshReply(call, ssh.write(call.getString("id"), call.getString("data")), null);
    }

    @PluginMethod
    public void sshLocalClose(PluginCall call) {
        ssh.close(call.getString("id"));
        call.resolve();
    }

    private void sshReply(PluginCall call, CompletableFuture<?> operation, String key) {
        operation.whenComplete((value, error) -> {
            if (error != null) {
                Throwable why = error instanceof CompletionException ? error.getCause() : error;
                call.reject(why.getMessage());
                return;
            }
            JSObject result = new JSObject();
            if (key != null) result.put(key, value != null ? value : JSONObject.NULL);
            call.resolve(result);
        });
    }

    @Override
    protected void handleOnResume() {
        super.handleOnResume();
        ssh.setForeground(true);
        tcpProbe.foreground(true);
    }

    @Override
    protected void handleOnPause() {
        ssh.setForeground(false);
        tcpProbe.foreground(false);
        super.handleOnPause();
    }

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
        ssh.destroy();
        tcpProbe.destroy();
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
