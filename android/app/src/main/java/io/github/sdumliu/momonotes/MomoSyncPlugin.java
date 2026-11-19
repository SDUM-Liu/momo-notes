package io.github.sdumliu.momonotes;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "MomoSync")
public class MomoSyncPlugin extends Plugin {
    @PluginMethod
    public void updateWidget(PluginCall call) {
        TodayWidget.save(getContext(), call.getString("date", ""), call.getInt("count", 0),
            call.getString("preview", ""));
        call.resolve();
    }
}
