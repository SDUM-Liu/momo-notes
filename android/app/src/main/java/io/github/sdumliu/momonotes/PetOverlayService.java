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
import android.graphics.PixelFormat;
import android.graphics.Point;
import android.graphics.Rect;
import android.os.Build;
import android.os.IBinder;
import android.provider.Settings;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewConfiguration;
import android.view.WindowManager;
import android.widget.ImageButton;
import androidx.core.app.ServiceCompat;

public class PetOverlayService extends Service {
    private static final String CHANNEL = "floating-pet";
    private static final String STOP = "io.github.sdumliu.momonotes.STOP_PET";
    private static volatile PetOverlayService running;
    private static boolean editorVisible;
    private static boolean scannerVisible;
    private WindowManager windows;
    private ImageButton pet;
    private WindowManager.LayoutParams position;

    static boolean isRunning() { return running != null; }

    static void setEditorVisible(boolean visible) {
        editorVisible = visible;
        if (running != null) running.refreshVisibility();
    }

    static void setScannerVisible(boolean visible) {
        scannerVisible = visible;
        if (running != null) running.refreshVisibility();
    }

    private void refreshVisibility() {
        if (pet != null) pet.setVisibility(editorVisible || scannerVisible ? View.GONE : View.VISIBLE);
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
        Context overlay = Build.VERSION.SDK_INT >= 30
            ? createWindowContext(WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY, null) : this;
        windows = overlay.getSystemService(WindowManager.class);
        pet = new ImageButton(overlay);
        pet.setBackgroundColor(android.graphics.Color.TRANSPARENT);
        pet.setPadding(0, 0, 0, 0);
        pet.setImageResource(R.drawable.momo_overlay);
        pet.setScaleType(ImageButton.ScaleType.FIT_CENTER);
        pet.setContentDescription("桃桃桌宠，打开便签");
        pet.setOnClickListener(view -> startActivity(openNotes()));
        position = new WindowManager.LayoutParams(dp(66), dp(84), WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE | WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL,
            PixelFormat.TRANSLUCENT);
        position.gravity = Gravity.TOP | Gravity.LEFT;
        position.x = getPreferences().getInt("x", Integer.MAX_VALUE);
        position.y = getPreferences().getInt("y", dp(128));
        clampPosition();
        pet.setOnTouchListener(new View.OnTouchListener() {
            private float downX, downY;
            private int originX, originY;
            private boolean dragging;
            private final int slop = ViewConfiguration.get(PetOverlayService.this).getScaledTouchSlop();
            @Override
            public boolean onTouch(View view, MotionEvent event) {
                switch (event.getActionMasked()) {
                    case MotionEvent.ACTION_DOWN:
                        downX = event.getRawX();
                        downY = event.getRawY();
                        originX = position.x;
                        originY = position.y;
                        dragging = false;
                        return true;
                    case MotionEvent.ACTION_MOVE:
                        int dx = Math.round(event.getRawX() - downX);
                        int dy = Math.round(event.getRawY() - downY);
                        dragging |= Math.abs(dx) > slop || Math.abs(dy) > slop;
                        if (dragging) {
                            position.x = originX + dx;
                            position.y = originY + dy;
                            clampPosition();
                            windows.updateViewLayout(pet, position);
                        }
                        return true;
                    case MotionEvent.ACTION_UP:
                        if (dragging) getPreferences().edit().putInt("x", position.x).putInt("y", position.y).apply();
                        else view.performClick();
                        return true;
                    case MotionEvent.ACTION_CANCEL:
                        return true;
                    default:
                        return false;
                }
            }
        });
        refreshVisibility();
        windows.addView(pet, position);
    }

    private android.content.SharedPreferences getPreferences() {
        return getSharedPreferences("pet-overlay", MODE_PRIVATE);
    }

    private void clampPosition() {
        if (Build.VERSION.SDK_INT >= 30) {
            Rect bounds = windows.getCurrentWindowMetrics().getBounds();
            position.x = Math.max(0, Math.min(position.x, bounds.width() - position.width));
            position.y = Math.max(0, Math.min(position.y, bounds.height() - position.height - dp(32)));
        } else {
            Point bounds = new Point();
            windows.getDefaultDisplay().getSize(bounds);
            position.x = Math.max(0, Math.min(position.x, bounds.x - position.width));
            position.y = Math.max(0, Math.min(position.y, bounds.y - position.height));
        }
    }

    @Override
    public void onConfigurationChanged(Configuration next) {
        super.onConfigurationChanged(next);
        if (pet != null && pet.isAttachedToWindow()) {
            clampPosition();
            windows.updateViewLayout(pet, position);
        }
    }

    @Override
    public void onDestroy() {
        if (pet != null && pet.isAttachedToWindow()) windows.removeViewImmediate(pet);
        if (running == this) running = null;
        super.onDestroy();
    }
}
