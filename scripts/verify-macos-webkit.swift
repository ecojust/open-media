// A real system WKWebView harness. Native IPC returns fixture bytes, not a render claim.
import AppKit
import Foundation
import WebKit
import Darwin

final class FixtureScheme: NSObject, WKURLSchemeHandler {
    let directory: URL
    let csp: String
    var assetRequests = 0
    init(directory: URL, csp: String) { self.directory = directory; self.csp = csp; super.init() }
    func webView(_ webView: WKWebView, start urlSchemeTask: WKURLSchemeTask) {
        guard let url = urlSchemeTask.request.url else { return }
        let allowed = url.scheme == "asset" ? ["/source.mp4", "/frame.png"] : ["/index.html", "/verification.js"]
        guard url.host == "localhost", allowed.contains(url.path) else {
            urlSchemeTask.didFailWithError(NSError(domain: "OpenMediaWebKitProof", code: 404, userInfo: [NSLocalizedDescriptionKey: "Unexpected fixture URL: \(url)"]))
            return
        }
        if url.scheme == "asset" { assetRequests += 1 }
        do {
            var bytes = try Data(contentsOf: directory.appendingPathComponent(String(url.path.dropFirst())))
            let fullSize = bytes.count
            let mime = url.path.hasSuffix(".js") ? "text/javascript" : url.path.hasSuffix(".png") ? "image/png" : url.path.hasSuffix(".mp4") ? "video/mp4" : "text/html"
            var headers = ["Content-Type": mime, "Access-Control-Allow-Origin": "tauri://localhost", "Accept-Ranges": "bytes", "Cache-Control": "no-store"]
            var status = 200
            if let range = urlSchemeTask.request.value(forHTTPHeaderField: "Range"), range.hasPrefix("bytes=") {
                let limits = String(range.dropFirst(6)).split(separator: "-", omittingEmptySubsequences: false)
                if limits.count == 2, let start = Int(limits[0]), start >= 0, start < fullSize {
                    let end = min(Int(limits[1]) ?? (fullSize - 1), fullSize - 1)
                    if end >= start {
                        bytes = bytes.subdata(in: start..<(end + 1)); status = 206
                        headers["Content-Range"] = "bytes \(start)-\(end)/\(fullSize)"
                    }
                }
            }
            headers["Content-Length"] = String(bytes.count)
            if url.path == "/index.html" { headers["Content-Security-Policy"] = csp }
            let response = HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1", headerFields: headers)!
            urlSchemeTask.didReceive(response)
            if urlSchemeTask.request.httpMethod != "HEAD" { urlSchemeTask.didReceive(bytes) }
            urlSchemeTask.didFinish()
        } catch { urlSchemeTask.didFailWithError(error) }
    }
    func webView(_ webView: WKWebView, stop urlSchemeTask: WKURLSchemeTask) {}
}

final class Harness: NSObject, WKScriptMessageHandler, WKNavigationDelegate {
    let directory: URL
    let reportURL: URL
    let fixture: [String: Any]
    let scheme: FixtureScheme
    var webView: WKWebView!
    var window: NSWindow!
    var finished = false
    var calls: [[String: Any]] = []
    var stages: [[String: Any]] = []
    var requestsAtRun: Int?
    var timer: Timer?
    init(directory: URL, reportURL: URL, fixture: [String: Any]) {
        self.directory = directory; self.reportURL = reportURL; self.fixture = fixture
        self.scheme = FixtureScheme(directory: directory, csp: fixture["csp"] as! String)
        super.init()
    }
    func start() throws {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .default()
        configuration.setURLSchemeHandler(scheme, forURLScheme: "tauri")
        configuration.setURLSchemeHandler(scheme, forURLScheme: "asset")
        configuration.mediaTypesRequiringUserActionForPlayback = []
        configuration.userContentController.add(self, name: "proof")
        configuration.userContentController.add(self, name: "fixtureIPC")
        let parameters = try json(["pngSha256": fixture["pngSha256"]!, "pngBytes": fixture["pngBytes"]!])
        let bootstrap = """
        window.__verification = \(parameters);
        (() => {
          let serial = 0;
          const pending = new Map();
          window.__resolveNative = (id, success, value) => {
            const item = pending.get(id); if (!item) throw new Error('Unknown native fixture callback');
            pending.delete(id); success ? item.resolve(value) : item.reject(new Error(value));
          };
          window.__TAURI_INTERNALS__ = {
            invoke(command, args) {
              return new Promise((resolve, reject) => {
                const id = ++serial; pending.set(id, { resolve, reject });
                window.webkit.messageHandlers.fixtureIPC.postMessage({ id, command, args: args || {} });
              });
            },
            convertFileSrc(path) { return 'asset://localhost/' + path.split('/').pop(); }
          };
        })();
        """
        configuration.userContentController.addUserScript(WKUserScript(source: bootstrap, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        webView = WKWebView(frame: NSRect(x: 0, y: 0, width: 640, height: 480), configuration: configuration)
        webView.navigationDelegate = self
        window = NSWindow(contentRect: webView.frame, styleMask: [.titled], backing: .buffered, defer: false)
        window.contentView = webView
        // Attach to a window so media decoding runs normally; no capture API is used.
        window.orderFront(nil)
        timer = Timer.scheduledTimer(withTimeInterval: 90, repeats: false) { [weak self] _ in self?.complete(["passed": false, "error": "WKWebView verification exceeded 90 seconds."]) }
        webView.load(URLRequest(url: URL(string: "tauri://localhost/index.html")!))
    }
    func json(_ value: Any) throws -> String {
        String(data: try JSONSerialization.data(withJSONObject: value, options: [.fragmentsAllowed, .sortedKeys]), encoding: .utf8)!
    }
    func reply(_ id: Int, success: Bool, value: Any) {
        do {
            let script = "window.__resolveNative(\(id), \(success ? "true" : "false"), \(try json(value)))"
            webView.evaluateJavaScript(script) { [weak self] _, error in
                if let error = error { self?.complete(["passed": false, "error": "Fixture IPC callback failed: \(error)"]) }
            }
        } catch { complete(["passed": false, "error": "Fixture IPC serialization failed: \(error)"]) }
    }
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard !finished, let body = message.body as? [String: Any] else { return }
        if message.name == "proof" {
            if body["type"] as? String == "result" { complete(body) }
            else {
                stages.append(body)
                if body["stage"] as? String == "run-start" { requestsAtRun = scheme.assetRequests }
                print("WKWebView stage: \(body["stage"] ?? "unknown")")
            }
            return
        }
        guard let id = body["id"] as? Int, let command = body["command"] as? String else { complete(["passed": false, "error": "Malformed fixture IPC call."]); return }
        let args = body["args"] as? [String: Any] ?? [:]
        calls.append(["command": command, "id": id])
        switch command {
        case "begin_tool_preview":
            let spec = args["spec"] as? [String: Any] ?? [:]
            guard spec["frameOnly"] as? Bool == true, spec["width"] as? Int == 160, let start = spec["start"] as? Double, abs(start - 0.2) < 0.0001 else {
                reply(id, success: false, value: "Unexpected frame-only preview IPC contract."); return
            }
            reply(id, success: true, value: ["id": "webkit-fixture-frame", "state": "completed", "progress": 1, "stage": "Fixture native PNG ready"])
        case "tool_preview_result":
            do {
                let png = try Data(contentsOf: directory.appendingPathComponent("frame.png"))
                reply(id, success: true, value: ["id": "webkit-frame-result", "kind": "image", "name": "frame.png", "nativePath": "/fixture/frame.png", "url": "", "mime": "image/png", "duration": 5, "width": 160, "height": 90, "size": png.count, "pngBase64": png.base64EncodedString()])
            } catch { reply(id, success: false, value: String(describing: error)) }
        case "tool_preview_discard", "cancel_media_job": reply(id, success: true, value: true)
        default: reply(id, success: false, value: "Unexpected production IPC command: \(command)")
        }
    }
    func complete(_ result: [String: Any]) {
        guard !finished else { return }
        finished = true; timer?.invalidate()
        var proof = result
        if proof["passed"] as? Bool == true {
            let names = calls.compactMap { $0["command"] as? String }
            let correct = names.contains("begin_tool_preview") && names.contains("tool_preview_result") && names.contains("tool_preview_discard") && requestsAtRun != nil && requestsAtRun == scheme.assetRequests
            if !correct { proof["passed"] = false; proof["error"] = "Production frame path did not use/discard fixture native PNG exclusively." }
        }
        proof["engine"] = "System WKWebView"
        proof["operatingSystem"] = ProcessInfo.processInfo.operatingSystemVersionString
        proof["fixtureIPC"] = true
        proof["nativeCompositionVerified"] = false
        proof["ipcCalls"] = calls
        proof["nativeStages"] = stages
        proof["assetRequests"] = scheme.assetRequests
        proof["assetRequestsAtRun"] = requestsAtRun ?? -1
        do { try JSONSerialization.data(withJSONObject: proof, options: [.prettyPrinted, .sortedKeys]).write(to: reportURL) }
        catch { fputs("Cannot write WebKit proof: \(error)\n", stderr); exit(1) }
        print("WKWebView verification passed: \(proof["passed"] as? Bool == true)")
        exit(proof["passed"] as? Bool == true ? 0 : 1)
    }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { complete(["passed": false, "error": "Navigation failed: \(error)"]) }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { complete(["passed": false, "error": "Navigation failed: \(error)"]) }
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { complete(["passed": false, "error": "WebKit content process terminated."]) }
}

guard CommandLine.arguments.count == 3 else { fputs("Usage: verify-macos-webkit <fixture-directory> <proof.json>\n", stderr); exit(2) }
let directory = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
let output = URL(fileURLWithPath: CommandLine.arguments[2])
let app = NSApplication.shared
app.setActivationPolicy(.accessory)
do {
    let fixture = try JSONSerialization.jsonObject(with: Data(contentsOf: directory.appendingPathComponent("fixture.json"))) as! [String: Any]
    let harness = Harness(directory: directory, reportURL: output, fixture: fixture)
    try harness.start()
    withExtendedLifetime(harness) { app.run() }
} catch { fputs("WebKit harness startup failed: \(error)\n", stderr); exit(1) }
