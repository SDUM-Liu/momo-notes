package io.github.sdumliu.momonotes;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.res.Configuration;
import android.content.pm.ServiceInfo;
import android.graphics.Color;
import android.graphics.PixelFormat;
import android.graphics.Rect;
import android.hardware.display.DisplayManager;
import android.os.Build;
import android.os.IBinder;
import android.provider.Settings;
import android.util.Log;
import android.view.Display;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewConfiguration;
import android.view.WindowManager;
import android.view.WindowInsets;
import android.widget.ImageButton;
import androidx.core.app.ServiceCompat;

public class PetOverlayService extends Service {
    private static final String CHANNEL = "floating-pet";
    private static final String STOP = "io.github.sdumliu.momonotes.STOP_PET";
    static final String OPEN_FLOATING_NOTE = "io.github.sdumliu.momonotes.OPEN_FLOATING_NOTE";
    private static volatile PetOverlayService running;
    private static volatile String failure;
    private static boolean editorVisible;
    private static boolean scannerVisible;
    private WindowManager windows;
    private NoteOverlay note;
    private ImageButton pet;
    private WindowManager.LayoutParams position;

    static boolean isRunning() { return running != null; }
    static String failure() { return failure; }
    static void clearFailure() { failure = null; }

    static boolean isNoteOpen() { return running != null && running.note.isOpen(); }

    static boolean dismissNote() {
        if (!isNoteOpen()) return false;
        running.note.close();
        running.refreshVisibility();
        return true;
    }

    static void showNote(MainActivity activity) {
        if (running != null && !scannerVisible) running.openNote(activity);
    }

    static void setEditorVisible(boolean visible) {
        editorVisible = visible;
        if (running != null) running.refreshVisibility();
    }

    static void setScannerVisible(boolean visible) {
        scannerVisible = visible;
        if (running != null) running.refreshVisibility();
    }

    private void refreshVisibility() {
        if (pet != null) pet.setVisibility(editorVisible || scannerVisible || (note != null && note.isOpen())
            ? View.GONE : View.VISIBLE);
    }

    @Override
    public IBinder onBind(Intent intent) { return null; }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if ((intent != null && STOP.equals(intent.getAction())) || !Settings.canDrawOverlays(this)) {
            stopSelf();
            return START_NOT_STICKY;
        }
        if (running == this) return START_STICKY;
        try {
            ServiceCompat.startForeground(this, 42, notification(),
                Build.VERSION.SDK_INT >= 34 ? ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE : 0);
            addPet();
            running = this;
            return START_STICKY;
        } catch (RuntimeException error) {
            failure = error instanceof SecurityException
                ? "系统拒绝创建悬浮窗。请检查桃桃便签的「显示在其他应用上层」权限。"
                : "系统未能启动悬浮桌宠（" + error.getClass().getSimpleName() + "）。";
            Log.w("MomoPet", "Cannot start pet overlay", error);
            stopSelf();
            return START_NOT_STICKY;
        }
    }

    private Intent openNotes() {
        return new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
    }

    private Notification notification() {
        getSystemService(NotificationManager.class).createNotificationChannel(new NotificationChannel(
            CHANNEL, "悬浮桌宠", NotificationManager.IMPORTANCE_LOW));
        PendingIntent open = PendingIntent.getActivity(this, 0, openNotes(), PendingIntent.FLAG_IMMUTABLE);
        Intent stop = new Intent(this, PetOverlayService.class).setAction(STOP);
        PendingIntent dismiss = PendingIntent.getService(this, 1, stop, PendingIntent.FLAG_IMMUTABLE);
        return new Notification.Builder(this, CHANNEL)
            .setSmallIcon(android.R.drawable.ic_dialog_info).setContentTitle("桃桃悬浮桌宠")
            .setContentText("点桌宠打开便签").setContentIntent(open).setOngoing(true)
            .addAction(new Notification.Action.Builder(null, "关闭桌宠", dismiss).build()).build();
    }

    private int dp(int size) { return Math.round(size * getResources().getDisplayMetrics().density); }

    private void addPet() {
        Display display = getSystemService(DisplayManager.class).getDisplay(Display.DEFAULT_DISPLAY);
        Context overlay = createDisplayContext(display);
        if (Build.VERSION.SDK_INT >= 30) {
            overlay = overlay.createWindowContext(WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY, null);
        }
        windows = overlay.getSystemService(WindowManager.class);
        note = new NoteOverlay(overlay, windows, getPreferences());
        pet = new ImageButton(overlay);
        pet.setBackgroundColor(Color.TRANSPARENT);
        pet.setPadding(0, 0, 0, 0);
        pet.setImageResource(R.drawable.momo_overlay);
        pet.setScaleType(ImageButton.ScaleType.FIT_CENTER);
        pet.setContentDescription("桃桃桌宠，打开便签");
        pet.setOnClickListener(view -> {
            MainActivity activity = MainActivity.current();
            if (activity != null) openNote(activity);
            else startActivity(openNotes().setAction(OPEN_FLOATING_NOTE));
        });
        position = new WindowManager.LayoutParams(dp(66), dp(84), WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE | WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL,
            PixelFormat.TRANSLUCENT);
        position.gravity = Gravity.TOP | Gravity.LEFT;
        position.x = getPreferences().getInt("x", Integer.MAX_VALUE);
        position.y = getPreferences().getInt("y", dp(128));
        clampPosition(windows, position);
        pet.setOnTouchListener(dragWindow(windows, pet, position, () ->
            getPreferences().edit().putInt("x", position.x).putInt("y", position.y).apply()));
        refreshVisibility();
        windows.addView(pet, position);
    }

    private android.content.SharedPreferences getPreferences() {
        return getSharedPreferences("pet-overlay", MODE_PRIVATE);
    }

    private void openNote(MainActivity activity) {
        try {
            note.open(activity);
            refreshVisibility();
        } catch (RuntimeException error) {
            Log.w("MomoPet", "Cannot open floating note", error);
            activity.showFloatingError();
            startActivity(openNotes());
        }
    }

    static Rect availableSpace(WindowManager windows) {
        if (Build.VERSION.SDK_INT >= 30) {
            var metrics = windows.getCurrentWindowMetrics();
            var insets = metrics.getWindowInsets().getInsetsIgnoringVisibility(
                WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout());
            Rect bounds = metrics.getBounds();
            return new Rect(0, 0, Math.max(1, bounds.width() - insets.left - insets.right),
                Math.max(1, bounds.height() - insets.top - insets.bottom));
        }
        android.graphics.Point size = new android.graphics.Point();
        windows.getDefaultDisplay().getSize(size);
        return new Rect(0, 0, size.x, size.y);
    }

    static void clampPosition(WindowManager windows, WindowManager.LayoutParams params) {
        Rect space = availableSpace(windows);
        params.x = Math.max(0, Math.min(params.x, space.width() - params.width));
        params.y = Math.max(0, Math.min(params.y, space.height() - params.height));
    }

    static View.OnTouchListener dragWindow(WindowManager windows, View window,
            WindowManager.LayoutParams params, Runnable savePosition) {
        return new View.OnTouchListener() {
            private float downX, downY;
            private int originX, originY;
            private boolean dragging;
            private final int slop = ViewConfiguration.get(window.getContext()).getScaledTouchSlop();

            @Override
            public boolean onTouch(View handle, MotionEvent event) {
                switch (event.getActionMasked()) {
                    case MotionEvent.ACTION_DOWN:
                        downX = event.getRawX();
                        downY = event.getRawY();
                        originX = params.x;
                        originY = params.y;
                        dragging = false;
                        return true;
                    case MotionEvent.ACTION_MOVE:
                        int dx = Math.round(event.getRawX() - downX);
                        int dy = Math.round(event.getRawY() - downY);
                        dragging |= Math.abs(dx) > slop || Math.abs(dy) > slop;
                        if (dragging) {
                            params.x = originX + dx;
                            params.y = originY + dy;
                            clampPosition(windows, params);
                            if (window.isAttachedToWindow()) windows.updateViewLayout(window, params);
                        }
                        return true;
                    case MotionEvent.ACTION_UP:
                    case MotionEvent.ACTION_CANCEL:
                        if (dragging) savePosition.run();
                        else if (event.getActionMasked() == MotionEvent.ACTION_UP) handle.performClick();
                        return true;
                    default:
                        return false;
                }
            }
        };
    }

    @Override
    public void onConfigurationChanged(Configuration next) {
        super.onConfigurationChanged(next);
        if (pet != null && pet.isAttachedToWindow()) {
            clampPosition(windows, position);
            windows.updateViewLayout(pet, position);
        }
        if (note != null) note.resize();
    }

    @Override
    public void onDestroy() {
        if (note != null) note.close();
        if (pet != null && pet.isAttachedToWindow()) windows.removeViewImmediate(pet);
        if (running == this) running = null;
        super.onDestroy();
    }
}
