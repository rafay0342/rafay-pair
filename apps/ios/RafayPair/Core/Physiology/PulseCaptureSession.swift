import AVFoundation
import CoreVideo

/// `AVCaptureSession` is documented as safe to call from any thread but is not
/// annotated `Sendable`, so moving one onto the capture queue needs an explicit
/// transfer. Keeping the escape hatch in one named type makes every crossing
/// visible rather than blanket-disabling concurrency checking for AVFoundation.
private struct PulseTransferBox<Value>: @unchecked Sendable {
    let value: Value

    init(_ value: Value) {
        self.value = value
    }
}

/// Finger-camera photoplethysmography capture.
///
/// Frames never leave the process: each buffer is reduced to two channel means
/// over a centred region of interest and immediately released. Nothing is
/// written to disk and nothing is uploaded — only `PulseSample` values escape
/// this type, which is what makes the guarantee auditable at a single boundary.
///
/// This is an explicit, user-initiated session with a fixed duration. There is
/// no continuous stream and no background sampling; the torch is lit only while
/// a measurement is running and is extinguished when it stops.
@MainActor
@Observable
final class PulseCaptureSession: NSObject {
    enum State: Equatable {
        case idle
        case denied
        case unavailable(String)
        case measuring
    }

    private(set) var state: State = .idle
    /// Samples collected in the current session. Reset on each start.
    private(set) var samples: [PulseSample] = []
    /// Rolling coverage indicator so the interface can say "press a little
    /// firmer" while the measurement is still running.
    private(set) var fingerDetected = false

    private let session = AVCaptureSession()
    private let output = AVCaptureVideoDataOutput()
    private let queue = DispatchQueue(label: "com.rafaypair.pulse.capture")
    private var device: AVCaptureDevice?

    var captureSession: AVCaptureSession { session }

    /// The measurement window the interface counts down. Longer than the
    /// engine's minimum so a session that completes normally is comfortably
    /// above the rejection threshold.
    static let targetDurationMs = 20_000.0

    var progress: Double {
        guard let first = samples.first, let last = samples.last else { return 0 }
        return min(1, (last.timestampMs - first.timestampMs) / Self.targetDurationMs)
    }

    func start() async {
        guard state != .measuring else { return }
        samples = []
        fingerDetected = false

        let authorized = await Self.requestCameraAccess()
        guard authorized else {
            state = .denied
            return
        }

        guard
            let camera = AVCaptureDevice.default(
                .builtInWideAngleCamera, for: .video, position: .back
            )
        else {
            state = .unavailable("This device has no rear camera to measure with.")
            return
        }
        guard camera.hasTorch else {
            // Without a torch the fingertip is unlit and the signal is not
            // recoverable. Saying so is better than producing a weak estimate.
            state = .unavailable("This device has no torch, which pulse measurement needs.")
            return
        }

        do {
            session.beginConfiguration()
            session.sessionPreset = .vga640x480
            for input in session.inputs { session.removeInput(input) }
            for existing in session.outputs { session.removeOutput(existing) }

            let input = try AVCaptureDeviceInput(device: camera)
            guard session.canAddInput(input), session.canAddOutput(output) else {
                session.commitConfiguration()
                state = .unavailable("The camera could not be configured.")
                return
            }
            session.addInput(input)
            output.alwaysDiscardsLateVideoFrames = true
            output.videoSettings = [
                kCVPixelBufferPixelFormatTypeKey as String:
                    kCVPixelFormatType_32BGRA
            ]
            output.setSampleBufferDelegate(self, queue: queue)
            session.addOutput(output)
            session.commitConfiguration()

            try camera.lockForConfiguration()
            // A fixed exposure and white balance matter more here than image
            // quality: automatic adjustment would chase the pulsation itself and
            // suppress the very signal being measured.
            if camera.isExposureModeSupported(.locked) { camera.exposureMode = .locked }
            if camera.isWhiteBalanceModeSupported(.locked) {
                camera.whiteBalanceMode = .locked
            }
            try camera.setTorchModeOn(level: 0.6)
            camera.unlockForConfiguration()
            device = camera
        } catch {
            session.commitConfiguration()
            state = .unavailable("The camera could not be opened.")
            return
        }

        let capture = PulseTransferBox(session)
        await withCheckedContinuation { continuation in
            queue.async {
                capture.value.startRunning()
                continuation.resume()
            }
        }
        state = .measuring
    }

    func stop() {
        guard state == .measuring else { return }
        if let device, device.hasTorch {
            try? device.lockForConfiguration()
            device.torchMode = .off
            device.unlockForConfiguration()
        }
        device = nil
        let capture = PulseTransferBox(session)
        queue.async { capture.value.stopRunning() }
        state = .idle
    }

    private static func requestCameraAccess() async -> Bool {
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized: return true
        case .notDetermined: return await AVCaptureDevice.requestAccess(for: .video)
        default: return false
        }
    }
}

extension PulseCaptureSession: AVCaptureVideoDataOutputSampleBufferDelegate {
    nonisolated func captureOutput(
        _ output: AVCaptureOutput,
        didOutput sampleBuffer: CMSampleBuffer,
        from connection: AVCaptureConnection
    ) {
        guard let buffer = CMSampleBufferGetImageBuffer(sampleBuffer),
            let means = Self.regionMeans(buffer)
        else { return }
        let timestampMs =
            CMTimeGetSeconds(CMSampleBufferGetPresentationTimeStamp(sampleBuffer)) * 1000

        let sample = PulseSample(
            timestampMs: timestampMs, red: means.red, green: means.green
        )
        Task { @MainActor [weak self] in
            self?.append(sample)
        }
        // The pixel buffer goes out of scope here. Nothing retains it, nothing
        // encodes it, and nothing transmits it.
    }

    private func append(_ sample: PulseSample) {
        guard state == .measuring else { return }
        samples.append(sample)
        fingerDetected =
            sample.red >= PhysiologyTuning.fingerMinRed
            && sample.green <= PhysiologyTuning.fingerMaxGreen
            && sample.red - sample.green >= PhysiologyTuning.fingerMinRedExcess
    }

    /// Mean red and green over the centred middle third of the frame.
    ///
    /// A centred region avoids the lens vignette at the edges, where the torch
    /// falls off and the signal is weakest.
    nonisolated private static func regionMeans(
        _ buffer: CVPixelBuffer
    ) -> (red: Double, green: Double)? {
        CVPixelBufferLockBaseAddress(buffer, .readOnly)
        defer { CVPixelBufferUnlockBaseAddress(buffer, .readOnly) }

        guard let base = CVPixelBufferGetBaseAddress(buffer) else { return nil }
        let width = CVPixelBufferGetWidth(buffer)
        let height = CVPixelBufferGetHeight(buffer)
        let bytesPerRow = CVPixelBufferGetBytesPerRow(buffer)
        guard width > 6, height > 6 else { return nil }

        let startX = width / 3
        let endX = min(width, 2 * width / 3)
        let startY = height / 3
        let endY = min(height, 2 * height / 3)
        // Sampling every fourth pixel keeps the per-frame cost trivial while
        // still averaging thousands of pixels.
        let step = 4

        var redTotal = 0.0
        var greenTotal = 0.0
        var count = 0
        let pointer = base.assumingMemoryBound(to: UInt8.self)
        var y = startY
        while y < endY {
            let row = pointer.advanced(by: y * bytesPerRow)
            var x = startX
            while x < endX {
                // 32BGRA: byte order is blue, green, red, alpha.
                let pixel = row.advanced(by: x * 4)
                greenTotal += Double(pixel[1])
                redTotal += Double(pixel[2])
                count += 1
                x += step
            }
            y += step
        }
        guard count > 0 else { return nil }
        return (red: redTotal / Double(count), green: greenTotal / Double(count))
    }
}
