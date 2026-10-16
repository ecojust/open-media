import AppKit
import AVFoundation
import CoreMedia
import CoreVideo
import Darwin
import ScreenCaptureKit

// This process owns both the recording devices and the visible recording border.
// Closing its input, terminating its parent, or receiving a stop signal releases all three.
struct CaptureFailure: LocalizedError {
    let message: String
    var errorDescription: String? { message }
    init(_ message: String) { self.message = message }
}

struct Bounds: Codable {
    let x: Double
    let y: Double
    let width: Double
    let height: Double
    init(_ rect: CGRect) {
        x = rect.minX; y = rect.minY; width = rect.width; height = rect.height
    }
}

struct Source: Codable {
    let id: String
    let name: String
    let kind: String
    var width: Int? = nil
    var height: Int? = nil
    var bounds: Bounds? = nil
    var scaleFactor: Double? = nil
}

struct Region: Codable {
    let x: Int
    let y: Int
    let width: Int
    let height: Int
}

struct OutputSize: Codable {
    let width: Int
    let height: Int
}

struct Options: Decodable {
    let sourceId: String
    let fps: Int
    let microphone: Bool
    let audioDevice: String?
    let region: Region?
    let outputSize: OutputSize

    func validate(sourceWidth: Int, sourceHeight: Int, isWindow: Bool) throws {
        guard (1...60).contains(fps) else { throw CaptureFailure("录制帧率应为 1 至 60。") }
        guard (16...7680).contains(outputSize.width), (16...4320).contains(outputSize.height),
              outputSize.width % 2 == 0, outputSize.height % 2 == 0 else {
            throw CaptureFailure("输出尺寸应为有效的偶数像素，最大为 7680 × 4320。")
        }
        if let region = region {
            guard !isWindow else { throw CaptureFailure("窗口录制会跟随完整窗口，请使用屏幕来源设置局部区域。") }
            guard region.x >= 0, region.y >= 0, region.width >= 16, region.height >= 16,
                  region.x <= sourceWidth - region.width,
                  region.y <= sourceHeight - region.height else {
                throw CaptureFailure("录制区域超出了所选屏幕。")
            }
        }
    }
}

@MainActor func screenScale(for rect: CGRect) -> Double {
    var chosen: NSScreen?
    var overlap: CGFloat = -1
    for screen in NSScreen.screens {
        guard let number = screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber else { continue }
        let intersection = CGDisplayBounds(number.uint32Value).intersection(rect)
        let area = intersection.isNull ? 0 : intersection.width * intersection.height
        if area > overlap { overlap = area; chosen = screen }
    }
    return Double(chosen?.backingScaleFactor ?? 1)
}

func pixelSize(_ rect: CGRect, scale: Double) -> (Int, Int) {
    (max(1, Int((rect.width * scale).rounded())), max(1, Int((rect.height * scale).rounded())))
}

func borderRect(source: CGRect, region: Region?, scale: Double) -> CGRect {
    guard let region = region else { return source }
    return CGRect(x: source.minX + Double(region.x) / scale,
                  y: source.minY + Double(region.y) / scale,
                  width: Double(region.width) / scale,
                  height: Double(region.height) / scale)
}

func appKitRect(_ rect: CGRect, primaryTop: CGFloat) -> CGRect {
    CGRect(x: rect.minX, y: primaryTop - rect.maxY, width: rect.width, height: rect.height)
}

func aspectFit(source: CGSize, output: OutputSize) -> CGRect {
    let scale = min(Double(output.width) / source.width, Double(output.height) / source.height)
    let width = source.width * scale, height = source.height * scale
    return CGRect(x: (Double(output.width) - width) / 2,
                  y: (Double(output.height) - height) / 2, width: width, height: height)
}

func writeJSON<T: Encodable>(_ value: T) throws {
    let data = try JSONEncoder().encode(value)
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data([10]))
}

func writeError(_ error: Error) {
    FileHandle.standardError.write(Data((error.localizedDescription + "\n").utf8))
}

func retimeAudioSample(_ sample: CMSampleBuffer, to hostPTS: CMTime) throws -> CMSampleBuffer {
    var timing = CMSampleTimingInfo()
    guard CMSampleBufferGetSampleTimingInfo(sample, at: 0, timingInfoOut: &timing) == noErr else {
        throw CaptureFailure("无法读取麦克风音轨的时间信息。")
    }
    // A PCM buffer contains many samples. Preserve the duration of ONE sample,
    // rather than replacing it with the duration of the complete buffer.
    let offset = CMTimeSubtract(hostPTS, timing.presentationTimeStamp)
    timing.presentationTimeStamp = hostPTS
    if timing.decodeTimeStamp.isValid { timing.decodeTimeStamp = CMTimeAdd(timing.decodeTimeStamp, offset) }
    var copy: CMSampleBuffer?
    let status = CMSampleBufferCreateCopyWithNewTiming(allocator: kCFAllocatorDefault, sampleBuffer: sample,
                                                     sampleTimingEntryCount: 1, sampleTimingArray: &timing,
                                                     sampleBufferOut: &copy)
    guard status == noErr, let copy = copy else { throw CaptureFailure("无法同步麦克风音轨。") }
    return copy
}

@MainActor func listSources(requestPermission: Bool) async throws -> [Source] {
    if requestPermission, !CGPreflightScreenCaptureAccess(), !CGRequestScreenCaptureAccess() {
        throw CaptureFailure("请在系统设置中允许 Open Media 的屏幕录制权限，然后重新打开应用并刷新来源。")
    }
    var sources: [Source] = []
    for (index, screen) in NSScreen.screens.enumerated() {
        guard let number = screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber else { continue }
        let id = number.uint32Value, rect = CGDisplayBounds(id)
        let scale = Double(screen.backingScaleFactor)
        let size = pixelSize(rect, scale: scale)
        sources.append(Source(id: "screen:\(id)", name: "屏幕 \(index + 1) · \(screen.localizedName)", kind: "screen",
                              width: size.0, height: size.1, bounds: Bounds(rect), scaleFactor: scale))
    }
    // Reading available sources never requests access or starts a recording.
    // The operating system provides window titles after screen access is granted.
    if CGPreflightScreenCaptureAccess() {
        let content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: true)
        let ownPID = getpid(), parentPID = getppid()
        for window in content.windows.sorted(by: { $0.windowID < $1.windowID }) {
            guard window.isOnScreen, window.windowLayer == 0,
                  let title = window.title?.trimmingCharacters(in: .whitespacesAndNewlines), !title.isEmpty,
                  window.frame.width >= 16, window.frame.height >= 16,
                  window.owningApplication?.processID != ownPID,
                  window.owningApplication?.processID != parentPID else { continue }
            let scale = screenScale(for: window.frame), size = pixelSize(window.frame, scale: scale)
            let app = window.owningApplication?.applicationName ?? "窗口"
            sources.append(Source(id: "window:\(window.windowID)", name: "\(app) · \(title)", kind: "window",
                                  width: size.0, height: size.1, bounds: Bounds(window.frame), scaleFactor: scale))
        }
    }
    for device in AVCaptureDevice.devices(for: .audio) {
        sources.append(Source(id: device.uniqueID, name: device.localizedName, kind: "audio"))
    }
    return sources
}

final class BorderView: NSView {
    override func draw(_ dirtyRect: NSRect) {
        NSColor.clear.setFill()
        dirtyRect.fill()
        NSColor(calibratedRed: 1, green: 0.12, blue: 0.16, alpha: 1).setStroke()
        let line = NSBezierPath(rect: bounds.insetBy(dx: 1.5, dy: 1.5))
        line.lineWidth = 3
        line.stroke()
    }
}

@MainActor final class RecordingBorder {
    let panel: NSPanel
    init() {
        panel = NSPanel(contentRect: .zero, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        panel.title = "Open Media 录制范围"
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = false
        panel.ignoresMouseEvents = true
        panel.isFloatingPanel = true
        panel.hidesOnDeactivate = false
        panel.isReleasedWhenClosed = false
        panel.level = .screenSaver
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .ignoresCycle, .stationary]
        // Keep the panel discoverable so the stream can explicitly exclude it.
        panel.sharingType = .readOnly
        panel.contentView = BorderView(frame: .zero)
    }
    func update(_ rect: CGRect) {
        let primaryTop = NSScreen.screens.first(where: {
            ($0.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber)?.uint32Value == CGMainDisplayID()
        })?.frame.maxY ?? CGFloat(CGDisplayPixelsHigh(CGMainDisplayID()))
        panel.setFrame(appKitRect(rect, primaryTop: primaryTop), display: true)
        panel.orderFrontRegardless()
    }
    func close() { panel.orderOut(nil); panel.close() }
}

final class Recorder: NSObject, SCStreamDelegate, SCStreamOutput, AVCaptureAudioDataOutputSampleBufferDelegate {
    private let queue = DispatchQueue(label: "open-media.capture.frames")
    private var stream: SCStream?
    private var microphone: AVCaptureSession?
    private var microphoneClock: CMClock?
    private var writer: AVAssetWriter?
    private var video: AVAssetWriterInput?
    private var audio: AVAssetWriterInput?
    private var pixels: AVAssetWriterInputPixelBufferAdaptor?
    private var latestFrame: CVPixelBuffer?
    private var frameTimer: DispatchSourceTimer?
    private var monitor: Timer?
    private var border: RecordingBorder?
    private var started = false
    private let stopLock = NSLock()
    private var stopFlag = false
    private var stopping: Bool {
        stopLock.lock(); defer { stopLock.unlock() }
        return stopFlag
    }
    private var terminalError: Error?
    private var firstPTS: CMTime?
    private var lastVideoPTS: CMTime?
    private var lastAudioPTS: CMTime?
    private var windowID: CGWindowID?
    private var displayID: CGDirectDisplayID?
    private var sourceBounds = CGRect.zero
    private var sourceScale = 1.0
    private var options: Options?
    private let parentPID = getppid()

    @MainActor func start(options: Options, output: URL) async throws {
        self.options = options
        // Screen access is requested only in response to an explicit start command.
        if !CGPreflightScreenCaptureAccess(), !CGRequestScreenCaptureAccess() {
            throw CaptureFailure("请在系统设置的屏幕录制权限中允许 Open Media，然后重新选择录制来源。")
        }
        let content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: true)
        try requireActive()
        let parts = options.sourceId.split(separator: ":", omittingEmptySubsequences: false)
        guard parts.count == 2, let identifier = UInt32(parts[1]) else { throw CaptureFailure("请选择有效的录制来源。") }
        var selectedWindow: SCWindow?
        var selectedDisplay: SCDisplay?
        if parts[0] == "window" {
            guard let window = content.windows.first(where: { $0.windowID == identifier && $0.isOnScreen && $0.windowLayer == 0 }) else {
                throw CaptureFailure("所选窗口已关闭或隐藏，请重新选择。")
            }
            selectedWindow = window
            windowID = identifier
            sourceBounds = window.frame
        } else if parts[0] == "screen" {
            guard let display = content.displays.first(where: { $0.displayID == identifier }) else {
                throw CaptureFailure("所选屏幕已断开，请重新选择。")
            }
            selectedDisplay = display
            displayID = identifier
            sourceBounds = display.frame
        } else { throw CaptureFailure("请选择有效的屏幕或窗口。") }
        sourceScale = screenScale(for: sourceBounds)
        let sourceSize = pixelSize(sourceBounds, scale: sourceScale)
        try options.validate(sourceWidth: sourceSize.0, sourceHeight: sourceSize.1, isWindow: selectedWindow != nil)
        if options.microphone { try await prepareMicrophone(options.audioDevice) }
        try requireActive()

        let writer = try AVAssetWriter(outputURL: output, fileType: .mp4)
        let video = AVAssetWriterInput(mediaType: .video, outputSettings: [
            AVVideoCodecKey: AVVideoCodecType.h264,
            AVVideoWidthKey: options.outputSize.width,
            AVVideoHeightKey: options.outputSize.height,
            AVVideoCompressionPropertiesKey: [
                AVVideoAverageBitRateKey: min(40_000_000, max(2_000_000, options.outputSize.width * options.outputSize.height * options.fps / 5)),
                AVVideoExpectedSourceFrameRateKey: options.fps,
                AVVideoMaxKeyFrameIntervalKey: options.fps * 2,
                AVVideoAllowFrameReorderingKey: false
            ]
        ])
        video.expectsMediaDataInRealTime = true
        guard writer.canAdd(video) else { throw CaptureFailure("无法为当前尺寸初始化视频编码。") }
        writer.add(video)
        self.writer = writer; self.video = video
        pixels = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: video, sourcePixelBufferAttributes: [
            kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
            kCVPixelBufferWidthKey as String: options.outputSize.width,
            kCVPixelBufferHeightKey as String: options.outputSize.height
        ])
        if options.microphone {
            let audio = AVAssetWriterInput(mediaType: .audio, outputSettings: [
                AVFormatIDKey: kAudioFormatMPEG4AAC,
                AVSampleRateKey: 48000,
                AVNumberOfChannelsKey: 2,
                AVEncoderBitRateKey: 128000
            ])
            audio.expectsMediaDataInRealTime = true
            guard writer.canAdd(audio) else { throw CaptureFailure("无法初始化麦克风音轨。") }
            writer.add(audio); self.audio = audio
        }
        guard writer.startWriting() else { throw writer.error ?? CaptureFailure("无法创建录制文件。") }

        let border = RecordingBorder()
        border.update(borderRect(source: sourceBounds, region: options.region, scale: sourceScale))
        self.border = border
        let filter: SCContentFilter
        if let window = selectedWindow {
            filter = SCContentFilter(desktopIndependentWindow: window)
        } else if let display = selectedDisplay {
            // Build the exclusion after the indicator exists so it never appears in recorded pixels.
            let updated = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
            try requireActive()
            let ownApplications = updated.applications.filter { $0.processID == getpid() }
            let ownWindows = updated.windows.filter { $0.owningApplication?.processID == getpid() || $0.windowID == CGWindowID(border.panel.windowNumber) }
            if !ownApplications.isEmpty {
                filter = SCContentFilter(display: display, excludingApplications: ownApplications, exceptingWindows: [])
            } else if !ownWindows.isEmpty {
                filter = SCContentFilter(display: display, excludingWindows: ownWindows)
            } else {
                throw CaptureFailure("无法排除录制指示框，请重新开始录制。")
            }
        } else { throw CaptureFailure("录制来源不可用。") }

        let configuration = SCStreamConfiguration()
        configuration.width = options.outputSize.width
        configuration.height = options.outputSize.height
        configuration.minimumFrameInterval = CMTime(value: 1, timescale: CMTimeScale(options.fps))
        configuration.queueDepth = 5
        configuration.pixelFormat = kCVPixelFormatType_32BGRA
        configuration.showsCursor = true
        configuration.scalesToFit = true
        configuration.backgroundColor = CGColor(gray: 0, alpha: 1)
        configuration.capturesAudio = false
        let captureSize: CGSize
        if let region = options.region {
            configuration.sourceRect = CGRect(x: Double(region.x) / sourceScale, y: Double(region.y) / sourceScale,
                                              width: Double(region.width) / sourceScale, height: Double(region.height) / sourceScale)
            captureSize = CGSize(width: region.width, height: region.height)
        } else { captureSize = sourceBounds.size }
        configuration.destinationRect = aspectFit(source: captureSize, output: options.outputSize)
        let stream = SCStream(filter: filter, configuration: configuration, delegate: self)
        try stream.addStreamOutput(self, type: .screen, sampleHandlerQueue: queue)
        self.stream = stream
        if let microphone = microphone {
            await withCheckedContinuation { continuation in
                DispatchQueue.global(qos: .userInitiated).async {
                    microphone.startRunning()
                    continuation.resume()
                }
            }
            guard microphone.isRunning else { throw CaptureFailure("麦克风未能开始采集，请检查设备和权限。") }
            microphoneClock = microphone.synchronizationClock
        }
        try requireActive()
        try await stream.startCapture()
        try requireActive()
        let timer = DispatchSource.makeTimerSource(queue: queue)
        timer.schedule(deadline: .now(), repeating: .nanoseconds(1_000_000_000 / options.fps))
        timer.setEventHandler { [weak self] in self?.appendVideoFrame() }
        frameTimer = timer; timer.resume()
        monitor = Timer.scheduledTimer(withTimeInterval: 0.2, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.checkSource() }
        }
    }

    private func requireActive() throws {
        if stopping { throw CaptureFailure("录制已取消。") }
    }

    @MainActor private func prepareMicrophone(_ deviceID: String?) async throws {
        if AVCaptureDevice.authorizationStatus(for: .audio) == .notDetermined {
            let allowed = await AVCaptureDevice.requestAccess(for: .audio)
            if !allowed { throw CaptureFailure("麦克风访问被拒绝，请允许访问或关闭麦克风录制。") }
        }
        guard AVCaptureDevice.authorizationStatus(for: .audio) == .authorized else {
            throw CaptureFailure("请在系统设置中允许麦克风访问，或关闭麦克风录制。")
        }
        let device = deviceID.flatMap { id in AVCaptureDevice.devices(for: .audio).first(where: { $0.uniqueID == id }) }
            ?? (deviceID == nil || deviceID?.isEmpty == true ? AVCaptureDevice.default(for: .audio) : nil)
        guard let device = device else { throw CaptureFailure("所选麦克风已断开，请重新选择。") }
        let session = AVCaptureSession()
        let input = try AVCaptureDeviceInput(device: device)
        let output = AVCaptureAudioDataOutput()
        output.setSampleBufferDelegate(self, queue: queue)
        guard session.canAddInput(input), session.canAddOutput(output) else { throw CaptureFailure("无法打开所选麦克风。") }
        session.addInput(input); session.addOutput(output)
        microphone = session
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .screen, CMSampleBufferIsValid(sampleBuffer), !stopping,
              let attachments = CMSampleBufferGetSampleAttachmentsArray(sampleBuffer, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
              let rawStatus = attachments.first?[.status] as? Int,
              SCFrameStatus(rawValue: rawStatus) == .complete,
              let buffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
        latestFrame = buffer
        if !started { appendVideoFrame() }
    }

    private func appendVideoFrame() {
        guard !stopping, let writer = writer, let video = video,
              let pixels = pixels, let buffer = latestFrame, video.isReadyForMoreMediaData else { return }
        guard writer.status == .writing else {
            reportFailure(writer.error ?? CaptureFailure("视频编码已停止。")); return
        }
        let now = CMClockGetTime(CMClockGetHostTimeClock())
        if let previous = lastVideoPTS, CMTimeCompare(now, previous) <= 0 { return }
        if !started {
            writer.startSession(atSourceTime: now)
            firstPTS = now
        }
        guard pixels.append(buffer, withPresentationTime: now) else {
            reportFailure(writer.error ?? CaptureFailure("无法写入录制画面。")); return
        }
        lastVideoPTS = now
        if !started {
            started = true
            FileHandle.standardOutput.write(Data("READY\n".utf8))
        }
    }

    func captureOutput(_ output: AVCaptureOutput, didOutput sampleBuffer: CMSampleBuffer, from connection: AVCaptureConnection) {
        guard !stopping, started, let audio = audio, let firstPTS = firstPTS,
              audio.isReadyForMoreMediaData, CMSampleBufferIsValid(sampleBuffer) else { return }
        let originalPTS = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
        let hostPTS = microphoneClock.map { CMSyncConvertTime(originalPTS, from: $0, to: CMClockGetHostTimeClock()) } ?? originalPTS
        guard hostPTS.isValid, CMTimeCompare(hostPTS, firstPTS) >= 0 else { return }
        if let last = lastAudioPTS, CMTimeCompare(hostPTS, last) <= 0 { return }
        do {
            let retimed = try retimeAudioSample(sampleBuffer, to: hostPTS)
            guard audio.append(retimed) else {
                reportFailure(writer?.error ?? CaptureFailure("无法写入麦克风音轨。")); return
            }
        } catch {
            reportFailure(error); return
        }
        lastAudioPTS = hostPTS
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) { reportFailure(error) }

    private func reportFailure(_ error: Error) {
        DispatchQueue.main.async { [weak self] in self?.stop(error: error) }
    }

    @MainActor private func checkSource() {
        guard !stopping else { return }
        if getppid() != parentPID { stop(error: CaptureFailure("录制主窗口已退出。")); return }
        if let id = windowID {
            guard let windows = CGWindowListCopyWindowInfo(.optionIncludingWindow, id) as? [[String: Any]],
                  let info = windows.first,
                  (info[kCGWindowIsOnscreen as String] as? Bool) == true,
                  let values = info[kCGWindowBounds as String] as? [String: Any],
                  let rect = CGRect(dictionaryRepresentation: values as CFDictionary), rect.width >= 1, rect.height >= 1 else {
                stop(error: CaptureFailure("所选窗口已关闭或隐藏，录制已暂停。")); return
            }
            guard rect.size == sourceBounds.size, screenScale(for: rect) == sourceScale else {
                stop(error: CaptureFailure("窗口尺寸或缩放已改变，录制已暂停；继续录制会使用新的窗口尺寸。")); return
            }
            border?.update(rect)
            sourceBounds = rect
        } else if let id = displayID {
            guard CGDisplayIsActive(id) != 0, let options = options else {
                stop(error: CaptureFailure("所选屏幕已断开，录制已暂停。")); return
            }
            let rect = CGDisplayBounds(id), scale = screenScale(for: rect)
            // Changing display geometry invalidates a pixel-based region. Preserve the completed segment.
            guard rect == sourceBounds, scale == sourceScale else {
                stop(error: CaptureFailure("屏幕尺寸或缩放已改变，请重新选择录制区域。")); return
            }
            border?.update(borderRect(source: rect, region: options.region, scale: scale))
        }
        if let microphone = microphone, !microphone.isRunning {
            stop(error: CaptureFailure("麦克风已断开，录制已暂停。"))
        }
    }

    @MainActor func stop(error: Error? = nil) {
        stopLock.lock()
        if stopFlag { stopLock.unlock(); return }
        stopFlag = true
        stopLock.unlock()
        terminalError = error
        border?.close(); border = nil
        monitor?.invalidate(); monitor = nil
        frameTimer?.cancel(); frameTimer = nil
        Task { @MainActor in
            if let stream = self.stream { try? await stream.stopCapture() }
            if let microphone = self.microphone {
                await withCheckedContinuation { continuation in
                    DispatchQueue.global(qos: .userInitiated).async {
                        microphone.stopRunning()
                        continuation.resume()
                    }
                }
            }
            self.queue.async {
                guard let writer = self.writer, self.started, writer.status == .writing else {
                    self.writer?.cancelWriting()
                    self.complete(error: self.terminalError ?? CaptureFailure("没有收到可录制画面。"))
                    return
                }
                writer.endSession(atSourceTime: CMClockGetTime(CMClockGetHostTimeClock()))
                self.video?.markAsFinished(); self.audio?.markAsFinished()
                writer.finishWriting {
                    self.complete(error: self.terminalError ?? (writer.status == .completed ? nil : writer.error ?? CaptureFailure("录制文件未能完成。")))
                }
            }
        }
    }

    private func complete(error: Error?) {
        if let error = error { writeError(error) }
        exit(error == nil ? 0 : 1)
    }
}

func runSelfTests() throws {
    let source = CGRect(x: -1920, y: -200, width: 1920, height: 1080)
    let region = Region(x: 200, y: 100, width: 800, height: 600)
    let result = borderRect(source: source, region: region, scale: 2)
    guard result == CGRect(x: -1820, y: -150, width: 400, height: 300),
          appKitRect(result, primaryTop: 1080) == CGRect(x: -1820, y: 930, width: 400, height: 300) else {
        throw CaptureFailure("录制区域坐标验证失败。")
    }
    let options = Options(sourceId: "screen:1", fps: 30, microphone: false, audioDevice: nil,
                          region: region, outputSize: OutputSize(width: 1280, height: 720))
    try options.validate(sourceWidth: 3840, sourceHeight: 2160, isWindow: false)
    var rejectedWindowRegion = false
    do { try options.validate(sourceWidth: 3840, sourceHeight: 2160, isWindow: true) }
    catch { rejectedWindowRegion = true }
    var rejectedOutsideRegion = false
    do { try options.validate(sourceWidth: 900, sourceHeight: 600, isWindow: false) }
    catch { rejectedOutsideRegion = true }
    let fit = aspectFit(source: CGSize(width: 800, height: 600), output: options.outputSize)
    guard rejectedWindowRegion, rejectedOutsideRegion,
          fit == CGRect(x: 160, y: 0, width: 960, height: 720),
          pixelSize(source, scale: 2).0 == 3840 else {
        throw CaptureFailure("录制参数验证失败。")
    }
    try verifyAudioTiming()
    try verifyVideoEncoding()
    print("Capture geometry, validation, audio timing, video encoding and decoded pixel checks passed.")
}

func verifyAudioTiming() throws {
    var format: CMAudioFormatDescription?
    var description = AudioStreamBasicDescription(mSampleRate: 48000, mFormatID: kAudioFormatLinearPCM,
        mFormatFlags: kAudioFormatFlagIsSignedInteger | kAudioFormatFlagIsPacked, mBytesPerPacket: 4,
        mFramesPerPacket: 1, mBytesPerFrame: 4, mChannelsPerFrame: 2, mBitsPerChannel: 16, mReserved: 0)
    guard CMAudioFormatDescriptionCreate(allocator: kCFAllocatorDefault, asbd: &description,
        layoutSize: 0, layout: nil, magicCookieSize: 0, magicCookie: nil, extensions: nil,
        formatDescriptionOut: &format) == noErr, let format = format else {
        throw CaptureFailure("音轨时间验证无法创建音频格式。")
    }
    var block: CMBlockBuffer?
    guard CMBlockBufferCreateWithMemoryBlock(allocator: kCFAllocatorDefault, memoryBlock: nil, blockLength: 4096,
        blockAllocator: kCFAllocatorDefault, customBlockSource: nil, offsetToData: 0, dataLength: 4096,
        flags: 0, blockBufferOut: &block) == kCMBlockBufferNoErr else {
        throw CaptureFailure("音轨时间验证无法创建音频数据。")
    }
    var timing = CMSampleTimingInfo(duration: CMTime(value: 1, timescale: 48000),
        presentationTimeStamp: CMTime(value: 10, timescale: 1), decodeTimeStamp: .invalid)
    var sampleSize = 4
    var sample: CMSampleBuffer?
    guard CMSampleBufferCreateReady(allocator: kCFAllocatorDefault, dataBuffer: block, formatDescription: format,
        sampleCount: 1024, sampleTimingEntryCount: 1, sampleTimingArray: &timing,
        sampleSizeEntryCount: 1, sampleSizeArray: &sampleSize, sampleBufferOut: &sample) == noErr,
        let sample = sample else { throw CaptureFailure("音轨时间验证无法创建音频帧。") }
    let destination = CMTime(value: 35, timescale: 1)
    let retimed = try retimeAudioSample(sample, to: destination)
    guard CMTimeCompare(CMSampleBufferGetDuration(retimed), CMTime(value: 1024, timescale: 48000)) == 0,
          CMTimeCompare(CMSampleBufferGetPresentationTimeStamp(retimed), destination) == 0,
          CMSampleBufferGetNumSamples(retimed) == 1024 else {
        throw CaptureFailure("音轨同步改变了音频帧的时长。")
    }
}

func verifyVideoEncoding() throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent("open-media-capture-check-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: directory) }
    let file = directory.appendingPathComponent("capture.mp4")
    let writer = try AVAssetWriter(outputURL: file, fileType: .mp4)
    let input = AVAssetWriterInput(mediaType: .video, outputSettings: [
        AVVideoCodecKey: AVVideoCodecType.h264, AVVideoWidthKey: 320, AVVideoHeightKey: 180
    ])
    let attributes: [String: Any] = [
        kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
        kCVPixelBufferWidthKey as String: 320, kCVPixelBufferHeightKey as String: 180,
        kCVPixelBufferCGImageCompatibilityKey as String: true,
        kCVPixelBufferCGBitmapContextCompatibilityKey as String: true
    ]
    let adapter = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: input, sourcePixelBufferAttributes: attributes)
    guard writer.canAdd(input) else { throw CaptureFailure("视频编码验证无法添加视频轨道。") }
    writer.add(input)
    guard writer.startWriting() else { throw writer.error ?? CaptureFailure("视频编码验证无法启动。") }
    writer.startSession(atSourceTime: .zero)
    var optionalBuffer: CVPixelBuffer?
    guard CVPixelBufferCreate(kCFAllocatorDefault, 320, 180, kCVPixelFormatType_32BGRA, attributes as CFDictionary, &optionalBuffer) == kCVReturnSuccess,
          let buffer = optionalBuffer else { throw CaptureFailure("视频编码验证无法创建画面。") }
    CVPixelBufferLockBaseAddress(buffer, [])
    let base = CVPixelBufferGetBaseAddress(buffer)!.assumingMemoryBound(to: UInt8.self)
    let stride = CVPixelBufferGetBytesPerRow(buffer)
    for y in 0..<180 {
        for x in 0..<320 {
            let offset = y * stride + x * 4
            base[offset] = 0; base[offset + 1] = 0; base[offset + 2] = 255; base[offset + 3] = 255
        }
    }
    CVPixelBufferUnlockBaseAddress(buffer, [])
    for frame in 0..<6 {
        let deadline = Date().addingTimeInterval(5)
        while !input.isReadyForMoreMediaData, writer.status == .writing, Date() < deadline { usleep(1000) }
        guard input.isReadyForMoreMediaData,
              adapter.append(buffer, withPresentationTime: CMTime(value: Int64(frame), timescale: 30)) else {
            throw writer.error ?? CaptureFailure("视频编码验证无法写入画面。")
        }
    }
    writer.endSession(atSourceTime: CMTime(value: 6, timescale: 30))
    input.markAsFinished()
    let finished = DispatchSemaphore(value: 0)
    writer.finishWriting { finished.signal() }
    guard finished.wait(timeout: .now() + 10) == .success, writer.status == .completed else {
        throw writer.error ?? CaptureFailure("视频编码验证无法完成文件。")
    }
    let asset = AVURLAsset(url: file)
    guard let track = asset.tracks(withMediaType: .video).first,
          track.naturalSize == CGSize(width: 320, height: 180), CMTimeGetSeconds(asset.duration) >= 0.19 else {
        throw CaptureFailure("视频编码验证得到错误的尺寸或时长。")
    }
    let generator = AVAssetImageGenerator(asset: asset)
    let image = try generator.copyCGImage(at: .zero, actualTime: nil)
    var rgba = [UInt8](repeating: 0, count: 4)
    let colorIsCorrect = rgba.withUnsafeMutableBytes { bytes -> Bool in
        guard let context = CGContext(data: bytes.baseAddress, width: 1, height: 1, bitsPerComponent: 8, bytesPerRow: 4,
                                      space: CGColorSpaceCreateDeviceRGB(),
                                      bitmapInfo: CGBitmapInfo.byteOrder32Big.rawValue | CGImageAlphaInfo.premultipliedLast.rawValue) else { return false }
        context.draw(image, in: CGRect(x: 0, y: 0, width: 1, height: 1))
        let pixel = bytes.bindMemory(to: UInt8.self)
        return pixel[0] > 180 && pixel[1] < 80 && pixel[2] < 80 && pixel[3] > 240
    }
    guard colorIsCorrect else { throw CaptureFailure("视频编码验证的实际解码颜色不正确。") }
}

let arguments = CommandLine.arguments
if arguments.count == 2, arguments[1] == "--self-test" {
    do { try runSelfTests(); exit(0) }
    catch { writeError(error); exit(1) }
}

let application = NSApplication.shared
application.setActivationPolicy(.accessory)
let recorder = Recorder()
var signals: [DispatchSourceSignal] = []
for number in [SIGINT, SIGTERM, SIGHUP] {
    signal(number, SIG_IGN)
    let source = DispatchSource.makeSignalSource(signal: number, queue: .main)
    source.setEventHandler { Task { @MainActor in recorder.stop() } }
    source.resume(); signals.append(source)
}

Task { @MainActor in
    do {
        if (arguments.count == 2 || (arguments.count == 3 && arguments[2] == "--request-permission")), arguments[1] == "sources" {
            try writeJSON(await listSources(requestPermission: arguments.count == 3)); exit(0)
        }
        guard arguments.count == 4, arguments[1] == "record" else {
            throw CaptureFailure("用法：sources 或 record <配置文件> <输出文件>。")
        }
        let config = try JSONDecoder().decode(Options.self, from: Data(contentsOf: URL(fileURLWithPath: arguments[2])))
        DispatchQueue.global(qos: .utility).async {
            while let line = readLine() {
                if line.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() == "q" { break }
            }
            DispatchQueue.main.async { recorder.stop() }
        }
        try await recorder.start(options: config, output: URL(fileURLWithPath: arguments[3]))
    } catch {
        recorder.stop(error: error)
    }
}
application.run()
