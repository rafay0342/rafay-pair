import AVFoundation
import SwiftUI

/// Local camera workout. Runs entirely on this phone.
struct WorkoutView: View {
    @State private var capture = PoseCaptureSession()
    @State private var store = WorkoutStore()

    var body: some View {
        ScrollView {
            VStack(spacing: 18) {
                header
                cameraCard
                statusCard
                if let summary = store.summary {
                    summaryCard(summary)
                }
                privacyCard
            }
            .padding(18)
        }
        .background(Brand.background.ignoresSafeArea())
        .navigationTitle("Move")
        .onAppear {
            capture.onFrame = { frame in store.handle(frame: frame) }
        }
        .onDisappear {
            store.endSession()
            capture.stop()
        }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("Squat session")
                .font(.title.bold())
            Text("Your camera stays on this phone. Nothing is recorded or uploaded.")
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var cameraCard: some View {
        RPCard {
            VStack(spacing: 12) {
                ZStack {
                    switch capture.state {
                    case .running:
                        CameraPreview(session: capture.captureSession)
                            .aspectRatio(3 / 4, contentMode: .fit)
                            .clipShape(RoundedRectangle(cornerRadius: 16))
                    case .denied:
                        placeholder(
                            "Camera access is off",
                            detail: "Enable camera access in Settings to use a local workout."
                        )
                    case .unavailable(let reason):
                        placeholder("Camera unavailable", detail: reason)
                    case .idle:
                        placeholder(
                            "Camera is off",
                            detail: "Start a session to begin tracking on this device."
                        )
                    }
                }

                Button {
                    Task { await toggleSession() }
                } label: {
                    Label(
                        store.isRecording ? "End session" : "Start session",
                        systemImage: store.isRecording ? "stop.fill" : "play.fill"
                    )
                    .frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
            }
        }
    }

    private var statusCard: some View {
        RPCard {
            VStack(alignment: .leading, spacing: 12) {
                HStack(alignment: .firstTextBaseline) {
                    Text("\(store.repetitionCount)")
                        .font(.system(size: 44, weight: .bold, design: .rounded))
                        .monospacedDigit()
                    Text(store.repetitionCount == 1 ? "squat" : "squats")
                        .foregroundStyle(.secondary)
                    Spacer()
                    Text(postureLabel)
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(Brand.plum)
                }
                Text(store.guidance)
                    .foregroundStyle(.secondary)
                if let repetition = store.lastRepetition, !repetition.formEvents.isEmpty {
                    ForEach(repetition.formEvents, id: \.rawValue) { event in
                        Label(formHint(event), systemImage: "figure.strengthtraining.functional")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                }
            }
        }
    }

    private func summaryCard(_ summary: SessionSummary) -> some View {
        RPCard {
            VStack(alignment: .leading, spacing: 8) {
                Label("Session summary", systemImage: "checkmark.seal.fill")
                    .font(.headline)
                    .foregroundStyle(Brand.plum)
                Text("\(summary.repetitionCount) squats recorded on this device.")
                if summary.repetitionCount > 0 {
                    Text(
                        "Best depth \(Int((summary.bestDepth * 100).rounded()))% of a full squat."
                    )
                    .foregroundStyle(.secondary)
                }
                if let calories = store.calories {
                    Text(
                        "Estimated \(Int(calories.estimatedKcal.rounded())) kcal "
                            + "(\(Int(calories.lowKcal.rounded()))–\(Int(calories.highKcal.rounded())) kcal)"
                    )
                    Text(
                        "A phone estimate with a \(calories.bandLabel.rawValue) band. Adding your weight in Settings would narrow it."
                    )
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                }
                Text("Sharing this with your partner is a separate choice in Sharing.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        }
    }

    private var privacyCard: some View {
        RPCard {
            VStack(alignment: .leading, spacing: 8) {
                Label("Stays on this phone", systemImage: "lock.shield.fill")
                    .font(.headline)
                    .foregroundStyle(Brand.plum)
                Text(
                    "Pose runs locally with Apple's on-device Vision framework. Frames are analysed and immediately discarded — no video is stored or sent anywhere."
                )
                .foregroundStyle(.secondary)
            }
        }
    }

    private var postureLabel: String {
        switch store.reportedPosture {
        case .unknown: "Finding you"
        case .standing: "Standing"
        case .sitting: "Sitting"
        case .lyingDown: "Lying down"
        case .squatting: "Squatting"
        }
    }

    private func formHint(_ event: FormEvent) -> String {
        switch event {
        case .shallowDepth: "Try to sit a little lower on the next one."
        case .forwardLean: "Keep your chest a bit more upright."
        case .uneven: "Weight looked uneven between your legs."
        }
    }

    private func placeholder(_ title: String, detail: String) -> some View {
        VStack(spacing: 6) {
            Image(systemName: "camera.fill")
                .font(.largeTitle)
                .foregroundStyle(.secondary)
            Text(title).font(.headline)
            Text(detail)
                .font(.footnote)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity, minHeight: 220)
    }

    private func toggleSession() async {
        if store.isRecording {
            store.endSession()
            capture.stop()
        } else {
            store.startSession()
            await capture.start()
        }
    }
}

/// Live preview of the capture session. Presentation only; the preview layer
/// never receives a copy of the pixel data that leaves this process.
private struct CameraPreview: UIViewRepresentable {
    let session: AVCaptureSession

    func makeUIView(context: Context) -> PreviewView {
        let view = PreviewView()
        view.previewLayer.session = session
        view.previewLayer.videoGravity = .resizeAspectFill
        return view
    }

    func updateUIView(_ uiView: PreviewView, context: Context) {
        uiView.previewLayer.session = session
    }

    final class PreviewView: UIView {
        override static var layerClass: AnyClass { AVCaptureVideoPreviewLayer.self }

        var previewLayer: AVCaptureVideoPreviewLayer {
            guard let layer = layer as? AVCaptureVideoPreviewLayer else {
                preconditionFailure("PreviewView must be backed by AVCaptureVideoPreviewLayer")
            }
            return layer
        }
    }
}
