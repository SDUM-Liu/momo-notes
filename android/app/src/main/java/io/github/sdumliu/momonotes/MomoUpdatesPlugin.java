package io.github.sdumliu.momonotes;

import android.content.ClipData;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.provider.Settings;
import android.util.Base64;
import android.util.Log;
import androidx.core.content.FileProvider;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.FileOutputStream;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.math.BigInteger;
import java.security.MessageDigest;
import java.util.Arrays;
import java.util.Locale;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import okhttp3.Call;
import okhttp3.Callback;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;

@CapacitorPlugin(name = "MomoUpdates")
public class MomoUpdatesPlugin extends Plugin {
    private static final String APK = "application/vnd.android.package-archive";
    private static final long MAX_BYTES = 256L * 1024 * 1024;
    private static final int BLOCK = 512 * 1024;
    private static final String REPO = "https://github.com/SDUM-Liu/momo-notes/releases/download/";
    private final OkHttpClient client = new OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS).readTimeout(30, TimeUnit.SECONDS)
        .callTimeout(12, TimeUnit.MINUTES).followSslRedirects(false).build();
    private static final AtomicBoolean downloading = new AtomicBoolean();
    private String relayVersion, relaySha;
    private int relaySize, relayBytes;

    private SharedPreferences preferences() {
        return getContext().getSharedPreferences("momo-updates", android.content.Context.MODE_PRIVATE);
    }

    private File directory() { return new File(getContext().getCacheDir(), "updates"); }
    private File archive(String version) { return new File(directory(), "update-" + version + ".apk"); }
    private File partial() { return new File(getContext().getFilesDir(), "update.part.apk"); }

    private void discardPartial() throws IOException {
        if (partial().exists() && !partial().delete()) throw new IOException("无法重置更新缓存");
        preferences().edit().remove("partVersion").remove("partSha").remove("partSize").commit();
    }

    private long preparePartial(String version, long size, String sha) throws IOException {
        SharedPreferences prefs = preferences();
        if (!version.equals(prefs.getString("partVersion", "")) ||
                !sha.equals(prefs.getString("partSha", "")) || size != prefs.getLong("partSize", -1) ||
                partial().length() > size) {
            discardPartial();
            if (!prefs.edit().putString("partVersion", version).putString("partSha", sha).putLong("partSize", size).commit()) {
                throw new IOException("无法保存续传记录");
            }
        }
        return partial().length();
    }

    private static long versionCode(String version) {
        if (!version.matches("[0-9]{1,3}\\.[0-9]{1,3}\\.[0-9]{1,3}")) return -1;
        String[] parts = version.split("\\.");
        return Integer.parseInt(parts[0]) * 1_000_000L + Integer.parseInt(parts[1]) * 1000L + Integer.parseInt(parts[2]);
    }

    private PackageInfo installed() throws PackageManager.NameNotFoundException {
        return getContext().getPackageManager().getPackageInfo(getContext().getPackageName(), PackageManager.GET_SIGNING_CERTIFICATES);
    }

    private String pendingVersion() {
        String version = preferences().getString("version", "");
        if (version.isEmpty()) return "";
        try {
            if (versionCode(version) > installed().getLongVersionCode() && archive(version).isFile()
                    && archive(version).length() == preferences().getLong("size", -1)) return version;
        } catch (PackageManager.NameNotFoundException ignored) {}
        preferences().edit().remove("version").remove("size").remove("open").apply();
        if (versionCode(version) >= 0) archive(version).delete();
        return "";
    }

    @PluginMethod
    public void pending(PluginCall call) {
        String ready = pendingVersion();
        JSObject result = state("ready", ready);
        SharedPreferences prefs = preferences();
        String version = prefs.getString("partVersion", ""), sha = prefs.getString("partSha", "");
        long size = prefs.getLong("partSize", 0), bytes = partial().length();
        try {
            if (ready.isEmpty() && versionCode(version) > installed().getLongVersionCode() && sha.matches("[a-f0-9]{64}") &&
                bytes > 0 && bytes <= size && size <= MAX_BYTES) {
                result.put("partial", new JSObject().put("version", version).put("size", size)
                    .put("sha256", sha).put("name", "Momo-Notes-" + version + "-Android.apk"));
                result.put("progress", (int)(100 * bytes / size));
            }
        } catch (PackageManager.NameNotFoundException ignored) {}
        call.resolve(result);
    }

    @PluginMethod
    public void download(PluginCall call) {
        String version = call.getString("version", "");
        String sha256 = call.getString("sha256", "");
        long size = call.getInt("size", 0);
        try {
            if (versionCode(version) <= installed().getLongVersionCode() ||
                    !sha256.matches("[a-f0-9]{64}") || size <= 0 || size > MAX_BYTES) {
                call.reject("没有可验证的新版本安装包");
                return;
            }
        } catch (PackageManager.NameNotFoundException error) {
            call.reject("无法读取当前应用版本", error);
            return;
        }
        if (!downloading.compareAndSet(false, true)) {
            call.reject("正在下载更新");
            return;
        }
        final long offset;
        try {
            offset = preparePartial(version, size, sha256);
            if (offset == size) {
                saveArchive(version, size, sha256);
                downloading.set(false);
                call.resolve(state("ready", version));
                return;
            }
        } catch (Exception error) {
            downloading.set(false);
            call.reject(error.getMessage(), error);
            return;
        }
        Request request = new Request.Builder().url(REPO + "v" + version + "/Momo-Notes-" + version + "-Android.apk")
            .header("Range", "bytes=" + offset + "-").header("Accept-Encoding", "identity")
            .header("Cache-Control", "no-cache").build();
        client.newCall(request).enqueue(new Callback() {
            @Override
            public void onFailure(Call request, IOException error) {
                downloading.set(false);
                call.reject("无法从 GitHub 下载安装包，请检查网络后重试", error);
            }

            @Override
            public void onResponse(Call request, Response response) {
                File partial = partial();
                try (Response closed = response) {
                    boolean full = response.code() == 200;
                    String expectedRange = "bytes " + offset + "-" + (size - 1) + "/" + size;
                    if (response.body() == null || (!full && (response.code() != 206 ||
                        !expectedRange.equals(response.header("Content-Range"))))) throw new IOException("GitHub 未返回正确的安装包分段");
                    long received = offset;
                    int progress = -1;
                    try (InputStream input = response.body().byteStream(); FileOutputStream output = new FileOutputStream(partial, true)) {
                        byte[] buffer = new byte[64 * 1024];
                        // A server ignoring Range must skip the prefix instead of overwriting it.
                        for (long skip = full ? offset : 0; skip > 0;) {
                            int count = input.read(buffer, 0, (int)Math.min(skip, buffer.length));
                            if (count < 0) throw new IOException("安装包传输中断");
                            skip -= count;
                        }
                        for (int count; (count = input.read(buffer)) != -1;) {
                            received += count;
                            if (received > size) throw new IOException("安装包大小与发布记录不一致");
                            output.write(buffer, 0, count);
                            int percent = (int) (received * 100 / size);
                            if (percent != progress) {
                                progress = percent;
                                notifyListeners("updateState", state("downloading", version).put("progress", progress));
                            }
                        }
                    }
                    saveArchive(version, size, sha256);
                    call.resolve(state("ready", version));
                } catch (Exception error) {
                    Log.w("MomoUpdates", "Download or package verification failed", error);
                    call.reject(error.getMessage() == null ? "安装包下载失败" : error.getMessage(), error);
                } finally {
                    downloading.set(false);
                }
            }
        });
    }

    @PluginMethod
    public synchronized void beginRelay(PluginCall call) {
        String version = call.getString("version", "");
        String sha256 = call.getString("sha256", "");
        int size = call.getInt("size", 0);
        boolean started = false;
        try {
            if (versionCode(version) <= installed().getLongVersionCode() || !sha256.matches("[a-f0-9]{64}")
                    || size <= 0 || size > MAX_BYTES) throw new IOException("没有可验证的新版本安装包");
            if (!downloading.compareAndSet(false, true)) throw new IOException("正在下载更新");
            started = true;
            long bytes = preparePartial(version, size, sha256);
            relayVersion = version;
            relaySha = sha256;
            relaySize = size;
            relayBytes = (int)bytes;
            int offset = relayBytes == relaySize ? relaySize : relayBytes / BLOCK * BLOCK;
            call.resolve(state("downloading", version).put("offset", offset).put("progress", 100 * bytes / size));
        } catch (Exception error) {
            if (started) clearRelay();
            call.reject(error.getMessage(), error);
        }
    }

    @PluginMethod
    public synchronized void appendRelay(PluginCall call) {
        if (relayVersion == null) { call.reject("主设备下载尚未开始"); return; }
        try {
            String data = call.getString("data", "");
            if (data.length() > 700_000) throw new IOException("安装包分段超出大小限制");
            byte[] bytes = Base64.decode(data, Base64.DEFAULT);
            int offset = relayBytes / BLOCK * BLOCK;
            int prefix = relayBytes - offset;
            int expected = Math.min(BLOCK, relaySize - offset);
            if (expected <= 0 || bytes.length != expected) throw new IOException("主设备返回的安装包分段大小有误");
            try (FileOutputStream output = new FileOutputStream(partial(), true)) { output.write(bytes, prefix, bytes.length - prefix); }
            relayBytes += bytes.length - prefix;
            call.resolve(state("downloading", relayVersion).put("progress", (int) (100L * relayBytes / relaySize)));
        } catch (Exception error) {
            clearRelay();
            call.reject(error.getMessage(), error);
        }
    }

    @PluginMethod
    public synchronized void finishRelay(PluginCall call) {
        if (relayVersion == null) { call.reject("主设备下载尚未开始"); return; }
        try {
            saveArchive(relayVersion, relaySize, relaySha);
            call.resolve(state("ready", relayVersion));
        } catch (Exception error) {
            call.reject(error.getMessage(), error);
        } finally { clearRelay(); }
    }

    @PluginMethod
    public synchronized void cancelRelay(PluginCall call) {
        if (relayVersion != null) clearRelay();
        call.resolve();
    }

    private void clearRelay() {
        relayVersion = null;
        downloading.set(false);
    }

    private void saveArchive(String version, long size, String sha256) throws Exception {
        if (partial().length() != size) throw new IOException("安装包传输中断，已保留下载进度");
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        try (InputStream input = new FileInputStream(partial())) {
            byte[] buffer = new byte[64 * 1024];
            for (int count; (count = input.read(buffer)) != -1;) digest.update(buffer, 0, count);
        }
        String actual = String.format(Locale.ROOT, "%064x", new BigInteger(1, digest.digest()));
        if (!sha256.equals(actual)) {
            discardPartial();
            throw new IOException("安装包校验失败，请重新检查更新");
        }
        try { verifyArchive(partial(), version); }
        catch (Exception invalid) { discardPartial(); throw invalid; }
        if (!directory().isDirectory() && !directory().mkdirs()) throw new IOException("无法创建安装包目录");
        if (!partial().renameTo(archive(version))) throw new IOException("无法保存更新安装包");
        String previous = preferences().getString("version", "");
        if (!preferences().edit().putString("version", version).putLong("size", size).remove("open")
                .remove("partVersion").remove("partSize").remove("partSha").commit()) {
            throw new IOException("无法保存更新记录");
        }
        if (!version.equals(previous) && versionCode(previous) >= 0) archive(previous).delete();
    }

    private void verifyArchive(File file, String version) throws Exception {
        PackageInfo current = installed();
        PackageInfo next = getContext().getPackageManager().getPackageArchiveInfo(file.getPath(), PackageManager.GET_SIGNING_CERTIFICATES);
        if (next == null || next.signingInfo == null || current.signingInfo == null
                || !current.packageName.equals(next.packageName) || !version.equals(next.versionName)
                || next.getLongVersionCode() != versionCode(version)
                || !Arrays.equals(current.signingInfo.getApkContentsSigners(), next.signingInfo.getApkContentsSigners())) {
            throw new IOException("安装包版本或签名与桃桃便签不匹配");
        }
    }

    @PluginMethod
    public void open(PluginCall call) {
        MainActivity activity = (MainActivity) getActivity();
        activity.runOnUiThread(() -> {
            String version = pendingVersion();
            if (version.isEmpty()) { call.reject("更新安装包已清除，请重新下载"); return; }
            try {
                call.resolve(openInstaller(activity, version, true));
            } catch (RuntimeException error) {
                call.reject("无法打开安装界面，请重试", error);
            }
        });
    }

    private JSObject openInstaller(MainActivity activity, String version, boolean askPermission) {
        if (!activity.isEditorResumed()) {
            preferences().edit().putBoolean("open", true).apply();
            return state("ready", version);
        }
        PackageManager packages = activity.getPackageManager();
        if (!packages.canRequestPackageInstalls()) {
            if (askPermission) {
                preferences().edit().putBoolean("open", true).commit();
                activity.startActivity(new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                    Uri.parse("package:" + activity.getPackageName())));
            }
            return state("permission-required", version);
        }
        preferences().edit().remove("open").apply();
        Uri uri = FileProvider.getUriForFile(activity, activity.getPackageName() + ".fileprovider", archive(version));
        Intent intent = new Intent(Intent.ACTION_VIEW).setDataAndType(uri, APK)
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        intent.setClipData(ClipData.newRawUri("桃桃便签更新", uri));
        var installer = packages.resolveActivity(intent, PackageManager.MATCH_DEFAULT_ONLY | PackageManager.MATCH_SYSTEM_ONLY);
        if (installer == null) throw new IllegalStateException("Android package installer unavailable");
        intent.setPackage(installer.activityInfo.packageName);
        activity.startActivity(intent);
        return state("installer-open", version);
    }

    @Override
    protected synchronized void handleOnDestroy() {
        if (relayVersion != null) clearRelay();
        super.handleOnDestroy();
    }

    @Override
    protected void handleOnResume() {
        if (!preferences().getBoolean("open", false)) return;
        preferences().edit().remove("open").apply();
        String version = pendingVersion();
        if (version.isEmpty()) return;
        try {
            notifyListeners("updateState", openInstaller((MainActivity) getActivity(), version, false), true);
        } catch (RuntimeException error) {
            Log.w("MomoUpdates", "Cannot open package installer", error);
            notifyListeners("updateState", state("install-error", version), true);
        }
    }

    private JSObject state(String status, String version) {
        return new JSObject().put("status", status).put("target", version);
    }
}
