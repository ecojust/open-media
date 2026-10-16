// Build on macOS: xcrun swiftc -swift-version 5 scripts/drive-macos-recording-ui.swift -o <driver>
// The application must already be launched normally. This driver presses only
// controls belonging to its PID; it never grants permissions or drives system dialogs.
import AppKit
import ApplicationServices
import Foundation
import Darwin

struct DriverFailure: Error {
    let outcome: String
    let message: String
}

struct ElementRecord {
    let element: AXUIElement
    let id: Int
    let parent: Int?
    let depth: Int
    let attributes: [String: Any]

    var role: String { attributes["AXRole"] as? String ?? "" }
    var enabled: Bool? { (attributes["AXEnabled"] as? NSNumber)?.boolValue }
    var strings: [String] {
        ["AXTitle", "AXDescription", "AXValue", "AXHelp", "AXIdentifier"]
            .compactMap { attributes[$0] as? String }
    }
    var json: [String: Any] {
        var value = attributes
        value["id"] = id
        value["depth"] = depth
        if let parent = parent { value["parent"] = parent }
        return value
    }
}

struct TreeSnapshot {
    let nodes: [ElementRecord]
    let errors: [[String: Any]]
    let truncated: Bool
    let timestamp: String

    var text: String { nodes.flatMap { $0.strings }.joined(separator: "\n") }
    var json: [String: Any] {
        ["timestamp": timestamp, "nodes": nodes.map { $0.json },
         "errors": errors, "truncated": truncated]
    }
    func names(for node: ElementRecord) -> [String] {
        // Some web buttons expose their label only as descendant static text.
        var labels = node.strings
        for descendant in nodes.dropFirst(node.id + 1) {
            if descendant.depth <= node.depth { break }
            if descendant.role == "AXStaticText" { labels.append(contentsOf: descendant.strings) }
        }
        return labels.map(normalized)
    }
    func button(_ label: String) -> ElementRecord? {
        let wanted = normalized(label)
        return nodes.first { node in
            ["AXButton", "AXCheckBox", "AXRadioButton"].contains(node.role)
                && node.enabled == true && names(for: node).contains(wanted)
        }
    }
    func containsText(_ value: String) -> Bool {
        nodes.contains { $0.strings.contains { normalized($0) == normalized(value) } }
    }
}

func normalized(_ text: String) -> String {
    text.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
}

func timestamp() -> String { ISO8601DateFormatter().string(from: Date()) }

final class RecordingUIDriver {
    let pid: pid_t
    let application: AXUIElement
    let directory: URL
    let beganAt = timestamp()
    let beganUptime = ProcessInfo.processInfo.systemUptime
    var stage = "startup"
    var stages: [[String: Any]] = []
    var lastTree: TreeSnapshot?
    var manualAccessibilityResult: Int32?
    var sawWebContent = false
    var captureRequested = false
    var microphoneChanged = false
    var microphoneVerifiedOff = false

    init(pid: pid_t, directory: URL) {
        self.pid = pid
        self.application = AXUIElementCreateApplication(pid)
        self.directory = directory
        AXUIElementSetMessagingTimeout(application, 0.35)
    }

    func checkDeadline() throws {
        if ProcessInfo.processInfo.systemUptime - beganUptime >= 290 {
            throw DriverFailure(outcome: "timeout", message: "The complete UI test exceeded its 290-second deadline.")
        }
        if kill(pid, 0) != 0 && errno == ESRCH {
            throw DriverFailure(outcome: "failed", message: "The target application process exited.")
        }
    }

    func emit(_ value: [String: Any]) {
        if let data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]),
           let line = String(data: data, encoding: .utf8) {
            print(line)
            fflush(stdout)
        }
    }

    func write(_ value: [String: Any], file: String) throws {
        // All evidence uses fixed file names within the caller's evidence directory.
        let data = try JSONSerialization.data(withJSONObject: value, options: [.prettyPrinted, .sortedKeys])
        try data.write(to: directory.appendingPathComponent(file), options: .atomic)
    }

    func read(_ element: AXUIElement, attribute: String) throws -> (AXError, CFTypeRef?) {
        try checkDeadline()
        var result: CFTypeRef?
        let status = AXUIElementCopyAttributeValue(element, attribute as CFString, &result)
        if status == .apiDisabled {
            throw DriverFailure(outcome: "automation-blocked", message: "Accessibility access is disabled; no permission dialog was accepted by this driver.")
        }
        return (status, result)
    }

    func snapshot() throws -> TreeSnapshot {
        var nodes: [ElementRecord] = []
        var errors: [[String: Any]] = []
        var visited: [AXUIElement] = []
        var truncated = false
        let fields = ["AXRole", "AXSubrole", "AXTitle", "AXDescription", "AXValue", "AXHelp", "AXIdentifier", "AXEnabled", "AXHidden", "AXSelected"]

        func visit(_ element: AXUIElement, parent: Int?, depth: Int) throws {
            try checkDeadline()
            if nodes.count >= 3500 || depth > 48 { truncated = true; return }
            if visited.contains(where: { CFEqual($0, element) }) { return }
            visited.append(element)
            let id = nodes.count
            var attributes: [String: Any] = [:]
            for field in fields {
                let (status, value) = try read(element, attribute: field)
                if status == .success, let value = value {
                    if let string = value as? String { attributes[field] = String(string.prefix(12000)) }
                    else if let number = value as? NSNumber { attributes[field] = number }
                } else if ![AXError.attributeUnsupported, .noValue, .success].contains(status), errors.count < 100 {
                    errors.append(["node": id, "attribute": field, "code": status.rawValue])
                }
            }
            nodes.append(ElementRecord(element: element, id: id, parent: parent, depth: depth, attributes: attributes))
            if (attributes["AXHidden"] as? NSNumber)?.boolValue == true { return }
            // Separate native picker windows are still owned by the same application.
            for attribute in depth == 0 ? ["AXChildren", "AXWindows"] : ["AXChildren"] {
                let (status, children) = try read(element, attribute: attribute)
                if status == .success, let children = children as? [AXUIElement] {
                    for child in children { try visit(child, parent: id, depth: depth + 1) }
                }
            }
        }

        try visit(application, parent: nil, depth: 0)
        let tree = TreeSnapshot(nodes: nodes, errors: errors, truncated: truncated, timestamp: timestamp())
        lastTree = tree
        if nodes.contains(where: { $0.role == "AXWebArea" }) { sawWebContent = true }
        return tree
    }

    func detectPermissionFailure(_ tree: TreeSnapshot) throws {
        let pattern = #"(?i)-3801|\bTCC\b|系统拒绝了当前.*屏幕录制|系统未允许屏幕录制访问"#
        if tree.text.range(of: pattern, options: .regularExpression) != nil {
            let lines = tree.text.split(separator: "\n").filter {
                String($0).range(of: pattern, options: .regularExpression) != nil
            }
            throw DriverFailure(outcome: "permission-denied", message: String(lines.joined(separator: "\n").prefix(16000)))
        }
    }

    func checkpoint(_ name: String, tree: TreeSnapshot) throws {
        stage = name
        let file = String(format: "%02d-%@-ax.json", stages.count + 1, name)
        try write(tree.json, file: file)
        let record: [String: Any] = ["stage": name, "timestamp": timestamp(), "tree": file, "nodes": tree.nodes.count]
        stages.append(record)
        emit(["event": "stage", "stage": name, "timestamp": timestamp(), "tree": file])
    }

    func waitFor(_ name: String, seconds: Double, predicate: (TreeSnapshot) -> Bool) throws -> TreeSnapshot {
        stage = name
        let deadline = min(beganUptime + 290, ProcessInfo.processInfo.systemUptime + seconds)
        var lastPeriodicDump = ProcessInfo.processInfo.systemUptime
        while ProcessInfo.processInfo.systemUptime < deadline {
            let tree = try snapshot()
            try detectPermissionFailure(tree)
            if predicate(tree) { return tree }
            if ProcessInfo.processInfo.systemUptime - lastPeriodicDump >= 10 {
                try write(tree.json, file: "waiting-\(name)-ax.json")
                emit(["event": "waiting", "stage": name, "timestamp": timestamp(), "nodes": tree.nodes.count])
                lastPeriodicDump = ProcessInfo.processInfo.systemUptime
            }
            Thread.sleep(forTimeInterval: 0.3)
        }
        throw DriverFailure(outcome: sawWebContent ? "timeout" : "automation-blocked",
                            message: "Timed out waiting for \(name).\(sawWebContent ? "" : " The application's web accessibility tree was not available.")")
    }

    func press(_ label: String, in tree: TreeSnapshot) throws {
        guard let node = tree.button(label) else {
            throw DriverFailure(outcome: "failed", message: "No enabled application button named \(label) is present.")
        }
        try press(node, label: label)
    }

    func press(_ node: ElementRecord, label: String) throws {
        let (_, enabled) = try read(node.element, attribute: "AXEnabled")
        guard (enabled as? NSNumber)?.boolValue == true else {
            throw DriverFailure(outcome: "failed", message: "Button \(label) became disabled before it could be pressed.")
        }
        var owner: pid_t = 0
        let ownerStatus = AXUIElementGetPid(node.element, &owner)
        emit(["event": "control-owner", "stage": stage, "label": label,
              "ownerPid": owner, "applicationPid": pid, "AXResult": ownerStatus.rawValue])
        guard ownerStatus == .success, owner == pid else {
            throw DriverFailure(outcome: "automation-blocked", message: "Refusing to press a control outside the target application: control owner PID \(owner), application PID \(pid), AX error \(ownerStatus.rawValue).")
        }
        let status = AXUIElementPerformAction(node.element, kAXPressAction as CFString)
        guard status == .success else {
            throw DriverFailure(outcome: status == .apiDisabled ? "automation-blocked" : "failed",
                                message: "AXPress failed for \(label), error \(status.rawValue).")
        }
        emit(["event": "press", "stage": stage, "label": label, "timestamp": timestamp()])
    }

    func microphoneControl(in tree: TreeSnapshot) -> ElementRecord? {
        tree.nodes.first { node in
            guard ["AXCheckBox", "AXSwitch"].contains(node.role) else { return false }
            var labels = tree.names(for: node)
            if let parent = node.parent, parent < tree.nodes.count {
                labels.append(contentsOf: tree.names(for: tree.nodes[parent]))
            }
            return labels.contains { $0.contains("麦克风") }
        }
    }

    func toggleState(_ node: ElementRecord) -> Bool? {
        if let number = node.attributes["AXValue"] as? NSNumber { return number.boolValue }
        if let value = node.attributes["AXValue"] as? String {
            if ["0", "false", "off"].contains(value.lowercased()) { return false }
            if ["1", "true", "on"].contains(value.lowercased()) { return true }
        }
        if let selected = node.attributes["AXSelected"] as? NSNumber { return selected.boolValue }
        return nil
    }

    func run() throws {
        guard AXIsProcessTrusted() else {
            throw DriverFailure(outcome: "automation-blocked", message: "The test driver has no Accessibility access. It does not request or grant this permission.")
        }
        let manual = AXUIElementSetAttributeValue(application, "AXManualAccessibility" as CFString, kCFBooleanTrue)
        manualAccessibilityResult = manual.rawValue
        // Let the normally launched application restore its UI before looking for controls.
        Thread.sleep(forTimeInterval: 1)
        let initial = try waitFor("application-ready", seconds: 35) { $0.button("录屏") != nil }
        try checkpoint("application-ready", tree: initial)
        try press("录屏", in: initial)
        var workspace = try waitFor("recorder-ready", seconds: 30) {
            $0.containsText("屏幕录制") && $0.button("开始录制") != nil
        }
        try checkpoint("recorder-ready", tree: workspace)
        guard let microphone = microphoneControl(in: workspace), let enabled = toggleState(microphone) else {
            throw DriverFailure(outcome: "automation-blocked", message: "Could not verify the application's microphone switch; refusing to start recording.")
        }
        // The fresh UI defaults to off. If its state differs, turn capture off
        // through the real control before continuing; never request audio access.
        if enabled {
            try press(microphone, label: "录制麦克风")
            microphoneChanged = true
            workspace = try waitFor("microphone-disabled", seconds: 10) { tree in
                guard let control = self.microphoneControl(in: tree) else { return false }
                return self.toggleState(control) == false
            }
        }
        microphoneVerifiedOff = true
        try checkpoint("microphone-disabled", tree: workspace)
        try press("开始录制", in: workspace)
        captureRequested = true
        let picker = try waitFor("picker-ready", seconds: 135) {
            $0.button("取消选择") != nil && $0.button("屏幕") != nil
                && $0.button("区域") != nil && $0.button("窗口") != nil
        }
        try checkpoint("picker-ready", tree: picker)
        try press("屏幕", in: picker)
        let selected = try waitFor("screen-selected", seconds: 15) { tree in
            guard let screen = tree.button("屏幕") else { return false }
            return self.toggleState(screen) == true
                && tree.button("取消选择") != nil && tree.button("开始录制") != nil
        }
        try checkpoint("screen-selected", tree: selected)
        try press("开始录制", in: selected)
        let recording = try waitFor("recording", seconds: 45) {
            $0.containsText("正在录制") && $0.button("停止") != nil && $0.button("取消选择") == nil
        }
        try checkpoint("recording", tree: recording)
        let stopAfter = ProcessInfo.processInfo.systemUptime + 3
        while ProcessInfo.processInfo.systemUptime < stopAfter {
            try checkDeadline()
            Thread.sleep(forTimeInterval: 0.3)
        }
        let beforeStop = try snapshot()
        try detectPermissionFailure(beforeStop)
        try press("停止", in: beforeStop)
        let imported = try waitFor("recording-imported", seconds: 60) {
            $0.text.range(of: #"本次已录制\s*1\s*段"#, options: .regularExpression) != nil
                && $0.button("开始录制") != nil && $0.button("停止") == nil
        }
        captureRequested = false
        try checkpoint("recording-imported", tree: imported)
    }

    func permissionPromptEvidence() -> [String: Any] {
        let began = ProcessInfo.processInfo.systemUptime
        let deadline = began + 5
        let allowedBundles = [
            "com.apple.UserNotificationCenter", "com.apple.SecurityAgent",
            "com.apple.notificationcenterui", "com.apple.CoreServicesUIAgent",
            "com.apple.systempreferences"
        ]
        let pattern = #"(?i)open[ -]?media|com\.ecojust\.openmedia"#
        var prompts: [[String: Any]] = []
        var visitedCount = 0
        var readErrors = 0
        var visited: [AXUIElement] = []
        var limitReached = false

        func hasTime() -> Bool {
            let available = ProcessInfo.processInfo.systemUptime < deadline && visitedCount < 300
            if !available { limitReached = true }
            return available
        }
        func value(_ element: AXUIElement, _ attribute: String) -> CFTypeRef? {
            guard hasTime() else { return nil }
            let remaining = deadline - ProcessInfo.processInfo.systemUptime
            guard remaining > 0 else { limitReached = true; return nil }
            AXUIElementSetMessagingTimeout(element, Float(min(0.1, remaining)))
            var result: CFTypeRef?
            let status = AXUIElementCopyAttributeValue(element, attribute as CFString, &result)
            if status != .success {
                if status != .attributeUnsupported && status != .noValue { readErrors += 1 }
                return nil
            }
            return result
        }
        func matchingTexts(_ element: AXUIElement, depth: Int) -> [String] {
            guard hasTime() else { return [] }
            guard depth <= 24 else { limitReached = true; return [] }
            if visited.contains(where: { CFEqual($0, element) }) { return [] }
            visited.append(element)
            visitedCount += 1
            var matches: [String] = []
            for attribute in ["AXTitle", "AXDescription", "AXValue"] {
                if let text = value(element, attribute) as? String,
                   text.range(of: pattern, options: .regularExpression) != nil {
                    let relevant = text.split(separator: "\n").filter {
                        String($0).range(of: pattern, options: .regularExpression) != nil
                    }
                    matches.append(String(relevant.joined(separator: "\n").prefix(3000)))
                }
            }
            if let children = value(element, "AXChildren") as? [AXUIElement] {
                for child in children {
                    guard hasTime() else { break }
                    matches.append(contentsOf: matchingTexts(child, depth: depth + 1))
                }
            }
            return matches
        }

        // Read only named system processes. No actions or attribute mutations are
        // performed, and unrelated window text is never retained in the report.
        let applications = NSWorkspace.shared.runningApplications.filter {
            allowedBundles.contains($0.bundleIdentifier ?? "")
        }.sorted {
            (allowedBundles.firstIndex(of: $0.bundleIdentifier ?? "") ?? allowedBundles.count)
                < (allowedBundles.firstIndex(of: $1.bundleIdentifier ?? "") ?? allowedBundles.count)
        }
        for running in applications {
            guard hasTime() else { break }
            visitedCount += 1
            let root = AXUIElementCreateApplication(running.processIdentifier)
            var windows = value(root, "AXWindows") as? [AXUIElement] ?? []
            if windows.isEmpty, let children = value(root, "AXChildren") as? [AXUIElement] {
                for child in children {
                    guard hasTime() else { break }
                    visitedCount += 1
                    if value(child, "AXRole") as? String == "AXWindow" { windows.append(child) }
                }
            }
            for window in windows {
                guard hasTime() else { break }
                let texts = Array(Set(matchingTexts(window, depth: 0))).sorted()
                if !texts.isEmpty {
                    prompts.append(["bundleID": running.bundleIdentifier ?? "", "pid": running.processIdentifier,
                                    "matchingTexts": texts])
                }
            }
        }
        return ["observed": !prompts.isEmpty, "permissionPrompts": prompts,
                "visitedNodes": visitedCount, "AXReadErrors": readErrors, "limitReached": limitReached,
                "durationSeconds": ProcessInfo.processInfo.systemUptime - began,
                "scope": "Read-only matching window text in named system processes. No match does not prove that no permission prompt exists."]
    }

    func finish(outcome: String, error: String? = nil) {
        var report: [String: Any] = [
            "outcome": outcome, "stage": stage, "pid": pid, "startedAt": beganAt,
            "finishedAt": timestamp(), "durationSeconds": ProcessInfo.processInfo.systemUptime - beganUptime,
            "accessibilityTrusted": AXIsProcessTrusted(), "sawWebContent": sawWebContent,
            "stages": stages, "microphoneChanged": microphoneChanged,
            "microphoneVerifiedOff": microphoneVerifiedOff, "permissionDialogsAccepted": false,
            "scope": "normal-application-ui-recording-and-import; media-file-validation-is-separate"
        ]
        if let error = error { report["error"] = error }
        if let result = manualAccessibilityResult { report["manualAccessibilityResult"] = result }
        if let tree = lastTree {
            do { try write(tree.json, file: "final-ax.json"); report["finalTree"] = "final-ax.json" }
            catch { report["treeWriteError"] = error.localizedDescription }
        }
        // A failed test can leave a selector or recorder open. Only interact with
        // its existing controls; preserve the failure and never accept OS prompts.
        if outcome != "recorded", captureRequested, let tree = lastTree {
            for label in ["停止", "取消选择", "取消"] {
                guard let control = tree.button(label) else { continue }
                var owner: pid_t = 0
                var enabled: CFTypeRef?
                guard AXUIElementGetPid(control.element, &owner) == .success, owner == pid,
                      AXUIElementCopyAttributeValue(control.element, "AXEnabled" as CFString, &enabled) == .success,
                      (enabled as? NSNumber)?.boolValue == true else { continue }
                let cleanup = AXUIElementPerformAction(control.element, kAXPressAction as CFString)
                report["cleanup"] = ["label": label, "AXResult": cleanup.rawValue]
                emit(["event": "cleanup", "stage": stage, "label": label, "AXResult": cleanup.rawValue])
                if cleanup == .success { break }
            }
        }
        if outcome == "permission-denied" {
            // Cleanup above takes priority over the bounded, read-only observation.
            let evidence = permissionPromptEvidence()
            report["permissionPrompts"] = evidence["permissionPrompts"]
            report["permissionPromptEvidence"] = evidence
            emit(["event": "permission-prompt-evidence", "stage": stage, "evidence": evidence])
        }
        report["finishedAt"] = timestamp()
        report["durationSeconds"] = ProcessInfo.processInfo.systemUptime - beganUptime
        do { try write(report, file: "ui-report.json") }
        catch {
            emit(["event": "report-write-failed", "error": error.localizedDescription])
            exit(1)
        }
        emit(["event": "result", "outcome": outcome, "stage": stage, "report": "ui-report.json"])
    }
}

guard CommandLine.arguments.count == 3,
      let pid = Int32(CommandLine.arguments[1]), pid > 0 else {
    fputs("Usage: drive-macos-recording-ui <application-pid> <evidence-directory>\n", stderr)
    exit(2)
}
let evidence = URL(fileURLWithPath: CommandLine.arguments[2], isDirectory: true).standardizedFileURL
do { try FileManager.default.createDirectory(at: evidence, withIntermediateDirectories: true) }
catch { fputs("Unable to create evidence directory: \(error)\n", stderr); exit(2) }
let driver = RecordingUIDriver(pid: pid, directory: evidence)
do {
    try driver.run()
    driver.finish(outcome: "recorded")
} catch let failure as DriverFailure {
    driver.finish(outcome: failure.outcome, error: failure.message)
    exit(failure.outcome == "timeout" ? 124 : 1)
} catch {
    driver.finish(outcome: "failed", error: error.localizedDescription)
    exit(1)
}
