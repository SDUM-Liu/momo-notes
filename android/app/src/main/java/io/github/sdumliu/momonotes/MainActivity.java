package io.github.sdumliu.momonotes;

import android.os.Bundle;
import android.graphics.Color;
import android.content.Intent;
import android.view.View;
import android.widget.Toast;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    private static MainActivity current;
    private boolean openFloating;
    private boolean editorResumed;
    private boolean launcherRequested;
    private View editorRoot;

    static MainActivity current() { return current; }
    boolean isEditorResumed() { return editorResumed; }

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(MomoProxyPlugin.class);
        registerPlugin(MomoSyncPlugin.class);
        registerPlugin(MomoPetPlugin.class);
        registerPlugin(MomoUpdatesPlugin.class);
        super.onCreate(savedInstanceState);
        if (getBridge() == null) return;
        getBridge().getWebView().setBackgroundColor(Color.TRANSPARENT);
        if (getBridge().getWebView().getParent() instanceof View parent) {
            editorRoot = parent;
            WindowCompat.setDecorFitsSystemWindows(getWindow(), false);
            ViewCompat.setOnApplyWindowInsetsListener(editorRoot, (root, insets) -> {
                int bars = WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout();
                int keyboard = WindowInsetsCompat.Type.ime();
                Insets safe = insets.getInsets(bars);
                int bottom = Math.max(safe.bottom, insets.getInsets(keyboard).bottom);
                if (root.getPaddingLeft() != safe.left || root.getPaddingTop() != safe.top ||
                        root.getPaddingRight() != safe.right || root.getPaddingBottom() != bottom) {
                    root.setPadding(safe.left, safe.top, safe.right, bottom);
                }
                // Keep inset changes flowing to the WebView after applying their space here.
                return new WindowInsetsCompat.Builder(insets).setInsets(bars | keyboard, Insets.NONE)
                    .setVisible(keyboard, false).build();
            });
            ViewCompat.requestApplyInsets(editorRoot);
        }
        current = this;
        openFloating = PetOverlayService.OPEN_FLOATING_NOTE.equals(getIntent().getAction());
    }

    @Override
    public void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        openFloating = PetOverlayService.OPEN_FLOATING_NOTE.equals(intent.getAction());
        launcherRequested = Intent.ACTION_MAIN.equals(intent.getAction()) && intent.hasCategory(Intent.CATEGORY_LAUNCHER);
    }

    @Override
    public void onResume() {
        editorResumed = true;
        PetOverlayService.dismissNote();
        super.onResume();
        if (editorRoot != null) ViewCompat.requestApplyInsets(editorRoot);
        PetOverlayService.setEditorVisible(true);
        if (launcherRequested && getBridge() != null) {
            launcherRequested = false;
            getBridge().getWebView().evaluateJavascript("window.dispatchEvent(new Event('momo-launcher-open'))", null);
        }
        if (openFloating && PetOverlayService.isRunning() && !moveTaskToBack(true)) openFloating = false;
    }

    @Override
    public void onPause() {
        editorResumed = false;
        PetOverlayService.setEditorVisible(false);
        super.onPause();
        if (openFloating) {
            openFloating = false;
            PetOverlayService.showNote(this);
        }
    }

    @Override
    public void onDestroy() {
        if (current == this) {
            PetOverlayService.dismissNote();
            PetOverlayService.setScannerVisible(false);
            current = null;
        }
        super.onDestroy();
    }

    void showFloatingError() {
        Toast.makeText(this, "无法创建浮动便签，已打开应用内便签。", Toast.LENGTH_LONG).show();
    }
}
