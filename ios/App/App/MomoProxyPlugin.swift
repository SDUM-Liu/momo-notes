import Capacitor
import Foundation
import Network
import UIKit
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
    private var ssh: LocalSSHConnection?
    public let identifier = "MomoSyncPlugin"
    public let jsName = "MomoSync"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "updateWidget", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "sshLocalOpen", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "sshLocalRead", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "sshLocalWrite", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "sshLocalClose", returnType: CAPPluginReturnPromise)
    ]

    public override func load() {
        super.load()
        NotificationCenter.default.addObserver(self, selector: #selector(deactivateSSH),
                                               name: UIScene.willDeactivateNotification, object: nil)
    }

    @objc private func deactivateSSH() {
        ssh?.stop("桃桃便签已离开前台，本次 SSH 连接已结束")
        ssh = nil
    }

    deinit {
        NotificationCenter.default.removeObserver(self)
        let active = ssh
        DispatchQueue.main.async { active?.stop("本次 SSH 连接已结束") }
    }

    @objc func sshLocalOpen(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard self.bridge?.viewController?.viewIfLoaded?.window?.windowScene?.activationState == .foregroundActive else {
                call.reject("请在前台打开桃桃便签后再连接")
                return
            }
            guard self.ssh?.closed != false else {
                call.reject("已有 SSH 会话正在使用")
                return
            }
            guard let number = call.getInt("port"), (1...65535).contains(number),
                  let port = NWEndpoint.Port(rawValue: UInt16(number)) else {
                call.reject("SSH 端口无效")
                return
            }
            let ssh = LocalSSHConnection(port: port)
            self.ssh = ssh
            ssh.start(call)
        }
    }

    private func withSSH(_ call: CAPPluginCall, _ action: @escaping (LocalSSHConnection) -> Void) {
        DispatchQueue.main.async {
            guard let ssh = self.ssh, ssh.ready, !ssh.closed, ssh.id == call.getString("id") else {
                call.reject("本次 SSH 连接已结束")
                return
            }
            action(ssh)
        }
    }

    @objc func sshLocalRead(_ call: CAPPluginCall) { withSSH(call) { $0.read(call) } }
    @objc func sshLocalWrite(_ call: CAPPluginCall) { withSSH(call) { $0.write(call) } }
    @objc func sshLocalClose(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            if let ssh = self.ssh, ssh.id == call.getString("id") {
                ssh.stop("本次 SSH 连接已结束")
                self.ssh = nil
            }
            call.resolve()
        }
    }

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

// All state and Network.framework callbacks run on the main queue. Socket I/O is asynchronous.
private final class LocalSSHConnection {
    let id = UUID().uuidString
    private(set) var closed = false
    private(set) var ready = false
    private static let chunkSize = 16 * 1024
    private static let bannerPrefix = Data("SSH-2.0-".utf8)
    private let connection: NWConnection
    private var opening: CAPPluginCall?
    private var reader: CAPPluginCall?
    private var writer: CAPPluginCall?
    private var receiving = false
    private var eof = false
    private var buffer = Data()
    private var lastTraffic = ProcessInfo.processInfo.systemUptime

    init(port: NWEndpoint.Port) {
        connection = NWConnection(host: "127.0.0.1", port: port, using: .tcp)
    }

    func start(_ call: CAPPluginCall) {
        opening = call
        connection.stateUpdateHandler = { [weak self] state in
            guard let self = self, !self.closed else { return }
            switch state {
            case .ready: if !self.ready { self.receive() }
            case .failed: self.stop("无法连接本机 SSH 服务，请检查端口并启动服务")
            default: break
            }
        }
        connection.start(queue: .main)
        DispatchQueue.main.asyncAfter(deadline: .now() + 6) { [weak self] in
            guard let self = self, !self.ready else { return }
            self.stop("等待本机 SSH 服务响应超时")
        }
    }

    private func receive() {
        guard !receiving, !eof, !closed else { return }
        receiving = true
        let limit = ready ? Self.chunkSize : 255 - buffer.count
        connection.receive(minimumIncompleteLength: 1, maximumLength: limit) { [weak self] data, _, complete, error in
            guard let self = self, !self.closed else { return }
            self.receiving = false
            if let data = data { self.buffer.append(data) }
            self.eof = complete
            if error != nil { self.stop("读取本机 SSH 数据失败"); return }
            if !self.ready { self.checkBanner(); return }
            self.deliverRead()
        }
    }

    private func checkBanner() {
        let prefix = Self.bannerPrefix
        let count = min(buffer.count, prefix.count)
        guard buffer.prefix(count) == prefix.prefix(count) else {
            stop("该端口未提供 SSH-2.0 服务")
            return
        }
        guard let newline = buffer.firstIndex(of: 10) else {
            if eof || buffer.count >= 255 { stop("本机 SSH 服务标识不完整") }
            else { receive() }
            return
        }
        let line = buffer.prefix(upTo: newline)
        guard line.count >= prefix.count + 2, line.last == 13,
              line[prefix.count] > 32,
              line.dropFirst(prefix.count).dropLast().allSatisfy({ (32...126).contains($0) }) else {
            stop("该端口未提供有效的 SSH-2.0 服务标识")
            return
        }
        ready = true
        opening?.resolve(["id": id])
        opening = nil
        expireIfIdle()
    }

    private func expireIfIdle() {
        DispatchQueue.main.asyncAfter(deadline: .now() + 60) { [weak self] in
            guard let self = self, !self.closed else { return }
            if ProcessInfo.processInfo.systemUptime - self.lastTraffic >= 600 {
                self.stop("SSH 连接长时间未使用，已结束")
            } else { self.expireIfIdle() }
        }
    }

    func read(_ call: CAPPluginCall) {
        guard reader == nil else { call.reject("已有读取正在等待"); return }
        reader = call
        if !buffer.isEmpty || eof { deliverRead(); return }
        receive()
        DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(750)) { [weak self, weak call] in
            guard let self = self, let call = call, self.reader === call else { return }
            self.reader = nil
            call.resolve(["data": ""])
        }
    }

    private func deliverRead() {
        guard let call = reader else { return }
        if !buffer.isEmpty {
            reader = nil
            lastTraffic = ProcessInfo.processInfo.systemUptime
            call.resolve(["data": buffer.base64EncodedString()])
            buffer.removeAll(keepingCapacity: true)
        } else if eof {
            reader = nil
            call.resolve(["data": NSNull()])
            stop("本机 SSH 服务已断开")
        } else { receive() }
    }

    func write(_ call: CAPPluginCall) {
        guard writer == nil else { call.reject("已有数据正在发送"); return }
        guard let encoded = call.getString("data"), !encoded.isEmpty,
              encoded.utf8.count <= (Self.chunkSize + 2) / 3 * 4,
              let data = Data(base64Encoded: encoded), !data.isEmpty, data.count <= Self.chunkSize else {
            call.reject("SSH 数据块无效")
            return
        }
        writer = call
        connection.send(content: data, completion: .contentProcessed { [weak self] error in
            guard let self = self, !self.closed else { return }
            if error != nil { self.stop("向本机 SSH 服务写入失败"); return }
            self.lastTraffic = ProcessInfo.processInfo.systemUptime
            self.writer?.resolve()
            self.writer = nil
        })
        DispatchQueue.main.asyncAfter(deadline: .now() + 10) { [weak self, weak call] in
            guard let self = self, let call = call, self.writer === call else { return }
            self.stop("向本机 SSH 服务写入超时")
        }
    }

    func stop(_ reason: String) {
        guard !closed else { return }
        closed = true
        connection.stateUpdateHandler = nil
        connection.cancel()
        for call in [opening, reader, writer] { call?.reject(reason) }
        opening = nil
        reader = nil
        writer = nil
        buffer.removeAll()
    }
}
