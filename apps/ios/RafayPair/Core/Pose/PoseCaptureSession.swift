import AVFoundation
import Vision

/// `AVCaptureSession` is documented as safe to call from any thread but is not
/// annotated `Sendable`, so moving one onto the capture queue needs an explicit
/// transfer. Keeping the escape hatch in one named type makes every crossing
/// visible rather than blanket-disabling concurrency checking for AVFoundation.
private struct TransferBox<Value>: @unchecked Sendable {
    let value: Value

    init(_ value: Value) {
        self.value = value
    }
}

/// On-device camera pose capture.
///
/// Frames never leave the process: the buffer is handed to Vision, converted to
/// the canonical thirteen-joint skeleton, and released. Nothing is written to
/// disk and nothing is uploaded. Only the derived observations escape this
/// type, which is what makes the "no camera upload" guarantee auditable at a
/// single boundary.
@MainActor
@Observable
final class PoseCaptureSession: NSObject {
    enum State: Equatable {
        case idle
        case denied
        case unavailable(String)
        case running
    }

    private(set) var state: State = .idle

    /// Called on the main actor for every processed frame.
    var onFrame: ((PoseFrame) -> Void)?

    private let session = AVCaptureSession()
    private let output = AVCaptureVideoDataOutput()
    private let queue = DispatchQueue(label: "com.rafaypair.pose.capture")
    var captureSession: AVCaptureSession { session }

    func start() async {
        guard state != .running else { return }

        let authorized = await Self.requestCameraAccess()
        guard authorized else {
            state = .denied
            return
        }

        guard
            let device = AVCaptureDevice.default(
                .builtInWideAngleCamera, for: .video, position: .front
            )
        else {
            state = .unavailable("No front camera is available on this device.")
            return
        }

        do {
            session.beginConfiguration()
            session.sessionPreset = .hd1280x720
            for input in session.inputs { session.removeInput(input) }
            for existing in session.outputs { session.removeOutput(existing) }

            let input = try AVCaptureDeviceInput(device: device)
            guard session.canAddInput(input), session.canAddOutput(output) else {
                session.commitConfiguration()
                state = .unavailable("The camera could not be configured.")
                return
            }
            session.addInput(input)
            output.alwaysDiscardsLateVideoFrames = true
            output.setSampleBufferDelegate(self, queue: queue)
            session.addOutput(output)
            session.commitConfiguration()
        } catch {
            session.commitConfiguration()
            state = .unavailable("The camera could not be opened.")
            return
        }

        let capture = TransferBox(session)
        await withCheckedContinuation { continuation in
            queue.async {
                capture.value.startRunning()
                continuation.resume()
            }
        }
        state = .running
    }

    func stop() {
        guard state == .running else { return }
        let capture = TransferBox(session)
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

extension PoseCaptureSession: AVCaptureVideoDataOutputSampleBufferDelegate {
    nonisolated func captureOutput(
        _ output: AVCaptureOutput,
        didOutput sampleBuffer: CMSampleBuffer,
        from connection: AVCaptureConnection
    ) {
        guard let buffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
        let timestampMs =
            CMTimeGetSeconds(CMSampleBufferGetPresentationTimeStamp(sampleBuffer)) * 1000

        let handler = VNImageRequestHandler(cvPixelBuffer: buffer, orientation: .up)
        let request = VNDetectHumanBodyPoseRequest()
        do {
            try handler.perform([request])
        } catch {
            return
        }
        guard let observation = request.results?.first else { return }
        guard
            let frame = Self.canonicalFrame(
                from: observation,
                timestampMs: timestampMs
            )
        else { return }

        // The engine is invariant to horizontal mirroring and to left/right
        // labelling (see engines/pose-spec/SPEC.md §2), so a front-camera frame
        // needs no correction before it is handed over.
        Task { @MainActor [weak self] in
            self?.onFrame?(frame)
        }
        // The pixel buffer goes out of scope here. Nothing retains it, nothing
        // encodes it, and nothing transmits it.
    }

    /// Maps Vision's joint names onto the canonical skeleton.
    ///
    /// Vision reports normalized coordinates with the origin at the bottom-left
    /// and `y` growing upward; the engine specification uses a top-left origin
    /// with `y` growing downward, so `y` is flipped here.
    nonisolated private static func canonicalFrame(
        from observation: VNHumanBodyPoseObservation,
        timestampMs: Double
    ) -> PoseFrame? {
        let mapping: [JointName: VNHumanBodyPoseObservation.JointName] = [
            .nose: .nose,
            .leftShoulder: .leftShoulder,
            .rightShoulder: .rightShoulder,
            .leftElbow: .leftElbow,
            .rightElbow: .rightElbow,
            .leftWrist: .leftWrist,
            .rightWrist: .rightWrist,
            .leftHip: .leftHip,
            .rightHip: .rightHip,
            .leftKnee: .leftKnee,
            .rightKnee: .rightKnee,
            .leftAnkle: .leftAnkle,
            .rightAnkle: .rightAnkle,
        ]

        var joints = [Joint](
            repeating: Joint(x: 0, y: 0, visibility: 0),
            count: JointName.allCases.count
        )
        for name in JointName.allCases {
            guard let visionName = mapping[name],
                let point = try? observation.recognizedPoint(visionName)
            else {
                continue
            }
            joints[name.rawValue] = Joint(
                x: point.location.x,
                y: 1 - point.location.y,
                visibility: Double(point.confidence)
            )
        }
        return PoseFrame(timestampMs: timestampMs, joints: joints)
    }

}
