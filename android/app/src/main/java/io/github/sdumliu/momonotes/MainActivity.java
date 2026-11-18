package io.github.sdumliu.momonotes;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(MomoProxyPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
