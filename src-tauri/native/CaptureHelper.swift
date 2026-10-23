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
    var muted: Bool? = nil
    var zoomStatePath: String? = nil

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

// Coordinates are normalized to the original selection, with a top-left origin.
// Keeping this independent of screen pixels preserves the source aspect ratio
// and lets the red border and encoded crop use exactly the same viewport.
struct CaptureZoom {
    private(set) var viewport = CGRect(x: 0, y: 0, width: 1, height: 1)

    mutating func restore(_ bounds: Bounds) -> Bool {
        guard [bounds.x, bounds.y, bounds.width, bounds.height].allSatisfy({ $0.isFinite }),
              bounds.width >= 0.125, bounds.width <= 1, abs(bounds.width - bounds.height) < 0.000001,
              bounds.x >= 0, bounds.y >= 0,
              bounds.x + bounds.width <= 1.000001, bounds.y + bounds.height <= 1.000001 else { return false }
        viewport = CGRect(x: min(bounds.x, 1 - bounds.width), y: min(bounds.y, 1 - bounds.width),
                          width: bounds.width, height: bounds.width)
        return true
    }

    mutating func scroll(at point: CGPoint, in original: CGRect, steps: Double) -> Bool {
        guard original.width > 0, original.height > 0, original.contains(point),
              steps.isFinite, steps != 0 else { return false }
        let scale = exp(-min(8, max(-8, steps)) * log(1.15))
        let size = min(1, max(0.125, viewport.width * scale))
        let ratio = size / viewport.width
        let anchor = CGPoint(x: min(viewport.maxX, max(viewport.minX, (point.x - original.minX) / original.width)),
                             y: min(viewport.maxY, max(viewport.minY, (point.y - original.minY) / original.height)))
        let next = CGRect(x: min(1 - size, max(0, anchor.x - (anchor.x - viewport.minX) * ratio)),
                          y: min(1 - size, max(0, anchor.y - (anchor.y - viewport.minY) * ratio)),
                          width: size, height: size)
        guard next != viewport else { return false }
        viewport = next
        return true
    }

    func bounds(in original: CGRect) -> CGRect {
        CGRect(x: original.minX + viewport.minX * original.width,
               y: original.minY + viewport.minY * original.height,
               width: viewport.width * original.width, height: viewport.height * original.height)
    }
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

func recordingStreamConfiguration(fps: Int) -> SCStreamConfiguration {
    let configuration = SCStreamConfiguration()
    configuration.minimumFrameInterval = CMTime(value: 1, timescale: CMTimeScale(fps))
    configuration.queueDepth = 5
    configuration.pixelFormat = kCVPixelFormatType_32BGRA
    configuration.showsCursor = true
    configuration.scalesToFit = true
    configuration.capturesAudio = false
    // Frame composition supplies the black padding. Leave the system's color
    // untouched so copying this configuration never depends on a temporary CGColor.
    if #available(macOS 14.0, *) { configuration.ignoreShadowsSingleWindow = true }
    return configuration
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

func letterboxedFrame(_ source: CVPixelBuffer, contentSize: CGSize? = nil,
                      viewport: CGRect = CGRect(x: 0, y: 0, width: 1, height: 1),
                      pool: CVPixelBufferPool, context: CIContext) throws -> CVPixelBuffer {
    var output: CVPixelBuffer?
    guard CVPixelBufferPoolCreatePixelBuffer(kCFAllocatorDefault, pool, &output) == kCVReturnSuccess,
          let output = output else { throw CaptureFailure("无法分配录制画面缓冲区。") }
    let outputSize = OutputSize(width: CVPixelBufferGetWidth(output), height: CVPixelBufferGetHeight(output))
    let sourceSize = CGSize(width: CVPixelBufferGetWidth(source), height: CVPixelBufferGetHeight(source))
    let placement = aspectFit(source: contentSize ?? sourceSize, output: outputSize)
    let surface = CGRect(x: 0, y: 0, width: outputSize.width, height: outputSize.height)
    // Image coordinates start at the bottom left; capture coordinates start at
    // the top left. Crop before scaling so pixels outside the frame cannot leak.
    let crop = CGRect(x: viewport.minX * sourceSize.width,
                      y: (1 - viewport.maxY) * sourceSize.height,
                      width: viewport.width * sourceSize.width, height: viewport.height * sourceSize.height)
    let image = CIImage(cvPixelBuffer: source)
        .cropped(to: crop)
        .transformed(by: CGAffineTransform(translationX: -crop.minX, y: -crop.minY))
        .transformed(by: CGAffineTransform(scaleX: placement.width / crop.width, y: placement.height / crop.height))
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

@MainActor func shareableContent(excludingDesktop: Bool = true, onScreenOnly: Bool = true) async throws -> SCShareableContent {
    do {
        // A recording or source selection is an explicit user action. Let the
        // capture API decide access; legacy preflight results can be stale after
        // the user changes permission in System Settings.
        return try await SCShareableContent.excludingDesktopWindows(excludingDesktop, onScreenWindowsOnly: onScreenOnly)
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

func silentAudioSample(_ sample: CMSampleBuffer) throws -> CMSampleBuffer {
    guard let format = CMSampleBufferGetFormatDescription(sample),
          let description = CMAudioFormatDescriptionGetStreamBasicDescription(format),
          description.pointee.mFormatID == kAudioFormatLinearPCM,
          description.pointee.mFormatFlags & (kAudioFormatFlagIsSignedInteger | kAudioFormatFlagIsFloat) != 0,
          let original = CMSampleBufferGetDataBuffer(sample) else {
        throw CaptureFailure("无法将当前麦克风格式静音，录制已暂停。")
    }
    let length = CMBlockBufferGetDataLength(original)
    var block: CMBlockBuffer?
    guard length > 0, CMBlockBufferCreateWithMemoryBlock(allocator: kCFAllocatorDefault,
        memoryBlock: nil, blockLength: length, blockAllocator: kCFAllocatorDefault,
        customBlockSource: nil, offsetToData: 0, dataLength: length, flags: 0,
        blockBufferOut: &block) == kCMBlockBufferNoErr, let block = block,
        CMBlockBufferFillDataBytes(with: 0, blockBuffer: block, offsetIntoDestination: 0,
                                  dataLength: length) == kCMBlockBufferNoErr else {
        throw CaptureFailure("无法创建静音样本，录制已暂停。")
    }
    // PCM frames share their format, size and per-sample timing. Allocate a new
    // data block so the capture provider's original buffer is never modified.
    var timing = CMSampleTimingInfo()
    guard CMSampleBufferGetSampleTimingInfo(sample, at: 0, timingInfoOut: &timing) == noErr else {
        throw CaptureFailure("无法保留静音样本时间信息。")
    }
    var sampleSize = CMSampleBufferGetSampleSize(sample, at: 0)
    var copy: CMSampleBuffer?
    guard CMSampleBufferCreateReady(allocator: kCFAllocatorDefault, dataBuffer: block,
        formatDescription: format, sampleCount: CMSampleBufferGetNumSamples(sample),
        sampleTimingEntryCount: 1, sampleTimingArray: &timing,
        sampleSizeEntryCount: sampleSize > 0 ? 1 : 0, sampleSizeArray: &sampleSize,
        sampleBufferOut: &copy) == noErr, let copy = copy else {
        throw CaptureFailure("无法写入静音样本。")
    }
    return copy
}

@_cdecl("open_media_capture_window_bounds")
public func openMediaCaptureWindowBounds(_ windowID: UInt32, _ x: UnsafeMutablePointer<Double>,
    _ y: UnsafeMutablePointer<Double>, _ width: UnsafeMutablePointer<Double>,
    _ height: UnsafeMutablePointer<Double>) -> Int32 {
    guard let windows = CGWindowListCopyWindowInfo(.optionIncludingWindow, windowID) as? [[String: Any]],
          let info = windows.first, (info[kCGWindowIsOnscreen as String] as? Bool) == true,
          let values = info[kCGWindowBounds as String] as? [String: Any],
          let rect = CGRect(dictionaryRepresentation: values as CFDictionary),
          rect.width >= 1, rect.height >= 1 else { return 0 }
    x.pointee = rect.minX; y.pointee = rect.minY
    width.pointee = rect.width; height.pointee = rect.height
    return 1
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
    let microphones = AVCaptureDevice.devices(for: .audio)
    let defaultMicrophoneID = AVCaptureDevice.default(for: .audio)?.uniqueID
    // The first device is the default choice when no explicit input was selected.
    let orderedMicrophones = microphones.filter { $0.uniqueID == defaultMicrophoneID }
        + microphones.filter { $0.uniqueID != defaultMicrophoneID }
    for device in orderedMicrophones {
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
    private var latestSourceFrame: CVPixelBuffer?
    private var latestFrame: CVPixelBuffer?
    private let viewportLock = NSLock()
    private var requestedViewport = CGRect(x: 0, y: 0, width: 1, height: 1)
    private var renderedViewport = CGRect(x: 0, y: 0, width: 1, height: 1)
    private var zoom = CaptureZoom()
    private var globalScrollMonitor: Any?
    private var localScrollMonitor: Any?
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
    private var smokeTestOutput: URL?
    private var smokeTestExpectedBorder = false
    private var smokeTestBorderWasVisible = false
    private var smokeTestBorderClosed = false
    private var smokeTestDeadline: DispatchWorkItem?
    private var smokeTestHardDeadline: DispatchWorkItem?
    private var receivedScreenFrames = 0
    private var encodedFrames = 0
    // Read and written only on the same serial queue as microphone samples.
    private var muted = false

    func setMuted(_ value: Bool) {
        queue.async { [weak self] in
            guard let self = self, !self.stopping else { return }
            self.muted = value
        }
    }

    // This path is available only through an explicit command-line request. It
    // uses the normal recorder and real screen samples, never generated frames.
    @MainActor func startSmokeTest(output: URL, showsBorder: Bool) async throws {
        guard output.pathExtension.lowercased() == "mp4",
              !FileManager.default.fileExists(atPath: output.path) else {
            throw CaptureFailure("真实录屏检查需要一个尚不存在的 MP4 输出文件。")
        }
        smokeTestOutput = output
        smokeTestExpectedBorder = showsBorder
        let deadline = DispatchWorkItem { [weak self] in
            Task { @MainActor in
                self?.stop(error: CaptureFailure("真实录屏检查在 25 秒内未完成；当前桌面会话可能未授权屏幕采集。未将此检查视为成功。"))
            }
        }
        smokeTestDeadline = deadline
        DispatchQueue.main.asyncAfter(deadline: .now() + 25, execute: deadline)
        let hardDeadline = DispatchWorkItem {
            writeError(CaptureFailure("真实录屏检查超过 30 秒，采集进程已退出。"))
            exit(1)
        }
        smokeTestHardDeadline = hardDeadline
        DispatchQueue.global(qos: .userInitiated).asyncAfter(deadline: .now() + 30, execute: hardDeadline)
        try verifyApplicationIdentity()
        #if arch(arm64)
        let architecture = "arm64"
        #elseif arch(x86_64)
        let architecture = "x86_64"
        #else
        let architecture = "unknown"
        #endif
        try writeJSON([
            "captureSmokeTest": "starting",
            "operatingSystem": ProcessInfo.processInfo.operatingSystemVersionString,
            "architecture": architecture,
            "processID": String(getpid()),
            "parentProcessID": String(getppid()),
            "screenCapturePreflight": String(CGPreflightScreenCaptureAccess()),
            "recordingBorder": String(showsBorder),
            "microphone": "false",
            "outputPath": output.path
        ])
        reportStage("sources")
        let content = try await shareableContent()
        try requireActive()
        guard let display = content.displays.first(where: { $0.displayID == CGMainDisplayID() }) ?? content.displays.first else {
            throw CaptureFailure("当前会话没有可采集的屏幕，真实录屏检查未通过。")
        }
        try writeJSON([
            "captureSmokeTest": "source-selected",
            "sourceID": "screen:\(display.displayID)",
            "availableDisplays": String(content.displays.count),
            "availableWindows": String(content.windows.count)
        ])
        let options = Options(sourceId: "screen:\(display.displayID)", fps: 15, microphone: false,
                              audioDevice: nil, region: nil, outputSize: OutputSize(width: 1280, height: 720))
        try await start(options: options, output: output, showsBorder: showsBorder)
    }

    @MainActor func start(options: Options, output: URL, showsBorder: Bool = true) async throws {
        self.options = options
        queue.sync { muted = options.muted ?? false }
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
        if let path = options.zoomStatePath,
           let data = try? Data(contentsOf: URL(fileURLWithPath: path)),
           let saved = try? JSONDecoder().decode(Bounds.self, from: data) {
            _ = zoom.restore(saved)
        }
        setRequestedViewport(zoom.viewport)
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

        if showsBorder {
            reportStage("indicator")
            let border = RecordingBorder()
            border.update(zoom.bounds(in: originalRecordingBounds()))
            self.border = border
        }
        let filter: SCContentFilter
        if let window = selectedWindow {
            filter = SCContentFilter(desktopIndependentWindow: window)
        } else if let display = selectedDisplay {
            // Build the exclusion after the indicator exists so it never appears in recorded pixels.
            if let border = self.border {
                filter = try await displayFilter(display, excluding: border)
            } else {
                filter = SCContentFilter(display: display, excludingWindows: [])
            }
        } else { throw CaptureFailure("录制来源不可用。") }

        let configuration = recordingStreamConfiguration(fps: options.fps)
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
        if showsBorder { startZoomMonitoring() }
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

    @MainActor private func originalRecordingBounds() -> CGRect {
        borderRect(source: sourceBounds, region: options?.region, scale: sourceScale)
    }

    @MainActor private func startZoomMonitoring() {
        // A passive global scroll monitor keeps the recording frame click-through
        // and does not request keyboard monitoring or change system permissions.
        globalScrollMonitor = NSEvent.addGlobalMonitorForEvents(matching: .scrollWheel) { [weak self] event in
            _ = self?.handleZoomScroll(event)
        }
        localScrollMonitor = NSEvent.addLocalMonitorForEvents(matching: .scrollWheel) { [weak self] event in
            self?.handleZoomScroll(event) == true ? nil : event
        }
    }

    @MainActor private func handleZoomScroll(_ event: NSEvent) -> Bool {
        guard !stopping, event.modifierFlags.contains(.control), event.momentumPhase == [] else { return false }
        // CGEvent uses the same desktop origin as the capture source, including
        // monitors positioned above or to the left of the primary display.
        guard let point = event.cgEvent?.location else { return false }
        let steps = Double(event.scrollingDeltaY) / (event.hasPreciseScrollingDeltas ? 40 : 3)
        guard zoom.scroll(at: point, in: originalRecordingBounds(), steps: steps) else { return false }
        setRequestedViewport(zoom.viewport)
        border?.update(zoom.bounds(in: originalRecordingBounds()))
        if let path = options?.zoomStatePath,
           let data = try? JSONEncoder().encode(Bounds(zoom.viewport)) {
            // The parent uses this same viewport for its separate control bar.
            // Atomic replacement lets polling readers and resumed segments see
            // either the previous complete state or the next complete state.
            try? data.write(to: URL(fileURLWithPath: path), options: .atomic)
        }
        return true
    }

    private func currentViewport() -> CGRect {
        viewportLock.lock(); defer { viewportLock.unlock() }
        return requestedViewport
    }

    private func setRequestedViewport(_ viewport: CGRect) {
        viewportLock.lock(); defer { viewportLock.unlock() }
        requestedViewport = viewport
    }

    // Runs only on the serial capture queue. Retaining one source surface lets
    // a scroll gesture update a static screen without waiting for a new sample.
    private func renderLatestFrame(viewport: CGRect) throws {
        guard let source = latestSourceFrame, let pool = renderPool else { return }
        latestFrame = try letterboxedFrame(source, contentSize: captureContentSize, viewport: viewport,
                                          pool: pool, context: renderContext)
        renderedViewport = viewport
    }

    @MainActor private func displayFilter(_ display: SCDisplay, excluding border: RecordingBorder) async throws -> SCContentFilter {
        // Showing a window and publishing it to the capture service are separate
        // operations. Exclude the UI process as well as this helper, then retain
        // its identified ordinary windows. A control window published after
        // discovery stays excluded, while the existing main UI remains visible.
        // The explicit smoke test has no parent UI or recording controls.
        let excludesParent = smokeTestOutput == nil
        let deadline = Date().addingTimeInterval(3)
        repeat {
            try requireActive()
            // Include minimized UI windows when identifying the parent process.
            let updated = try await shareableContent(excludingDesktop: false, onScreenOnly: false)
            try requireActive()
            var seen = Set<pid_t>()
            let applications = (updated.applications + updated.windows.compactMap { $0.owningApplication }).filter {
                ($0.processID == getpid() || (excludesParent && $0.processID == parentPID))
                    && seen.insert($0.processID).inserted
            }
            if applications.contains(where: { $0.processID == getpid() }),
               !excludesParent || applications.contains(where: { $0.processID == parentPID }) {
                let retainedWindows = updated.windows.filter { window in
                    guard excludesParent, window.owningApplication?.processID == parentPID,
                          let title = window.title, !title.isEmpty else { return false }
                    return title != "Open Media 录制控制"
                }
                // Exceptions re-include windows excluded by the app rule. A
                // window without a readable title may still be the controls.
                return SCContentFilter(display: display, excludingApplications: applications,
                                       exceptingWindows: retainedWindows)
            }
            if !excludesParent {
                let ownWindows = updated.windows.filter {
                    $0.owningApplication?.processID == getpid() || $0.windowID == CGWindowID(border.panel.windowNumber)
                }
                if ownWindows.contains(where: { $0.windowID == CGWindowID(border.panel.windowNumber) }) {
                    return SCContentFilter(display: display, excludingWindows: ownWindows)
                }
            }
            try await Task.sleep(nanoseconds: 100_000_000)
        } while Date() < deadline
        throw CaptureFailure("系统尚未登记录制控制窗口，未开始采集画面。请重新选择录制范围。")
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

    @MainActor func verifyMicrophone(_ deviceID: String) async throws {
        // This separate, explicitly requested process checks permission and the
        // actual device while the existing video recorder continues untouched.
        try await prepareMicrophone(deviceID)
        guard let session = microphone else { throw CaptureFailure("无法打开所选麦克风。") }
        let running: Bool = await withCheckedContinuation { continuation in
            DispatchQueue.global(qos: .userInitiated).async {
                session.startRunning()
                let running = session.isRunning
                session.stopRunning()
                continuation.resume(returning: running)
            }
        }
        microphone = nil
        guard running else { throw CaptureFailure("麦克风未能开始采集，请检查设备和权限。") }
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .screen, CMSampleBufferIsValid(sampleBuffer), !stopping,
              let attachments = CMSampleBufferGetSampleAttachmentsArray(sampleBuffer, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
              let rawStatus = attachments.first?[.status] as? Int,
              SCFrameStatus(rawValue: rawStatus) == .complete,
              let buffer = CMSampleBufferGetImageBuffer(sampleBuffer), renderPool != nil else { return }
        receivedScreenFrames += 1
        latestSourceFrame = buffer
        do { try renderLatestFrame(viewport: currentViewport()) }
        catch { reportFailure(error); return }
        if !started { appendVideoFrame() }
    }

    private func appendVideoFrame() {
        guard !stopping else { return }
        let viewport = currentViewport()
        if viewport != renderedViewport {
            do { try renderLatestFrame(viewport: viewport) }
            catch { reportFailure(error); return }
        }
        guard let writer = writer, let video = video,
              let pixels = pixels, let buffer = latestFrame else { return }
        let now = CMClockGetTime(CMClockGetHostTimeClock())
        if let previous = lastVideoPTS, CMTimeCompare(now, previous) <= 0 { return }
        do {
            guard try appendFrame(buffer, writer: writer, input: video, adapter: pixels,
                                  at: now, sessionStart: &firstPTS) else { return }
        } catch { reportFailure(captureError(error, during: "写入录制画面")); return }
        lastVideoPTS = now
        encodedFrames += 1
        if !started {
            started = true
            FileHandle.standardOutput.write(Data("READY\n".utf8))
            if smokeTestOutput != nil {
                // Count from an encoded screen sample, not from permission or
                // stream startup, so an empty capture cannot pass this check.
                DispatchQueue.main.async { [weak self] in
                    guard let self = self, !self.stopping else { return }
                    self.smokeTestBorderWasVisible = self.border?.panel.isVisible == true
                    try? writeJSON([
                        "captureSmokeTest": "first-frame",
                        "recordingBorderVisible": String(self.smokeTestBorderWasVisible)
                    ])
                    guard self.smokeTestBorderWasVisible == self.smokeTestExpectedBorder else {
                        self.stop(error: CaptureFailure("真实录屏检查中观察到的边框可见状态与请求不一致。"))
                        return
                    }
                    DispatchQueue.main.asyncAfter(deadline: .now() + 3) { [weak self] in self?.stop() }
                }
            }
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
            let frame: CMSampleBuffer
            if muted { frame = try silentAudioSample(retimed) }
            else { frame = retimed }
            guard audio.append(frame) else {
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
            sourceBounds = rect
            border?.update(zoom.bounds(in: originalRecordingBounds()))
        } else if let id = displayID {
            guard CGDisplayIsActive(id) != 0, options != nil else {
                stop(error: CaptureFailure("所选屏幕已断开，录制已暂停。")); return
            }
            let rect = CGDisplayBounds(id), scale = screenScale(for: rect)
            // Changing display geometry invalidates a pixel-based region. Preserve the completed segment.
            guard rect == sourceBounds, scale == sourceScale else {
                stop(error: CaptureFailure("屏幕尺寸或缩放已改变，请重新选择录制区域。")); return
            }
            border?.update(zoom.bounds(in: originalRecordingBounds()))
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
        if let globalScrollMonitor = globalScrollMonitor { NSEvent.removeMonitor(globalScrollMonitor) }
        if let localScrollMonitor = localScrollMonitor { NSEvent.removeMonitor(localScrollMonitor) }
        globalScrollMonitor = nil; localScrollMonitor = nil
        border?.close()
        if smokeTestOutput != nil { smokeTestBorderClosed = border?.panel.isVisible != true }
        border = nil
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
                self.latestSourceFrame = nil
                self.latestFrame = nil
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
        var failure = error
        if let output = smokeTestOutput, failure == nil {
            do { try verifySmokeTestOutput(output) }
            catch { failure = error }
        }
        smokeTestDeadline?.cancel()
        smokeTestHardDeadline?.cancel()
        if let failure = failure {
            if smokeTestOutput != nil {
                try? writeJSON(["captureSmokeTest": "failed", "reason": failure.localizedDescription])
            }
            writeError(failure)
        }
        exit(failure == nil ? 0 : 1)
    }

    private func verifySmokeTestOutput(_ output: URL) throws {
        guard receivedScreenFrames > 0, encodedFrames > 1,
              smokeTestBorderWasVisible == smokeTestExpectedBorder, smokeTestBorderClosed else {
            throw CaptureFailure("真实录屏检查未取得足够的采集帧，或录制边框显示与关闭检查失败。")
        }
        let attributes = try FileManager.default.attributesOfItem(atPath: output.path)
        let size = (attributes[.size] as? NSNumber)?.int64Value ?? 0
        let asset = AVURLAsset(url: output)
        let duration = CMTimeGetSeconds(asset.duration)
        guard size > 0, duration.isFinite, duration >= 2.8, duration <= 10,
              let track = asset.tracks(withMediaType: .video).first,
              track.naturalSize == CGSize(width: 1280, height: 720),
              asset.tracks(withMediaType: .audio).isEmpty else {
            throw CaptureFailure("真实录屏输出的大小、时长、画面尺寸或音轨检查失败。")
        }
        let generator = AVAssetImageGenerator(asset: asset)
        for second in [0.0, 2.0] {
            let image = try generator.copyCGImage(at: CMTime(seconds: second, preferredTimescale: 600), actualTime: nil)
            guard image.width == 1280, image.height == 720 else {
                throw CaptureFailure("真实录屏输出无法解码为预期画面。")
            }
        }
        try writeJSON([
            "captureSmokeTest": "passed",
            "durationSeconds": String(duration),
            "screenFrames": String(receivedScreenFrames),
            "encodedFrames": String(encodedFrames),
            "recordingBorderWasVisible": String(smokeTestBorderWasVisible),
            "recordingBorderClosed": String(smokeTestBorderClosed),
            "outputBytes": String(size),
            "outputPath": output.path
        ])
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
    try verifyRecordingStreamConfiguration()
    try verifyCaptureZoomGeometry()
    try verifyAudioTiming()
    try verifyVideoEncoding(sourceSize: OutputSize(width: 120, height: 240), outputSize: OutputSize(width: 320, height: 180))
    try verifyVideoEncoding(sourceSize: OutputSize(width: 240, height: 120), outputSize: OutputSize(width: 180, height: 320))
    try verifyVideoEncoding(sourceSize: OutputSize(width: 240, height: 120), outputSize: OutputSize(width: 180, height: 320),
                            viewport: CGRect(x: 0.5, y: 0, width: 0.5, height: 0.5))
    try verifyVideoEncoding(sourceSize: OutputSize(width: 120, height: 240), outputSize: OutputSize(width: 320, height: 180),
                            viewport: CGRect(x: 0, y: 0.5, width: 0.5, height: 0.5))
    print("Capture geometry, bounded pointer zoom, validation, stream configuration copying, audio timing, video encoding and decoded pixel checks passed.")
}

func verifyCaptureZoomGeometry() throws {
    let original = CGRect(x: -1820, y: -150, width: 800, height: 600)
    let pointer = CGPoint(x: -1220, y: 0)
    var zoom = CaptureZoom()
    guard zoom.scroll(at: pointer, in: original, steps: 1) else { throw CaptureFailure("录制缩放没有响应。") }
    let actual = zoom.bounds(in: original)
    let oldX = (pointer.x - original.minX) / original.width
    let oldY = (pointer.y - original.minY) / original.height
    guard abs((pointer.x - actual.minX) / actual.width - oldX) < 0.000001,
          abs((pointer.y - actual.minY) / actual.height - oldY) < 0.000001,
          abs(actual.width / actual.height - original.width / original.height) < 0.000001,
          original.contains(actual) else { throw CaptureFailure("录制缩放未保持鼠标锚点、比例或原始边界。") }
    var edgeZoom = CaptureZoom()
    _ = edgeZoom.restore(Bounds(CGRect(x: 0.25, y: 0.25, width: 0.5, height: 0.5)))
    let previousEdge = edgeZoom.viewport
    _ = edgeZoom.scroll(at: CGPoint(x: original.maxX - 1, y: original.minY + 1), in: original, steps: 1)
    guard abs(edgeZoom.viewport.maxX - previousEdge.maxX) < 0.000001,
          abs(edgeZoom.viewport.minY - previousEdge.minY) < 0.000001 else {
        throw CaptureFailure("鼠标位于当前红框外时，缩放未锚定到红框边界。")
    }
    for _ in 0..<100 { _ = zoom.scroll(at: CGPoint(x: original.maxX - 1, y: original.maxY - 1), in: original, steps: 8) }
    guard zoom.viewport.width == 0.125, original.contains(zoom.bounds(in: original)) else {
        throw CaptureFailure("录制缩放超出了八倍或原始边界。")
    }
    let beforeOutside = zoom.viewport
    var restored = CaptureZoom()
    guard restored.restore(Bounds(beforeOutside)), restored.viewport == beforeOutside,
          !restored.restore(Bounds(CGRect(x: -1, y: 0, width: 0.5, height: 0.5))),
          !restored.restore(Bounds(CGRect(x: 0, y: 0, width: 0.5, height: 0.75))),
          restored.viewport == beforeOutside else {
        throw CaptureFailure("录制缩放恢复未校验边界或改变了有效状态。")
    }
    guard !zoom.scroll(at: CGPoint(x: 5000, y: 5000), in: original, steps: 1),
          !zoom.scroll(at: pointer, in: original, steps: .nan), zoom.viewport == beforeOutside else {
        throw CaptureFailure("录制范围外的滚轮改变了画面。")
    }
    for _ in 0..<100 { _ = zoom.scroll(at: pointer, in: original, steps: -8) }
    guard zoom.bounds(in: original) == original else { throw CaptureFailure("录制缩小未恢复原始范围。") }
}

func verifyRecordingStreamConfiguration() throws {
    // SCStream copies its configuration when it starts. Exercise that same
    // operation after the production factory's temporary objects have gone.
    let configuration = autoreleasepool { recordingStreamConfiguration(fps: 30) }
    configuration.width = 1280
    configuration.height = 720
    let copy: SCStreamConfiguration = try autoreleasepool {
        guard let copy = configuration.copy() as? SCStreamConfiguration else {
            throw CaptureFailure("录制流配置无法复制。")
        }
        return copy
    }
    guard let secondCopy = copy.copy() as? SCStreamConfiguration,
          secondCopy.width == 1280, secondCopy.height == 720,
          CMTimeCompare(secondCopy.minimumFrameInterval, CMTime(value: 1, timescale: 30)) == 0,
          !secondCopy.capturesAudio else {
        throw CaptureFailure("录制流配置复制后参数不正确。")
    }
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
    guard let block = block, CMBlockBufferFillDataBytes(with: 0x33, blockBuffer: block,
        offsetIntoDestination: 0, dataLength: 4096) == kCMBlockBufferNoErr else {
        throw CaptureFailure("音轨时间验证无法写入测试数据。")
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
    let silent = try silentAudioSample(retimed)
    guard let silentBlock = CMSampleBufferGetDataBuffer(silent),
          CMTimeCompare(CMSampleBufferGetDuration(silent), CMSampleBufferGetDuration(retimed)) == 0,
          CMTimeCompare(CMSampleBufferGetPresentationTimeStamp(silent), destination) == 0,
          CMSampleBufferGetNumSamples(silent) == 1024 else {
        throw CaptureFailure("静音改变了音频样本时间。")
    }
    var originalBytes = [UInt8](repeating: 0, count: 4096)
    var silentBytes = [UInt8](repeating: 0xff, count: 4096)
    guard CMBlockBufferCopyDataBytes(block, atOffset: 0, dataLength: 4096,
        destination: &originalBytes) == kCMBlockBufferNoErr,
        CMBlockBufferCopyDataBytes(silentBlock, atOffset: 0, dataLength: 4096,
        destination: &silentBytes) == kCMBlockBufferNoErr,
        originalBytes.allSatisfy({ $0 == 0x33 }), silentBytes.allSatisfy({ $0 == 0 }) else {
        throw CaptureFailure("静音样本未清零，或修改了原始麦克风数据。")
    }
}

func verifyVideoEncoding(sourceSize: OutputSize, outputSize: OutputSize,
                         viewport: CGRect = CGRect(x: 0, y: 0, width: 1, height: 1)) throws {
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
            let inside = viewport.contains(CGPoint(x: (Double(x) + 0.5) / Double(sourceSize.width),
                                                   y: (Double(y) + 0.5) / Double(sourceSize.height)))
            base[offset] = inside ? 0 : 255; base[offset + 1] = 0
            base[offset + 2] = inside ? 255 : 0; base[offset + 3] = 255
        }
    }
    CVPixelBufferUnlockBaseAddress(buffer, [])
    let pool = try makeRenderPool(size: outputSize)
    let frame = try letterboxedFrame(buffer, viewport: viewport, pool: pool,
                                    context: CIContext(options: [.useSoftwareRenderer: true]))
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
            if arguments.count == 3, arguments[1] == "--capture-smoke-test" || arguments[1] == "--capture-smoke-test-no-border" {
                try await recorder.startSmokeTest(output: URL(fileURLWithPath: arguments[2]),
                                                  showsBorder: arguments[1] == "--capture-smoke-test")
                return
            }
            if (arguments.count == 2 || (arguments.count == 3 && arguments[2] == "--request-permission")), arguments[1] == "sources" {
                try writeJSON(await listSources(requestPermission: arguments.count == 3)); exit(0)
            }
            if arguments.count == 3, arguments[1] == "microphone" {
                try await recorder.verifyMicrophone(arguments[2]); exit(0)
            }
            guard arguments.count == 4, arguments[1] == "record" || screenshotMode else {
                throw CaptureFailure("用法：sources、record <配置文件> <输出文件> 或 screenshot <配置文件> <输出文件>。")
            }
            DispatchQueue.global(qos: .utility).async {
                while let line = readLine() {
                    let command = line.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
                    if command == "q" { break }
                    if !screenshotMode {
                        if command == "mute" { recorder.setMuted(true) }
                        if command == "unmute" { recorder.setMuted(false) }
                    }
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
