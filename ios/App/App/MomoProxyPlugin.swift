import Capacitor
import Foundation
import Network

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
    public let pluginMethods = [CAPPluginMethod(name: "exchange", returnType: CAPPluginReturnPromise)]

    @objc func exchange(_ call: CAPPluginCall) {
        guard let host = call.getString("host"), let address = IPv4Address(host),
              let message = call.getString("message"), !message.contains("\n"),
              message.utf8.count <= SyncExchange.limit else {
            call.reject("同步请求无效")
            return
        }
        SyncExchange(address: address, message: message, call: call).start()
    }
}

private final class SyncExchange {
    static let limit = 32 * 1024 * 1024
    private let queue = DispatchQueue(label: "momo.sync")
    private let connection: NWConnection
    private let call: CAPPluginCall
    private let message: Data
    private var response = Data()
    private var finished = false

    init(address: IPv4Address, message: String, call: CAPPluginCall) {
        connection = NWConnection(host: .ipv4(address), port: 38425, using: .tcp)
        self.call = call
        self.message = Data((message + "\n").utf8)
    }

    func start() {
        connection.stateUpdateHandler = { [self] state in
            switch state {
            case .ready:
                connection.send(content: message, completion: .contentProcessed { [self] error in
                    if error != nil { finish(nil) } else { receive() }
                })
            case .failed, .cancelled:
                finish(nil)
            default:
                break
            }
        }
        connection.start(queue: queue)
        queue.asyncAfter(deadline: .now() + 65) { [weak self] in self?.finish(nil) }
        queue.asyncAfter(deadline: .now() + 6) { [weak self] in
            if let self = self, self.connection.state != .ready { self.finish(nil) }
        }
    }

    private func receive() {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 65536) { [self] data, _, complete, error in
            if finished { return }
            if let data = data {
                let end = data.firstIndex(of: 10)
                response.append(contentsOf: data.prefix(upTo: end ?? data.endIndex))
                if response.count > Self.limit { finish(nil); return }
                if end != nil { finish(String(data: response, encoding: .ascii)); return }
            }
            if complete || error != nil { finish(nil) } else { receive() }
        }
    }

    private func finish(_ result: String?) {
        if finished { return }
        finished = true
        connection.stateUpdateHandler = nil
        connection.cancel()
        if let result = result { call.resolve(["message": result]) }
        else { call.reject("主机未响应，请检查配对码和本地网络权限") }
    }
}
