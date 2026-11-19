package io.github.sdumliu.momonotes;

import android.content.Context;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.graphics.PixelFormat;
import android.graphics.Rect;
import android.graphics.drawable.GradientDrawable;
import android.view.Gravity;
import android.view.View;
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

    void open(MainActivity activity) {
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
        Rect bounds = PetOverlayService.availableSpace(windows);
        position.x = preferences.getInt("note-x", (bounds.width() - position.width) / 2);
        position.y = preferences.getInt("note-y", (bounds.height() - position.height) / 3);
        PetOverlayService.clampPosition(windows, position);

        webView = editor;
        originalParent = parent;
        originalIndex = parent.indexOfChild(editor);
        originalLayout = editor.getLayoutParams();
        try {
            parent.removeView(editor);
            window.addView(editor, new FrameLayout.LayoutParams(-1, -1));
            addHandle();
            windows.addView(window, position);
            setFloating(true);
        } catch (RuntimeException error) {
            close();
            throw error;
        }
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
        position.width = Math.max(1, Math.min(dp(400), bounds.width() - dp(16)));
        position.height = Math.max(1, Math.min(dp(620), bounds.height() * 2 / 3));
    }

    private void addHandle() {
        FrameLayout handle = new FrameLayout(context);
        handle.setContentDescription("拖动移动便签");
        FrameLayout.LayoutParams gripArea = new FrameLayout.LayoutParams(dp(132), dp(20), Gravity.TOP | Gravity.LEFT);
        gripArea.leftMargin = dp(8);
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

    private void setFloating(boolean active) {
        webView.evaluateJavascript("document.documentElement.dataset.momoFloating = '" + active + "'", null);
    }

    private int dp(int size) {
        return Math.round(size * context.getResources().getDisplayMetrics().density);
    }
}
