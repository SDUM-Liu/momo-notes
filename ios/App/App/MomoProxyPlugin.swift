import Capacitor
import Foundation
import WidgetKit

class MomoViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(MomoProxyPlugin())
        bridge?.registerPluginInstance(MomoSyncPlugin())
    }
}

private final class NoRedirects: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}

@objc(MomoProxyPlugin)
public final class MomoProxyPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "MomoProxyPlugin"
    public let jsName = "MomoProxy"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "post", returnType: CAPPluginReturnPromise)
    ]

    @objc func post(_ call: CAPPluginCall) {
        guard let port = call.getInt("port"), (1...65535).contains(port),
              let address = call.getString("url"), let url = URL(string: address), let host = url.host,
              let body = call.getString("body"), url.user == nil, url.password == nil,
              url.scheme == "https" || (url.scheme == "http" && ["localhost", "127.0.0.1", "::1", "[::1]"].contains(host)) else {
            call.reject("API 地址或代理端口无效")
            return
        }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if let authorization = call.getString("authorization"), !authorization.isEmpty {
            request.setValue(authorization, forHTTPHeaderField: "Authorization")
        }
        request.httpBody = Data(body.utf8)

        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 15
        configuration.timeoutIntervalForResource = 45
        configuration.connectionProxyDictionary = [
            "HTTPEnable": 1, "HTTPProxy": "127.0.0.1", "HTTPPort": port,
            "HTTPSEnable": 1, "HTTPSProxy": "127.0.0.1", "HTTPSPort": port
        ]
        let session = URLSession(configuration: configuration, delegate: NoRedirects(), delegateQueue: nil)
        session.dataTask(with: request) { data, response, error in
            defer { session.finishTasksAndInvalidate() }
            guard error == nil, let response = response as? HTTPURLResponse else {
                call.reject("连不上 AI API，请检查地址和本地代理端口")
                return
            }
            guard let data = data, data.count <= 2 * 1024 * 1024 else {
                call.reject("AI 返回内容过长")
                return
            }
            call.resolve(["status": response.statusCode, "body": String(decoding: data, as: UTF8.self)])
        }.resume()
    }
}

@objc(MomoSyncPlugin)
public final class MomoSyncPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "MomoSyncPlugin"
    public let jsName = "MomoSync"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "updateWidget", returnType: CAPPluginReturnPromise)
    ]

    @objc func updateWidget(_ call: CAPPluginCall) {
        guard let settings = UserDefaults(suiteName: "group.io.github.sdumliu.momonotes") else {
            call.reject("小组件共享容器不可用")
            return
        }
        settings.set(call.getString("date"), forKey: "widgetDate")
        settings.set(call.getInt("count") ?? 0, forKey: "widgetCount")
        settings.set(call.getString("preview"), forKey: "widgetPreview")
        WidgetCenter.shared.reloadTimelines(ofKind: "MomoToday")
        call.resolve()
    }
}
