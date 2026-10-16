import AppKit
import AVFoundation
import CoreMedia
import CoreImage
import CoreVideo
import Darwin
import ScreenCaptureKit

// The app's main executable loads this module only in its recording mode.
// That process owns the recording devices and the visible recording border.
// Closing its input, terminating its parent, or receiving a stop signal releases them.
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

struct ScreenshotOptions: Decodable {
    let sourceId: String
    let region: Region?
    let sourceWidth: Int?
    let sourceHeight: Int?

    func validate(sourceWidth width: Int, sourceHeight height: Int, isWindow: Bool) throws {
        if let expected = sourceWidth, expected != width {
            throw CaptureFailure("截屏来源的尺寸已改变，请重新选择。")
        }
        if let expected = sourceHeight, expected != height {
            throw CaptureFailure("截屏来源的尺寸已改变，请重新选择。")
        }
        if let region = region {
            guard !isWindow, region.x >= 0, region.y >= 0,
                  region.width >= 16, region.height >= 16,
                  region.width <= width, region.height <= height,
                  region.x <= width - region.width, region.y <= height - region.height else {
                throw CaptureFailure("截屏区域超出了所选屏幕，请重新选择。")
            }
        }
        let outputWidth = region?.width ?? width, outputHeight = region?.height ?? height
        guard outputWidth > 0, outputHeight > 0,
              outputWidth <= 32768, outputHeight <= 32768,
              outputWidth * outputHeight <= 100_000_000 else {
            throw CaptureFailure("截屏范围过大，请选择较小的区域。")
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

func streamSize(source: CGSize, output: OutputSize) -> OutputSize {
    let rect = aspectFit(source: source, output: output)
    return OutputSize(width: max(2, Int(rect.width / 2) * 2), height: max(2, Int(rect.height / 2) * 2))
}

func makeRenderPool(size: OutputSize) throws -> CVPixelBufferPool {
    var pool: CVPixelBufferPool?
    let attributes: [String: Any] = [
        kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
        kCVPixelBufferWidthKey as String: size.width, kCVPixelBufferHeightKey as String: size.height,
        kCVPixelBufferIOSurfacePropertiesKey as String: [String: Any](),
        kCVPixelBufferCGImageCompatibilityKey as String: true,
        kCVPixelBufferCGBitmapContextCompatibilityKey as String: true
    ]
    guard CVPixelBufferPoolCreate(kCFAllocatorDefault, nil, attributes as CFDictionary, &pool) == kCVReturnSuccess,
          let pool = pool else { throw CaptureFailure("无法创建录制画面缓冲区。") }
    return pool
}

func letterboxedFrame(_ source: CVPixelBuffer, contentSize: CGSize? = nil, pool: CVPixelBufferPool, context: CIContext) throws -> CVPixelBuffer {
    var output: CVPixelBuffer?
    guard CVPixelBufferPoolCreatePixelBuffer(kCFAllocatorDefault, pool, &output) == kCVReturnSuccess,
          let output = output else { throw CaptureFailure("无法分配录制画面缓冲区。") }
    let outputSize = OutputSize(width: CVPixelBufferGetWidth(output), height: CVPixelBufferGetHeight(output))
    let sourceSize = CGSize(width: CVPixelBufferGetWidth(source), height: CVPixelBufferGetHeight(source))
    let placement = aspectFit(source: contentSize ?? sourceSize, output: outputSize)
    let surface = CGRect(x: 0, y: 0, width: outputSize.width, height: outputSize.height)
    let image = CIImage(cvPixelBuffer: source)
        .transformed(by: CGAffineTransform(scaleX: placement.width / sourceSize.width, y: placement.height / sourceSize.height))
        .transformed(by: CGAffineTransform(translationX: placement.minX, y: placement.minY))
    let background = CIImage(color: CIColor(red: 0, green: 0, blue: 0, alpha: 1)).cropped(to: surface)
    context.render(image.composited(over: background), to: output, bounds: surface, colorSpace: CGColorSpaceCreateDeviceRGB())
    return output
}

func appendFrame(_ buffer: CVPixelBuffer, writer: AVAssetWriter, input: AVAssetWriterInput,
                 adapter: AVAssetWriterInputPixelBufferAdaptor, at time: CMTime,
                 sessionStart: inout CMTime?) throws -> Bool {
    guard writer.status == .writing else {
        throw writer.error ?? CaptureFailure("视频编码已停止。")
    }
    // An input may remain not-ready until its writing session starts. Start
    // that session once, before applying input backpressure to the first frame.
    if sessionStart == nil {
        writer.startSession(atSourceTime: time)
        sessionStart = time
    }
    guard input.isReadyForMoreMediaData else { return false }
    guard adapter.append(buffer, withPresentationTime: time) else {
        throw writer.error ?? CaptureFailure("无法写入录制画面。")
    }
    return true
}

func writeJSON<T: Encodable>(_ value: T) throws {
    let data = try JSONEncoder().encode(value)
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data([10]))
}

func writeError(_ error: Error) {
    FileHandle.standardError.write(Data((captureError(error, during: "录制").localizedDescription + "\n").utf8))
}

func reportStage(_ name: String) {
    FileHandle.standardOutput.write(Data("STAGE \(name)\n".utf8))
}

func captureError(_ error: Error, during stage: String) -> CaptureFailure {
    if let failure = error as? CaptureFailure { return failure }
    let original = error as NSError
    var details = ["\(original.domain) \(original.code)：\(original.localizedDescription)"]
    if let underlying = original.userInfo[NSUnderlyingErrorKey] as? NSError {
        details.append("\(underlying.domain) \(underlying.code)：\(underlying.localizedDescription)")
    }
    let action: String
    if original.domain.contains("ScreenCaptureKit"), original.code == -3801 {
        action = "系统拒绝了当前 Open Media 安装副本的屏幕录制请求。请检查系统设置中的屏幕录制权限；若已授权但在升级或替换应用后仍失败，请完全退出应用，在权限列表中移除旧项目并重新添加“应用程序”里的当前 Open Media，再重新打开应用。"
    } else {
        action = "\(stage)失败。"
    }
    return CaptureFailure("\(action) 系统信息：\(details.joined(separator: "；"))")
}

@MainActor func shareableContent(excludingDesktop: Bool = true) async throws -> SCShareableContent {
    do {
        // A recording or source selection is an explicit user action. Let the
        // capture API decide access; legacy preflight results can be stale after
        // the user changes permission in System Settings.
        return try await SCShareableContent.excludingDesktopWindows(excludingDesktop, onScreenWindowsOnly: true)
    } catch { throw captureError(error, during: "读取屏幕和窗口") }
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
    var sources: [Source] = []
    for (index, screen) in NSScreen.screens.enumerated() {
        guard let number = screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber else { continue }
        let id = number.uint32Value, rect = CGDisplayBounds(id)
        let scale = Double(screen.backingScaleFactor)
        let size = pixelSize(rect, scale: scale)
        sources.append(Source(id: "screen:\(id)", name: "屏幕 \(index + 1) · \(screen.localizedName)", kind: "screen",
                              width: size.0, height: size.1, bounds: Bounds(rect), scaleFactor: scale))
    }
    // Passive device discovery never prompts. Explicit source selection uses
    // the capture API itself so a stale preflight result cannot hide windows.
    if requestPermission || CGPreflightScreenCaptureAccess() {
        let content = try await shareableContent()
        let ownPID = getpid(), parentPID = getppid()
        let windowInfo = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
        var order: [CGWindowID: Int] = [:]
        for (position, info) in windowInfo.enumerated() {
            if let identifier = info[kCGWindowNumber as String] as? NSNumber { order[identifier.uint32Value] = position }
        }
        let windows = content.windows.sorted {
            let first = order[$0.windowID] ?? Int.max, second = order[$1.windowID] ?? Int.max
            return first == second ? $0.windowID < $1.windowID : first < second
        }
        for window in windows {
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

final class ScreenshotCapture: NSObject, SCStreamDelegate, SCStreamOutput {
    private let queue = DispatchQueue(label: "open-media.screenshot")
    private var stream: SCStream?
    private var monitor: Timer?
    private var output: URL?
    private var firstFrame: CVPixelBuffer?
    private var started = false
    private var finishing = false
    private let parentPID = getppid()

    @MainActor func start(options: ScreenshotOptions, output: URL) async throws {
        self.output = output
        let deadline = Date().addingTimeInterval(20)
        monitor = Timer.scheduledTimer(withTimeInterval: 0.25, repeats: true) { [weak self] _ in
            Task { @MainActor in
                guard let self = self else { return }
                if getppid() != self.parentPID {
                    self.finish(error: CaptureFailure("截屏已取消。"))
                } else if Date() >= deadline {
                    self.finish(error: CaptureFailure("未能及时获取截屏画面，请检查来源和屏幕录制权限。"))
                }
            }
        }
        let content = try await shareableContent()
        guard !finishing else { throw CaptureFailure("截屏已取消。") }
        let parts = options.sourceId.split(separator: ":", omittingEmptySubsequences: false)
        guard parts.count == 2, let identifier = UInt32(parts[1]) else {
            throw CaptureFailure("请选择有效的截屏来源。")
        }
        let filter: SCContentFilter
        let bounds: CGRect
        let isWindow: Bool
        if parts[0] == "window" {
            guard let window = content.windows.first(where: {
                $0.windowID == identifier && $0.isOnScreen && $0.windowLayer == 0
            }) else { throw CaptureFailure("所选窗口已关闭或隐藏，请重新选择。") }
            filter = SCContentFilter(desktopIndependentWindow: window)
            bounds = window.frame
            isWindow = true
        } else if parts[0] == "screen" {
            guard let display = content.displays.first(where: { $0.displayID == identifier }) else {
                throw CaptureFailure("所选屏幕已断开，请重新选择。")
            }
            // Picker windows are closed before this request. The screenshot
            // intentionally includes all remaining windows in the selected area.
            filter = SCContentFilter(display: display, excludingWindows: [])
            bounds = display.frame
            isWindow = false
        } else { throw CaptureFailure("请选择有效的屏幕或窗口。") }
        let scale = screenScale(for: bounds)
        let size = pixelSize(bounds, scale: scale)
        try options.validate(sourceWidth: size.0, sourceHeight: size.1, isWindow: isWindow)
        let configuration = SCStreamConfiguration()
        configuration.width = options.region?.width ?? size.0
        configuration.height = options.region?.height ?? size.1
        configuration.minimumFrameInterval = CMTime(value: 1, timescale: 30)
        configuration.queueDepth = 3
        configuration.pixelFormat = kCVPixelFormatType_32BGRA
        configuration.showsCursor = false
        configuration.capturesAudio = false
        configuration.scalesToFit = true
        if #available(macOS 14.0, *) { configuration.ignoreShadowsSingleWindow = true }
        if let region = options.region {
            // The selector reports physical pixels; sourceRect uses display points.
            configuration.sourceRect = CGRect(x: Double(region.x) / scale, y: Double(region.y) / scale,
                                              width: Double(region.width) / scale, height: Double(region.height) / scale)
        }
        let stream = SCStream(filter: filter, configuration: configuration, delegate: self)
        try stream.addStreamOutput(self, type: .screen, sampleHandlerQueue: queue)
        self.stream = stream
        do { try await stream.startCapture() }
        catch { throw captureError(error, during: "截屏") }
        guard !finishing else { return }
        started = true
        if firstFrame != nil { finish(error: nil) }
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .screen, CMSampleBufferIsValid(sampleBuffer),
              let attachments = CMSampleBufferGetSampleAttachmentsArray(sampleBuffer, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
              let status = attachments.first?[.status] as? Int,
              status == SCFrameStatus.complete.rawValue,
              let frame = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
        Task { @MainActor in
            guard !self.finishing, self.firstFrame == nil else { return }
            self.firstFrame = frame
            if self.started { self.finish(error: nil) }
        }
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        Task { @MainActor in self.finish(error: captureError(error, during: "截屏")) }
    }

    @MainActor func cancel() { finish(error: CaptureFailure("截屏已取消。")) }

    @MainActor func finish(error: Error?) {
        guard !finishing else { return }
        finishing = true
        monitor?.invalidate(); monitor = nil
        Task { @MainActor in
            if let stream = self.stream { try? await stream.stopCapture() }
            self.stream = nil
            do {
                if let error = error { throw error }
                guard let frame = self.firstFrame, let output = self.output else {
                    throw CaptureFailure("截屏尚未获取到有效画面。")
                }
                let context = CIContext(options: [.cacheIntermediates: false])
                let image = CIImage(cvPixelBuffer: frame)
                guard let cgImage = context.createCGImage(image, from: image.extent),
                      let png = NSBitmapImageRep(cgImage: cgImage).representation(using: .png, properties: [:]) else {
                    throw CaptureFailure("无法生成截屏图片。")
                }
                try png.write(to: output, options: .atomic)
                self.firstFrame = nil
                exit(0)
            } catch {
                self.firstFrame = nil
                writeError(captureError(error, during: "截屏"))
                exit(1)
            }
        }
    }
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
    private var renderPool: CVPixelBufferPool?
    private var captureContentSize: CGSize?
    private let renderContext = CIContext(options: [.cacheIntermediates: false])
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
        reportStage("sources")
        let content = try await shareableContent()
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
        if options.microphone {
            reportStage("microphone")
            try await prepareMicrophone(options.audioDevice)
        }
        try requireActive()

        reportStage("encoder")
        let writer: AVAssetWriter
        do { writer = try AVAssetWriter(outputURL: output, fileType: .mp4) }
        catch { throw captureError(error, during: "创建录制文件") }
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
        renderPool = try makeRenderPool(size: options.outputSize)
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
        guard writer.startWriting() else {
            throw captureError(writer.error ?? CaptureFailure("无法创建录制文件。"), during: "初始化视频编码")
        }

        reportStage("indicator")
        let border = RecordingBorder()
        border.update(borderRect(source: sourceBounds, region: options.region, scale: sourceScale))
        self.border = border
        let filter: SCContentFilter
        if let window = selectedWindow {
            filter = SCContentFilter(desktopIndependentWindow: window)
        } else if let display = selectedDisplay {
            // Build the exclusion after the indicator exists so it never appears in recorded pixels.
            filter = try await displayFilter(display, excluding: border)
        } else { throw CaptureFailure("录制来源不可用。") }

        let configuration = SCStreamConfiguration()
        configuration.minimumFrameInterval = CMTime(value: 1, timescale: CMTimeScale(options.fps))
        configuration.queueDepth = 5
        configuration.pixelFormat = kCVPixelFormatType_32BGRA
        configuration.showsCursor = true
        configuration.scalesToFit = true
        configuration.backgroundColor = CGColor(gray: 0, alpha: 1)
        configuration.capturesAudio = false
        if #available(macOS 14.0, *) { configuration.ignoreShadowsSingleWindow = true }
        let captureSize: CGSize
        if let region = options.region {
            configuration.sourceRect = CGRect(x: Double(region.x) / sourceScale, y: Double(region.y) / sourceScale,
                                              width: Double(region.width) / sourceScale, height: Double(region.height) / sourceScale)
            captureSize = CGSize(width: region.width, height: region.height)
        } else { captureSize = sourceBounds.size }
        // An independent window ignores destinationRect. Request a stream surface
        // with the source aspect ratio, then add padding exactly once ourselves.
        let contentSize = streamSize(source: captureSize, output: options.outputSize)
        captureContentSize = captureSize
        configuration.width = contentSize.width
        configuration.height = contentSize.height
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
        reportStage("stream")
        do { try await stream.startCapture() }
        catch { throw captureError(error, during: "启动屏幕采集") }
        try requireActive()
        reportStage("frame")
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

    @MainActor private func displayFilter(_ display: SCDisplay, excluding border: RecordingBorder) async throws -> SCContentFilter {
        // Showing a window and publishing it to the capture service are separate
        // operations. Retry discovery rather than failing a valid first start.
        let deadline = Date().addingTimeInterval(3)
        repeat {
            try requireActive()
            let updated = try await shareableContent(excludingDesktop: false)
            try requireActive()
            let ownApplications = updated.applications.filter { $0.processID == getpid() }
            if !ownApplications.isEmpty {
                return SCContentFilter(display: display, excludingApplications: ownApplications, exceptingWindows: [])
            }
            let ownWindows = updated.windows.filter {
                $0.owningApplication?.processID == getpid() || $0.windowID == CGWindowID(border.panel.windowNumber)
            }
            if !ownWindows.isEmpty { return SCContentFilter(display: display, excludingWindows: ownWindows) }
            try await Task.sleep(nanoseconds: 100_000_000)
        } while Date() < deadline
        throw CaptureFailure("系统尚未登记录制指示框，未开始采集画面。请重新选择录制范围。")
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
              let buffer = CMSampleBufferGetImageBuffer(sampleBuffer), let renderPool = renderPool else { return }
        do { latestFrame = try letterboxedFrame(buffer, contentSize: captureContentSize, pool: renderPool, context: renderContext) }
        catch { reportFailure(error); return }
        if !started { appendVideoFrame() }
    }

    private func appendVideoFrame() {
        guard !stopping, let writer = writer, let video = video,
              let pixels = pixels, let buffer = latestFrame else { return }
        let now = CMClockGetTime(CMClockGetHostTimeClock())
        if let previous = lastVideoPTS, CMTimeCompare(now, previous) <= 0 { return }
        do {
            guard try appendFrame(buffer, writer: writer, input: video, adapter: pixels,
                                  at: now, sessionStart: &firstPTS) else { return }
        } catch { reportFailure(captureError(error, during: "写入录制画面")); return }
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

    func stream(_ stream: SCStream, didStopWithError error: Error) { reportFailure(captureError(error, during: "屏幕采集")) }

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

func verifyApplicationIdentity() throws {
    let bundle = Bundle.main
    let bundleURL = bundle.bundleURL.standardizedFileURL.resolvingSymlinksInPath()
    let executableURL = bundle.executableURL?.standardizedFileURL.resolvingSymlinksInPath()
    var executableApplication: URL?
    if let executableURL = executableURL {
        var directory = executableURL.deletingLastPathComponent()
        while directory.path != "/" {
            if directory.pathExtension.lowercased() == "app" {
                executableApplication = directory
                break
            }
            let parent = directory.deletingLastPathComponent()
            if parent.path == directory.path { break }
            directory = parent
        }
    }
    let isApplicationBundle = bundleURL.pathExtension.lowercased() == "app"
    let isPackaged = isApplicationBundle || executableApplication != nil
    try writeJSON([
        "captureApplicationIdentifier": bundle.bundleIdentifier ?? "",
        "captureBundlePath": bundleURL.path,
        "captureExecutablePath": executableURL?.path ?? "",
        "captureIdentityMode": isPackaged ? "packaged" : "development"
    ])
    if isPackaged {
        guard bundle.bundleIdentifier == "com.ecojust.openmedia" else {
            throw CaptureFailure("录制模式身份验证失败：主应用标识应为 com.ecojust.openmedia，实际为 \(bundle.bundleIdentifier ?? "空")。")
        }
        guard isApplicationBundle, let executableApplication = executableApplication,
              bundleURL.path == executableApplication.path else {
            throw CaptureFailure("录制模式身份验证失败：主应用包与可执行程序所在的应用包不一致。")
        }
    }
}

func runSelfTests() throws {
    try verifyApplicationIdentity()
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
    try verifyVideoEncoding(sourceSize: OutputSize(width: 120, height: 240), outputSize: OutputSize(width: 320, height: 180))
    try verifyVideoEncoding(sourceSize: OutputSize(width: 240, height: 120), outputSize: OutputSize(width: 180, height: 320))
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

func verifyVideoEncoding(sourceSize: OutputSize, outputSize: OutputSize) throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent("open-media-capture-check-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: directory) }
    let file = directory.appendingPathComponent("capture.mp4")
    let writer = try AVAssetWriter(outputURL: file, fileType: .mp4)
    let input = AVAssetWriterInput(mediaType: .video, outputSettings: [
        AVVideoCodecKey: AVVideoCodecType.h264, AVVideoWidthKey: outputSize.width, AVVideoHeightKey: outputSize.height
    ])
    let attributes: [String: Any] = [
        kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
        kCVPixelBufferWidthKey as String: outputSize.width, kCVPixelBufferHeightKey as String: outputSize.height,
        kCVPixelBufferCGImageCompatibilityKey as String: true,
        kCVPixelBufferCGBitmapContextCompatibilityKey as String: true
    ]
    let adapter = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: input, sourcePixelBufferAttributes: attributes)
    guard writer.canAdd(input) else { throw CaptureFailure("视频编码验证无法添加视频轨道。") }
    writer.add(input)
    guard writer.startWriting() else { throw writer.error ?? CaptureFailure("视频编码验证无法启动。") }
    var sessionStart: CMTime?
    var optionalBuffer: CVPixelBuffer?
    guard CVPixelBufferCreate(kCFAllocatorDefault, sourceSize.width, sourceSize.height, kCVPixelFormatType_32BGRA, nil, &optionalBuffer) == kCVReturnSuccess,
          let buffer = optionalBuffer else { throw CaptureFailure("视频编码验证无法创建画面。") }
    CVPixelBufferLockBaseAddress(buffer, [])
    let base = CVPixelBufferGetBaseAddress(buffer)!.assumingMemoryBound(to: UInt8.self)
    let stride = CVPixelBufferGetBytesPerRow(buffer)
    for y in 0..<sourceSize.height {
        for x in 0..<sourceSize.width {
            let offset = y * stride + x * 4
            base[offset] = 0; base[offset + 1] = 0; base[offset + 2] = 255; base[offset + 3] = 255
        }
    }
    CVPixelBufferUnlockBaseAddress(buffer, [])
    let pool = try makeRenderPool(size: outputSize)
    let frame = try letterboxedFrame(buffer, pool: pool, context: CIContext(options: [.useSoftwareRenderer: true]))
    for frameIndex in 0..<6 {
        let deadline = Date().addingTimeInterval(5)
        var appended = false
        repeat {
            appended = try appendFrame(frame, writer: writer, input: input, adapter: adapter,
                                       at: CMTime(value: Int64(frameIndex), timescale: 30), sessionStart: &sessionStart)
            if !appended { usleep(1000) }
        } while !appended && Date() < deadline
        guard appended else {
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
    var rejectedFinishedWriter = false
    do {
        _ = try appendFrame(frame, writer: writer, input: input, adapter: adapter,
                            at: CMTime(value: 6, timescale: 30), sessionStart: &sessionStart)
    } catch { rejectedFinishedWriter = true }
    guard rejectedFinishedWriter, let start = sessionStart, CMTimeCompare(start, .zero) == 0 else {
        throw CaptureFailure("编码器状态验证失败：结束的编码器必须报告错误，写入起点必须保持不变。")
    }
    let asset = AVURLAsset(url: file)
    guard let track = asset.tracks(withMediaType: .video).first,
          track.naturalSize == CGSize(width: outputSize.width, height: outputSize.height), CMTimeGetSeconds(asset.duration) >= 0.19 else {
        throw CaptureFailure("视频编码验证得到错误的尺寸或时长。")
    }
    let generator = AVAssetImageGenerator(asset: asset)
    let image = try generator.copyCGImage(at: .zero, actualTime: nil)
    var rgba = [UInt8](repeating: 0, count: outputSize.width * outputSize.height * 4)
    let colorIsCorrect = rgba.withUnsafeMutableBytes { bytes -> Bool in
        guard let context = CGContext(data: bytes.baseAddress, width: outputSize.width, height: outputSize.height, bitsPerComponent: 8, bytesPerRow: outputSize.width * 4,
                                      space: CGColorSpaceCreateDeviceRGB(),
                                      bitmapInfo: CGBitmapInfo.byteOrder32Big.rawValue | CGImageAlphaInfo.premultipliedLast.rawValue) else { return false }
        context.draw(image, in: CGRect(x: 0, y: 0, width: outputSize.width, height: outputSize.height))
        let pixel = bytes.bindMemory(to: UInt8.self)
        func isRed(_ x: Int, _ y: Int) -> Bool {
            let at = (y * outputSize.width + x) * 4
            return pixel[at] > 180 && pixel[at + 1] < 80 && pixel[at + 2] < 80 && pixel[at + 3] > 240
        }
        func isBlack(_ x: Int, _ y: Int) -> Bool {
            let at = (y * outputSize.width + x) * 4
            return pixel[at] < 35 && pixel[at + 1] < 35 && pixel[at + 2] < 35 && pixel[at + 3] > 240
        }
        if sourceSize.width < sourceSize.height {
            return isRed(160, 90) && isRed(120, 90) && isRed(160, 10) && isRed(160, 170)
                && isBlack(10, 90) && isBlack(110, 90) && isBlack(210, 90) && isBlack(310, 90)
        }
        return isRed(90, 160) && isRed(90, 120) && isRed(10, 160) && isRed(170, 160)
            && isBlack(90, 10) && isBlack(90, 110) && isBlack(90, 210) && isBlack(90, 310)
    }
    guard colorIsCorrect else { throw CaptureFailure("视频编码验证的实际解码颜色不正确。") }
}

@_cdecl("open_media_capture_main")
@MainActor
public func openMediaCaptureMain() -> Int32 {
    var modeArguments = CommandLine.arguments
    guard modeArguments.count > 1, modeArguments[1] == "--open-media-capture" else {
        writeError(CaptureFailure("录制模块只能通过应用的录制模式启动。"))
        return 1
    }
    guard Thread.isMainThread else {
        writeError(CaptureFailure("录制模式必须从进程主线程启动。"))
        return 1
    }
    modeArguments.remove(at: 1)
    let arguments = modeArguments
    if arguments.count == 2, arguments[1] == "--self-test" {
        do { try runSelfTests(); return 0 }
        catch { writeError(error); return 1 }
    }

    let application = NSApplication.shared
    application.setActivationPolicy(.accessory)
    let recorder = Recorder()
    let screenshot = ScreenshotCapture()
    let screenshotMode = arguments.count > 1 && arguments[1] == "screenshot"
    var signals: [DispatchSourceSignal] = []
    for number in [SIGINT, SIGTERM, SIGHUP] {
        signal(number, SIG_IGN)
        let source = DispatchSource.makeSignalSource(signal: number, queue: .main)
        source.setEventHandler { Task { @MainActor in
            if screenshotMode { screenshot.cancel() } else { recorder.stop() }
        } }
        source.resume(); signals.append(source)
    }

    Task { @MainActor in
        do {
            if (arguments.count == 2 || (arguments.count == 3 && arguments[2] == "--request-permission")), arguments[1] == "sources" {
                try writeJSON(await listSources(requestPermission: arguments.count == 3)); exit(0)
            }
            guard arguments.count == 4, arguments[1] == "record" || screenshotMode else {
                throw CaptureFailure("用法：sources、record <配置文件> <输出文件> 或 screenshot <配置文件> <输出文件>。")
            }
            DispatchQueue.global(qos: .utility).async {
                while let line = readLine() {
                    if line.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() == "q" { break }
                }
                DispatchQueue.main.async {
                    if screenshotMode { screenshot.cancel() } else { recorder.stop() }
                }
            }
            let data = try Data(contentsOf: URL(fileURLWithPath: arguments[2]))
            if screenshotMode {
                let config = try JSONDecoder().decode(ScreenshotOptions.self, from: data)
                try await screenshot.start(options: config, output: URL(fileURLWithPath: arguments[3]))
            } else {
                let config = try JSONDecoder().decode(Options.self, from: data)
                try await recorder.start(options: config, output: URL(fileURLWithPath: arguments[3]))
            }
        } catch {
            if screenshotMode { screenshot.finish(error: error) } else { recorder.stop(error: error) }
        }
    }
    withExtendedLifetime((recorder, screenshot, signals)) { application.run() }
    return 0
}
