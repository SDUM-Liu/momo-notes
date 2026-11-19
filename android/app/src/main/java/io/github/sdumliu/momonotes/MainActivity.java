package io.github.sdumliu.momonotes;

import android.os.Bundle;
import android.graphics.Color;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(MomoProxyPlugin.class);
        registerPlugin(MomoSyncPlugin.class);
        registerPlugin(MomoPetPlugin.class);
        super.onCreate(savedInstanceState);
        getBridge().getWebView().setBackgroundColor(Color.TRANSPARENT);
    }

    @Override
    public void onResume() {
        super.onResume();
        PetOverlayService.setEditorVisible(true);
    }

    @Override
    public void onPause() {
        PetOverlayService.setEditorVisible(false);
        super.onPause();
    }

    @Override
    public void onDestroy() {
        PetOverlayService.setScannerVisible(false);
        super.onDestroy();
    }
}
