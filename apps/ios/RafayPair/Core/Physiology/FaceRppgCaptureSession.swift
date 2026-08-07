import AVFoundation
import CoreVideo
import Vision

/// Front-camera capture for the experimental face rPPG mode.
///
/// Frames never leave the process: each buffer is reduced to the six numbers the
/// estimator needs over a forehead region and released. Nothing is written to
/// disk and nothing is uploaded.
///
/// The camera starts only from an explicit user action inside this mode, which
/// is master specification §3.3's "never silently activate camera" made
/// operational: there is no code path that constructs this type otherwise, and
/// with `PhysiologyTuning.faceRppgEnabled` off nothing constructs it at all.
@MainActor
@Observable
final class FaceRppgCaptureSession: NSObject {
    enum State: Equatable {
        case idle
        case denied
        case unavailable(String)
        case measuring
    }

    private(set) var state: State = .idle
    private(set) var samples: [FaceRppgSample] = []
    /// Rolling gate feedback while the session runs.
    private(set) var faceVisible = false
    private(set) var wellLit = false

    private let session = AVCaptureSession()
    private let output = AVCaptureVideoDataOutput()
    private let queue = DispatchQueue(label: "com.rafaypair.rppg.capture")

    var captureSession: AVCaptureSession { session }

    /// Longer than the fingertip window: the facial signal is far weaker, so it
    /// needs more of it before anything can be said.
    static let targetDurationMs = 40_000.0

    var progress: Double {
        guard let first = samples.first, let last = samples.last else { return 0 }
        return min(1, (last.timestampMs - first.timestampMs) / Self.targetDurationMs)
    }

    func start() async {
        guard state != .measuring else { return }
        samples = []
        faceVisible = false
        wellLit = false

        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized: break
        case .notDetermined:
            guard await AVCaptureDevice.requestAccess(for: .video) else {
                state = .denied
                return
            }
        default:
            state = .denied
            return
        }

        guard
            let camera = AVCaptureDevice.default(
                .builtInWideAngleCamera, for: .video, position: .front
            )
        else {
            state = .unavailable("This device has no front camera.")
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
                kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA
            ]
            output.setSampleBufferDelegate(self, queue: queue)
            session.addOutput(output)
            session.commitConfiguration()

            try camera.lockForConfiguration()
            // Locking exposure matters more here than anywhere: auto-exposure
            // hunting is itself a slow brightness oscillation, which is the very
            // artefact the lighting gate exists to reject.
            if camera.isExposureModeSupported(.locked) { camera.exposureMode = .locked }
            if camera.isWhiteBalanceModeSupported(.locked) {
                camera.whiteBalanceMode = .locked
            }
            camera.unlockForConfiguration()
        } catch {
            session.commitConfiguration()
            state = .unavailable("The camera could not be opened.")
            return
        }

        let capture = RppgTransferBox(session)
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
        let capture = RppgTransferBox(session)
        queue.async { capture.value.stopRunning() }
        state = .idle
    }

    private func append(_ sample: FaceRppgSample) {
        guard state == .measuring else { return }
        samples.append(sample)
        faceVisible = sample.faceArea >= PhysiologyTuning.faceMinArea
        wellLit =
            sample.luma >= PhysiologyTuning.faceMinLuma
            && sample.luma <= PhysiologyTuning.faceMaxLuma
    }
}

/// See `PulseCaptureSession`; `AVCaptureSession` is thread-safe but not
/// annotated `Sendable`, so the hop onto the capture queue is made explicit.
private struct RppgTransferBox<Value>: @unchecked Sendable {
    let value: Value

    init(_ value: Value) {
        self.value = value
    }
}

extension FaceRppgCaptureSession: AVCaptureVideoDataOutputSampleBufferDelegate {
    nonisolated func captureOutput(
        _ output: AVCaptureOutput,
        didOutput sampleBuffer: CMSampleBuffer,
        from connection: AVCaptureConnection
    ) {
        guard let buffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
        let timestampMs =
            CMTimeGetSeconds(CMSampleBufferGetPresentationTimeStamp(sampleBuffer)) * 1000

        let request = VNDetectFaceRectanglesRequest()
        let handler = VNImageRequestHandler(cvPixelBuffer: buffer, orientation: .up)
        try? handler.perform([request])

        // Vision reports a bottom-left origin; the region maths below works in
        // top-left pixel space, so the box is flipped once, here.
        guard let face = request.results?.first else {
            let sample = FaceRppgSample(
                timestampMs: timestampMs, green: 0, luma: 0,
                faceArea: 0, faceCenterX: 0.5, faceCenterY: 0.5
            )
            Task { @MainActor [weak self] in self?.append(sample) }
            return
        }

        let box = face.boundingBox
        let region = CGRect(
            x: box.minX + box.width * 0.25,
            y: (1 - box.maxY) + box.height * 0.08,
            width: box.width * 0.5,
            height: box.height * 0.22
        )
        guard let means = Self.regionMeans(buffer, region: region) else { return }

        let sample = FaceRppgSample(
            timestampMs: timestampMs,
            green: means.green,
            luma: means.luma,
            faceArea: Double(box.width * box.height),
            faceCenterX: Double(box.midX),
            faceCenterY: Double(1 - box.midY)
        )
        Task { @MainActor [weak self] in self?.append(sample) }
        // The pixel buffer goes out of scope here. Nothing retains it, nothing
        // encodes it, and nothing transmits it.
    }

    /// Mean green and luma over the forehead region — the best-perfused facial
    /// skin least occluded by hair, glasses, and expression.
    nonisolated private static func regionMeans(
        _ buffer: CVPixelBuffer,
        region: CGRect
    ) -> (green: Double, luma: Double)? {
        CVPixelBufferLockBaseAddress(buffer, .readOnly)
        defer { CVPixelBufferUnlockBaseAddress(buffer, .readOnly) }

        guard let base = CVPixelBufferGetBaseAddress(buffer) else { return nil }
        let width = CVPixelBufferGetWidth(buffer)
        let height = CVPixelBufferGetHeight(buffer)
        let bytesPerRow = CVPixelBufferGetBytesPerRow(buffer)

        let startX = max(0, Int(region.minX * CGFloat(width)))
        let endX = min(width, Int(region.maxX * CGFloat(width)))
        let startY = max(0, Int(region.minY * CGFloat(height)))
        let endY = min(height, Int(region.maxY * CGFloat(height)))
        guard endX - startX > 2, endY - startY > 2 else { return nil }

        var greenTotal = 0.0
        var lumaTotal = 0.0
        var count = 0
        let pointer = base.assumingMemoryBound(to: UInt8.self)
        var y = startY
        while y < endY {
            let row = pointer.advanced(by: y * bytesPerRow)
            var x = startX
            while x < endX {
                // 32BGRA: byte order is blue, green, red, alpha.
                let pixel = row.advanced(by: x * 4)
                let blue = Double(pixel[0])
                let green = Double(pixel[1])
                let red = Double(pixel[2])
                greenTotal += green
                // BT.601 luma, matching what the Android path derives from Y.
                lumaTotal += 0.299 * red + 0.587 * green + 0.114 * blue
                count += 1
                x += 2
            }
            y += 2
        }
        guard count > 0 else { return nil }
        return (green: greenTotal / Double(count), luma: lumaTotal / Double(count))
    }
}
