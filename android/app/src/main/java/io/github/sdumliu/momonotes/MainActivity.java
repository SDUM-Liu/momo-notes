package io.github.sdumliu.momonotes;

import android.os.Bundle;
import android.graphics.Color;
import android.content.Intent;
import android.widget.Toast;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    private static MainActivity current;
    private boolean openFloating;
    private boolean editorResumed;
    private boolean launcherRequested;

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
