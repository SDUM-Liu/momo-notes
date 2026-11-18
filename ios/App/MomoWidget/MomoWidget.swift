import SwiftUI
import WidgetKit

struct TodayEntry: TimelineEntry {
    let date: Date
    let count: Int?
    let preview: String
}

struct TodayProvider: TimelineProvider {
    func placeholder(in context: Context) -> TodayEntry {
        TodayEntry(date: Date(), count: 2, preview: "")
    }

    func getSnapshot(in context: Context, completion: @escaping (TodayEntry) -> Void) {
        completion(current())
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<TodayEntry>) -> Void) {
        let now = Date()
        let tomorrow = Calendar.current.startOfDay(for: Calendar.current.date(byAdding: .day, value: 1, to: now) ?? now)
        completion(Timeline(entries: [current(), TodayEntry(date: tomorrow, count: nil, preview: "")], policy: .after(tomorrow)))
    }

    private func current() -> TodayEntry {
        let now = Date()
        let day = DateFormatter()
        day.calendar = Calendar(identifier: .gregorian)
        day.locale = Locale(identifier: "en_US_POSIX")
        day.dateFormat = "yyyy-MM-dd"
        let settings = UserDefaults(suiteName: "group.io.github.sdumliu.momonotes")
        if settings?.string(forKey: "widgetDate") != day.string(from: now) {
            return TodayEntry(date: now, count: nil, preview: "")
        }
        return TodayEntry(date: now, count: settings?.integer(forKey: "widgetCount"),
                          preview: settings?.string(forKey: "widgetPreview") ?? "")
    }
}

@main
struct MomoTodayWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "MomoToday", provider: TodayProvider()) { entry in
            tile(entry).widgetURL(URL(string: "momonotes://today"))
        }
        .configurationDisplayName("桃桃 · 今日待办")
        .description("查看未完成的待办事项。")
        .supportedFamilies([.systemSmall, .systemMedium])
    }

    @ViewBuilder
    private func tile(_ entry: TodayEntry) -> some View {
        let tint = Color(red: 1, green: 0.94, blue: 0.92)
        let content = VStack(alignment: .leading, spacing: 6) {
            Text("桃桃 · 今日待办").font(.caption.bold())
            if let count = entry.count {
                Text("\(count) 项未完成").font(.title3.bold())
                if !entry.preview.isEmpty { Text(entry.preview).font(.caption).lineLimit(2) }
            } else {
                Text("打开便签查看今天").font(.subheadline)
            }
        }.frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading).padding(8)
        if #available(iOS 17.0, *) {
            content.containerBackground(tint, for: .widget)
        } else {
            content.background(tint)
        }
    }
}
