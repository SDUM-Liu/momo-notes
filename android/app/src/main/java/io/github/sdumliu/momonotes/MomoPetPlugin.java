package io.github.sdumliu.momonotes;

import android.content.Intent;
import android.net.Uri;
import android.provider.Settings;
import androidx.core.content.ContextCompat;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "MomoPet")
public class MomoPetPlugin extends Plugin {
    @PluginMethod
    public void state(PluginCall call) {
        JSObject result = new JSObject();
        boolean permission = Settings.canDrawOverlays(getContext());
        result.put("permission", permission);
        result.put("enabled", permission && PetOverlayService.isRunning());
        call.resolve(result);
    }

    @PluginMethod
    public void setEnabled(PluginCall call) {
        if (getActivity() == null) {
            call.reject("请从便签设置开启悬浮桌宠");
            return;
        }
        getActivity().runOnUiThread(() -> {
            try {
                boolean enabled = call.getBoolean("enabled", false);
                Intent service = new Intent(getContext(), PetOverlayService.class);
                if (!enabled) {
                    getContext().stopService(service);
                } else if (Settings.canDrawOverlays(getContext())) {
                    ContextCompat.startForegroundService(getActivity(), service);
                } else {
                    Intent permission = new Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
                        Uri.parse("package:" + getContext().getPackageName()));
                    getActivity().startActivity(permission);
                }
                call.resolve();
            } catch (RuntimeException error) {
                call.reject("无法开启悬浮桌宠，请在系统设置检查悬浮窗权限", error);
            }
        });
    }

    @PluginMethod
    public void dismiss(PluginCall call) {
        if (getActivity() == null) { call.resolve(); return; }
        getActivity().runOnUiThread(() -> {
            if (!getActivity().moveTaskToBack(true)) getActivity().finish();
            call.resolve();
        });
    }

    @PluginMethod
    public void scanner(PluginCall call) {
        if (getActivity() == null) { call.resolve(); return; }
        getActivity().runOnUiThread(() -> {
            PetOverlayService.setScannerVisible(call.getBoolean("active", false));
            call.resolve();
        });
    }
}
