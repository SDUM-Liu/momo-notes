package io.github.sdumliu.momonotes;

import android.content.Intent;
import android.net.Uri;
import android.provider.Settings;
import android.util.Log;
import androidx.core.content.ContextCompat;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "MomoPet")
public class MomoPetPlugin extends Plugin {
    private boolean enablingAfterPermission;
    private String startFailure;
    private PluginCall foregroundCall;

    @PluginMethod
    public void state(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            JSObject result = new JSObject();
            boolean permission = Settings.canDrawOverlays(getContext());
            result.put("permission", permission);
            result.put("enabled", permission && PetOverlayService.isRunning());
            result.put("error", startFailure != null ? startFailure : PetOverlayService.failure());
            call.resolve(result);
        });
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
                enablingAfterPermission = false;
                startFailure = null;
                PetOverlayService.clearFailure();
                if (!enabled) {
                    getContext().stopService(service);
                } else if (Settings.canDrawOverlays(getContext())) {
                    startPet();
                } else {
                    Intent permission = new Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
                        Uri.parse("package:" + getContext().getPackageName()));
                    getActivity().startActivity(permission);
                    enablingAfterPermission = true;
                }
                call.resolve();
            } catch (RuntimeException error) {
                call.reject("无法开启悬浮桌宠，请在系统设置检查悬浮窗权限", error);
            }
        });
    }

    private void startPet() {
        try {
            ContextCompat.startForegroundService(getActivity(), new Intent(getContext(), PetOverlayService.class));
        } catch (RuntimeException error) {
            Log.w("MomoPet", "Cannot start foreground service", error);
            startFailure = "系统未能启动悬浮桌宠（" + error.getClass().getSimpleName() + "）。";
        }
    }

    @Override
    protected void handleOnResume() {
        if (enablingAfterPermission) {
            enablingAfterPermission = false;
            if (Settings.canDrawOverlays(getContext())) startPet();
            JSObject result = new JSObject();
            result.put("starting", Settings.canDrawOverlays(getContext()));
            notifyListeners("permissionReturn", result);
        }
        if (foregroundCall != null) {
            foregroundCall.resolve();
            foregroundCall = null;
        }
    }

    @PluginMethod
    public void foreground(PluginCall call) {
        MainActivity activity = (MainActivity) getActivity();
        activity.runOnUiThread(() -> {
            if (activity.isResumed()) { call.resolve(); return; }
            if (foregroundCall != null) { call.reject("正在打开便签应用"); return; }
            foregroundCall = call;
            try {
                activity.startActivity(new Intent(activity, MainActivity.class)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP));
            } catch (RuntimeException error) {
                foregroundCall = null;
                call.reject("请从应用图标打开桃桃便签，再继续操作", error);
                return;
            }
            new android.os.Handler(android.os.Looper.getMainLooper()).postDelayed(() -> {
                if (foregroundCall != call) return;
                foregroundCall = null;
                call.reject("请从应用图标打开桃桃便签，再继续操作");
            }, 3000);
        });
    }

    @PluginMethod
    public void dismiss(PluginCall call) {
        if (getActivity() == null) { call.resolve(); return; }
        getActivity().runOnUiThread(() -> {
            if (!PetOverlayService.dismissNote() && !getActivity().moveTaskToBack(true)) getActivity().finish();
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
