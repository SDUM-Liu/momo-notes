package io.github.sdumliu.momonotes;

import android.content.Context;
import android.content.SharedPreferences;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.PixelFormat;
import android.graphics.Rect;
import android.graphics.drawable.GradientDrawable;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewConfiguration;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.view.inputmethod.InputMethodManager;
import android.webkit.WebView;
import android.widget.FrameLayout;

final class NoteOverlay {
    private final Context context;
    private final WindowManager windows;
    private final SharedPreferences preferences;
    private FrameLayout window;
    private WindowManager.LayoutParams position;
    private WebView webView;
    private ViewGroup originalParent;
    private ViewGroup.LayoutParams originalLayout;
    private int originalIndex;

    NoteOverlay(Context context, WindowManager windows, SharedPreferences preferences) {
        this.context = context;
        this.windows = windows;
        this.preferences = preferences;
    }

    boolean isOpen() { return window != null; }

    void open(MainActivity activity, WindowManager.LayoutParams pet) {
        if (isOpen()) return;
        WebView editor = activity.getBridge().getWebView();
        if (!(editor.getParent() instanceof ViewGroup parent)) {
            throw new IllegalStateException("The note editor has no parent");
        }

        window = new FrameLayout(context);
        position = new WindowManager.LayoutParams(1, 1, WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
            WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL, PixelFormat.TRANSLUCENT);
        position.gravity = Gravity.TOP | Gravity.LEFT;
        position.softInputMode = WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE;
        sizeWindow();
        // Both illustrations use the eyes as their anchor. The perched image is
        // 40dp wide and inset 10dp from the editor's right edge.
        position.x = preferences.getInt("note-x", pet.x + pet.width / 2 - position.width + dp(30));
        position.y = preferences.getInt("note-y", pet.y + dp(20) - dp(23));
        PetOverlayService.clampPosition(windows, position);

        webView = editor;
        originalParent = parent;
        originalIndex = parent.indexOfChild(editor);
        originalLayout = editor.getLayoutParams();
        try {
            parent.removeView(editor);
            window.addView(editor, new FrameLayout.LayoutParams(-1, -1));
            addHandle();
            addResizeHandle();
            windows.addView(window, position);
            setFloating(true);
        } catch (RuntimeException error) {
            close();
            throw error;
        }
    }

    void alignPet(WindowManager.LayoutParams pet) {
        preferences.edit().putInt("note-x", position.x).putInt("note-y", position.y).apply();
        pet.x = position.x + position.width - dp(30) - pet.width / 2;
        pet.y = position.y + dp(23) - dp(20);
        PetOverlayService.clampPosition(windows, pet);
        preferences.edit().putInt("x", pet.x).putInt("y", pet.y).apply();
    }

    void close() {
        if (!isOpen()) return;
        if (webView.getWindowToken() != null) {
            context.getSystemService(InputMethodManager.class).hideSoftInputFromWindow(webView.getWindowToken(), 0);
        }
        setFloating(false);
        window.removeView(webView);
        if (window.isAttachedToWindow()) windows.removeViewImmediate(window);
        originalParent.addView(webView, originalIndex, originalLayout);
        webView = null;
        originalParent = null;
        originalLayout = null;
        window = null;
    }

    void resize() {
        if (!isOpen()) return;
        sizeWindow();
        PetOverlayService.clampPosition(windows, position);
        if (window.isAttachedToWindow()) windows.updateViewLayout(window, position);
    }

    private void sizeWindow() {
        Rect bounds = PetOverlayService.availableSpace(windows);
        int width = preferences.getInt("note-width", 0);
        int height = preferences.getInt("note-height", 0);
        position.width = boundedSize(width > 0 ? dp(width) : Math.min(dp(400), bounds.width() - dp(16)),
            dp(260), bounds.width());
        position.height = boundedSize(height > 0 ? dp(height) : Math.min(dp(620), bounds.height() * 2 / 3),
            dp(280), bounds.height());
    }

    private static int boundedSize(int requested, int minimum, int available) {
        return Math.max(1, Math.min(available, Math.max(minimum, requested)));
    }

    private void addHandle() {
        FrameLayout handle = new FrameLayout(context);
        handle.setContentDescription("拖动移动便签");
        FrameLayout.LayoutParams gripArea = new FrameLayout.LayoutParams(-1, dp(22), Gravity.TOP | Gravity.LEFT);
        gripArea.leftMargin = dp(8);
        gripArea.rightMargin = dp(62);
        View grip = new View(context);
        GradientDrawable fill = new GradientDrawable();
        fill.setColor(Color.rgb(182, 143, 160));
        fill.setCornerRadius(dp(2));
        grip.setBackground(fill);
        handle.addView(grip, new FrameLayout.LayoutParams(dp(34), dp(4), Gravity.CENTER));
        handle.setOnTouchListener(PetOverlayService.dragWindow(windows, window, position, () ->
            preferences.edit().putInt("note-x", position.x).putInt("note-y", position.y).apply()));
        window.addView(handle, gripArea);
    }

    private void addResizeHandle() {
        View handle = new View(context) {
            private final Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
            @Override protected void onDraw(Canvas canvas) {
                super.onDraw(canvas);
                paint.setColor(Color.rgb(162, 116, 139));
                paint.setStrokeWidth(dp(2));
                paint.setStrokeCap(Paint.Cap.ROUND);
                float right = getWidth() - dp(8), bottom = getHeight() - dp(8);
                canvas.drawLine(right - dp(12), bottom, right, bottom - dp(12), paint);
                canvas.drawLine(right - dp(6), bottom, right, bottom - dp(6), paint);
            }
        };
        handle.setContentDescription("拖动调整便签大小");
        handle.setOnTouchListener(new View.OnTouchListener() {
            private float downX, downY;
            private int width, height;
            private boolean resizing;
            private final int slop = ViewConfiguration.get(context).getScaledTouchSlop();

            @Override public boolean onTouch(View view, MotionEvent event) {
                switch (event.getActionMasked()) {
                    case MotionEvent.ACTION_DOWN:
                        downX = event.getRawX();
                        downY = event.getRawY();
                        width = position.width;
                        height = position.height;
                        resizing = false;
                        return true;
                    case MotionEvent.ACTION_MOVE:
                        int dx = Math.round(event.getRawX() - downX), dy = Math.round(event.getRawY() - downY);
                        resizing |= Math.abs(dx) > slop || Math.abs(dy) > slop;
                        if (resizing && window.isAttachedToWindow()) {
                            Rect area = PetOverlayService.availableSpace(windows);
                            position.width = boundedSize(width + dx, dp(260), area.width() - position.x);
                            position.height = boundedSize(height + dy, dp(280), area.height() - position.y);
                            windows.updateViewLayout(window, position);
                        }
                        return true;
                    case MotionEvent.ACTION_UP:
                    case MotionEvent.ACTION_CANCEL:
                        if (resizing) {
                            float density = context.getResources().getDisplayMetrics().density;
                            preferences.edit().putInt("note-width", Math.round(position.width / density))
                                .putInt("note-height", Math.round(position.height / density)).apply();
                        }
                        return true;
                    default: return false;
                }
            }
        });
        window.addView(handle, new FrameLayout.LayoutParams(dp(36), dp(36), Gravity.BOTTOM | Gravity.RIGHT));
    }

    private void setFloating(boolean active) {
        webView.evaluateJavascript("document.documentElement.dataset.momoFloating = '" + active + "';"
            + "window.dispatchEvent(new Event('momo-floating-" + (active ? "open" : "close") + "'))", null);
    }

    private int dp(int size) {
        return Math.round(size * context.getResources().getDisplayMetrics().density);
    }
}
