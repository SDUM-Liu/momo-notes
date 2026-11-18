package io.github.sdumliu.momonotes;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.widget.RemoteViews;
import java.time.LocalDate;

public class TodayWidget extends AppWidgetProvider {
    private static final String STORAGE = "momo_widget";

    static void save(Context context, String date, int count, String preview) {
        context.getSharedPreferences(STORAGE, Context.MODE_PRIVATE).edit()
            .putString("date", date).putInt("count", count).putString("preview", preview).apply();
        update(context);
    }

    static void update(Context context) {
        AppWidgetManager manager = AppWidgetManager.getInstance(context);
        int[] ids = manager.getAppWidgetIds(new ComponentName(context, TodayWidget.class));
        new TodayWidget().onUpdate(context, manager, ids);
    }

    @Override
    public void onUpdate(Context context, AppWidgetManager manager, int[] ids) {
        SharedPreferences data = context.getSharedPreferences(STORAGE, Context.MODE_PRIVATE);
        boolean current = LocalDate.now().toString().equals(data.getString("date", ""));
        RemoteViews views = new RemoteViews(context.getPackageName(), R.layout.momo_today_widget);
        int count = data.getInt("count", 0);
        views.setTextViewText(R.id.widget_summary, current ? count + " 项未完成" : "打开便签查看今天");
        views.setTextViewText(R.id.widget_preview, current ? data.getString("preview", "") : "");
        Intent open = new Intent(Intent.ACTION_VIEW, Uri.parse("momonotes://today"), context, MainActivity.class);
        open.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        views.setOnClickPendingIntent(R.id.widget_root,
            PendingIntent.getActivity(context, 0, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT));
        for (int id : ids) manager.updateAppWidget(id, views);
    }
}
