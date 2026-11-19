package io.github.sdumliu.momonotes;

import android.os.Bundle;
import android.graphics.Color;
import android.content.Intent;
import android.widget.Toast;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    private static MainActivity current;
    private boolean openFloating;
    private boolean resumed;

    static MainActivity current() { return current; }
    boolean isResumed() { return resumed; }

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(MomoProxyPlugin.class);
        registerPlugin(MomoSyncPlugin.class);
        registerPlugin(MomoPetPlugin.class);
        super.onCreate(savedInstanceState);
        getBridge().getWebView().setBackgroundColor(Color.TRANSPARENT);
        current = this;
        openFloating = PetOverlayService.OPEN_FLOATING_NOTE.equals(getIntent().getAction());
    }

    @Override
    public void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        openFloating = PetOverlayService.OPEN_FLOATING_NOTE.equals(intent.getAction());
    }

    @Override
    public void onResume() {
        resumed = true;
        PetOverlayService.dismissNote();
        super.onResume();
        PetOverlayService.setEditorVisible(true);
        if (openFloating && PetOverlayService.isRunning() && !moveTaskToBack(true)) openFloating = false;
    }

    @Override
    public void onPause() {
        resumed = false;
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
