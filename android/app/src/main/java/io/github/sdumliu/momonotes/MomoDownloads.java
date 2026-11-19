package io.github.sdumliu.momonotes;

import android.app.DownloadManager;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.util.List;

@CapacitorPlugin(name = "MomoDownloads")
public class MomoDownloads extends Plugin {
    private DownloadManager manager() {
        return getContext().getSystemService(DownloadManager.class);
    }

    @PluginMethod
    public void capabilities(PluginCall call) {
        call.resolve(new JSObject().put("managed", Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q));
    }

    @PluginMethod
    public void start(PluginCall call) {
        String name = call.getString("name", "");
        Uri uri = Uri.parse(call.getString("url", ""));
        List<String> segments = uri.getPathSegments();
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q || !"https".equals(uri.getScheme())
            || !"github.com".equals(uri.getAuthority()) || uri.getQuery() != null || uri.getFragment() != null
            || segments.size() != 6 || !"SDUM-Liu".equals(segments.get(0)) || !"momo-notes".equals(segments.get(1))
            || !"releases".equals(segments.get(2)) || !"download".equals(segments.get(3))
            || !segments.get(4).matches("v[0-9]+\\.[0-9]+\\.[0-9]+(?:-[a-zA-Z0-9.-]+)?")
            || !name.equals(segments.get(5)) || !name.matches("Momo-Notes-[a-zA-Z0-9._-]+\\.(?:exe|dmg|AppImage|apk|zip)")) {
            call.reject("安装包下载地址无效");
            return;
        }
        try {
            String destination = nextName(name, call.getBoolean("retryName", false));
            DownloadManager.Request request = new DownloadManager.Request(uri)
                .setTitle(destination)
                .setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, destination)
                .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
            long id = manager().enqueue(request);
            call.resolve(new JSObject().put("id", Long.toString(id)).put("name", destination));
        } catch (RuntimeException failure) {
            call.reject("无法在系统下载目录开始下载", failure);
        }
    }

    private String nextName(String original, boolean retry) {
        File folder = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS);
        int dot = original.lastIndexOf('.');
        if (retry) return original.substring(0, dot) + " (" + System.currentTimeMillis() + ")" + original.substring(dot);
        String name = original;
        for (int copy = 1; new File(folder, name).exists(); copy++) {
            name = original.substring(0, dot) + " (" + copy + ")" + original.substring(dot);
        }
        return name;
    }

    @PluginMethod
    public void status(PluginCall call) {
        try {
            long id = Long.parseLong(call.getString("id", ""));
            try (Cursor cursor = manager().query(new DownloadManager.Query().setFilterById(id))) {
                if (cursor == null || !cursor.moveToFirst()) {
                    call.reject("系统下载已取消");
                    return;
                }
                JSObject result = new JSObject();
                int status = cursor.getInt(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS));
                long bytes = cursor.getLong(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_BYTES_DOWNLOADED_SO_FAR));
                long size = cursor.getLong(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_TOTAL_SIZE_BYTES));
                result.put("bytes", bytes);
                if (status == DownloadManager.STATUS_SUCCESSFUL) result.put("status", "done");
                else if (status == DownloadManager.STATUS_FAILED) {
                    int reason = cursor.getInt(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_REASON));
                    result.put("status", reason == DownloadManager.ERROR_FILE_ALREADY_EXISTS ? "exists" : "failed");
                } else result.put("status", "waiting");
                if (size > 0) result.put("progress", Math.min(100, Math.round(bytes * 100.0 / size)));
                call.resolve(result);
            }
        } catch (RuntimeException failure) {
            call.reject("无法读取系统下载状态", failure);
        }
    }

    @PluginMethod
    public void openDirectory(PluginCall call) {
        if (getActivity() == null) {
            call.resolve(new JSObject().put("opened", false));
            return;
        }
        getActivity().runOnUiThread(() -> {
            boolean opened = false;
            if (getActivity() != null && getActivity().hasWindowFocus()) {
                try {
                    getActivity().startActivity(new Intent(DownloadManager.ACTION_VIEW_DOWNLOADS));
                    opened = true;
                } catch (RuntimeException ignored) {}
            }
            call.resolve(new JSObject().put("opened", opened));
        });
    }
}
