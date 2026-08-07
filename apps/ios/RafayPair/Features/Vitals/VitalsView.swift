import SwiftUI

/// Pulse measurement, the living heart, and guided breathing.
///
/// Every physiological number on this screen is labelled as an estimate, and
/// blood pressure is stated as unsupported rather than quietly absent.
struct VitalsView: View {
    @State private var store = VitalsStore()
    @State private var capture = PulseCaptureSession()
    @State private var breathAudio = BreathAudioCaptureSession()

    private let tick = Timer.publish(every: 1, on: .main, in: .common).autoconnect()

    var body: some View {
        ScrollView {
            VStack(spacing: 18) {
                heartCard
                measureCard
                breathingCard
                bloodPressureCard
            }
            .padding(18)
        }
        .background(Brand.background.ignoresSafeArea())
        .navigationTitle("Vitals")
        .onReceive(tick) { store.now = $0 }
        .onDisappear {
            capture.stop()
            breathAudio.stop()
            store.cancelMeasurement()
        }
    }

    // MARK: - Living heart

    private var heartCard: some View {
        RPCard {
            VStack(spacing: 12) {
                LivingHeartView(bpm: store.animatedBpm)
                if let pulse = store.latestPulse {
                    if store.pulseIsFresh {
                        Text("\(Int(pulse.bpm.rounded())) BPM")
                            .font(.system(size: 40, weight: .bold, design: .rounded))
                            .monospacedDigit()
                        Text("Estimated from your phone camera · \(pulse.confidenceBand.rawValue) confidence")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                            .multilineTextAlignment(.center)
                    } else {
                        // Master specification §4: never keep animating an old
                        // rate as if it remains current.
                        Text("Last pulse: \(Int(pulse.bpm.rounded())) BPM")
                            .font(.title3.weight(.semibold))
                        Text(ageDescription)
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                } else {
                    Text("No pulse measured yet")
                        .font(.headline)
                    Text("The heart follows your latest camera measurement. Until then it rests.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                }
                Text("Sensor-driven visualization — not a medical scan.")
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
            }
            .frame(maxWidth: .infinity)
        }
    }

    private var ageDescription: String {
        let seconds = store.pulseAgeSeconds
        if seconds < 120 { return "Measured \(seconds) seconds ago" }
        return "Measured \(seconds / 60) minutes ago"
    }

    // MARK: - Measurement

    private var measureCard: some View {
        RPCard {
            VStack(alignment: .leading, spacing: 12) {
                Label("Measure your pulse", systemImage: "hand.point.up.left.fill")
                    .font(.headline)
                    .foregroundStyle(Brand.plum)
                Text(
                    "Cover the rear camera and torch with your fingertip. Rest your hand and stay still for about twenty seconds."
                )
                .foregroundStyle(.secondary)

                if store.phase == .measuring {
                    ProgressView(value: capture.progress)
                    Text(
                        capture.fingerDetected
                            ? "Finger detected — keep still."
                            : "Cover the camera and torch completely."
                    )
                    .font(.footnote)
                    .foregroundStyle(capture.fingerDetected ? .secondary : Color.orange)
                }

                if let reason = store.lastRejection {
                    Text(store.guidance(for: reason))
                        .font(.footnote)
                        .foregroundStyle(Color.orange)
                }

                switch capture.state {
                case .denied:
                    Text("Camera access is off. Enable it in Settings to measure.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                case .unavailable(let reason):
                    Text(reason).font(.footnote).foregroundStyle(.secondary)
                default:
                    EmptyView()
                }

                Button {
                    Task { await toggleMeasurement() }
                } label: {
                    Label(
                        store.phase == .measuring ? "Stop" : "Measure",
                        systemImage: store.phase == .measuring ? "stop.fill" : "waveform.path.ecg"
                    )
                    .frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)

                Text(
                    "This is an estimate from your phone's camera, not a medical measurement."
                )
                .font(.caption2)
                .foregroundStyle(.tertiary)
            }
        }
    }

    private func toggleMeasurement() async {
        if store.phase == .measuring {
            let samples = capture.samples
            capture.stop()
            store.finishMeasurement(samples: samples)
        } else {
            store.beginMeasurement()
            await capture.start()
            if capture.state != .measuring { store.cancelMeasurement() }
        }
    }

    // MARK: - Guided breathing

    private var breathingCard: some View {
        RPCard {
            VStack(alignment: .leading, spacing: 12) {
                Label("Guided breathing", systemImage: "wind")
                    .font(.headline)
                    .foregroundStyle(Brand.plum)

                if let phase = store.breathingPhase, phase.phase != .complete {
                    Text(breathingLabel(phase.phase))
                        .font(.title2.weight(.semibold))
                    ProgressView(value: phase.progress)
                    Text("Cycle \(phase.cycleIndex + 1) of \(store.breathingPattern.cycles)")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                    if store.listenForBreathing {
                        Text(
                            breathAudio.audible
                                ? "Listening — breathe normally."
                                : "Listening. Hold the phone a little closer."
                        )
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                    }
                    Button("Stop") { stopBreathingSession() }
                        .buttonStyle(.bordered)
                } else {
                    Text(
                        "A paced breath with a longer exhale. Nothing is measured — this is only a rhythm to follow."
                    )
                    .foregroundStyle(.secondary)
                    Toggle(
                        "Also estimate my breathing rate from sound",
                        isOn: $store.listenForBreathing
                    )
                    .font(.footnote)
                    Text(
                        "Audio becomes a few numbers as it arrives and is never recorded, stored, or sent anywhere."
                    )
                    .font(.caption2)
                    .foregroundStyle(.tertiary)

                    HStack {
                        Button("Calm") { startBreathingSession(.calm(cycles: 6)) }
                        Button("Box") { startBreathingSession(.box(cycles: 5)) }
                        Button("Relax") { startBreathingSession(.relax(cycles: 4)) }
                    }
                    .buttonStyle(.bordered)

                    if let estimate = store.breathingEstimate {
                        Text(
                            "Estimated \(estimate.breathsPerMinute, specifier: "%.1f") breaths per minute"
                        )
                        .font(.subheadline.weight(.semibold))
                        Text(
                            "From sound on this phone · \(estimate.confidenceBand.rawValue) confidence"
                        )
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                    } else if let reason = store.breathingRejection {
                        Text(store.guidance(for: reason))
                            .font(.footnote)
                            .foregroundStyle(Color.orange)
                    }
                    if case .denied = breathAudio.state {
                        Text("Microphone access is off. Enable it in Settings to listen.")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                    if case .unavailable(let reason) = breathAudio.state {
                        Text(reason).font(.footnote).foregroundStyle(.secondary)
                    }
                }
            }
        }
    }

    private func startBreathingSession(_ pattern: BreathingPattern) {
        store.startBreathing(pattern)
        if store.listenForBreathing {
            Task { await breathAudio.start() }
        }
    }

    private func stopBreathingSession() {
        let hops = breathAudio.hops
        breathAudio.stop()
        store.stopBreathing()
        if !hops.isEmpty { store.finishListening(hops: hops) }
    }

    private func breathingLabel(_ phase: BreathingPhase) -> String {
        switch phase {
        case .inhale: "Breathe in"
        case .hold: "Hold"
        case .exhale: "Breathe out"
        case .holdAfter: "Rest"
        case .complete: "Done"
        }
    }

    // MARK: - Blood pressure policy

    private var bloodPressureCard: some View {
        RPCard {
            VStack(alignment: .leading, spacing: 8) {
                Label("Blood pressure", systemImage: "cross.case.fill")
                    .font(.headline)
                    .foregroundStyle(Brand.plum)
                Text(
                    "RafayPair does not estimate blood pressure. A phone camera cannot measure it, and no amount of processing changes that."
                )
                .foregroundStyle(.secondary)
                Text(
                    "If you track it, enter a reading from a real cuff or import it from Health — those are the only sources this app accepts."
                )
                .font(.footnote)
                .foregroundStyle(.secondary)
            }
        }
    }
}

/// The heart orb. Animates at the supplied rate, and rests when there is no
/// current reading — never at a remembered one.
private struct LivingHeartView: View {
    let bpm: Double?
    @State private var pulsing = false

    private var beatDuration: Double {
        guard let bpm, bpm > 0 else { return 0 }
        return 60 / bpm
    }

    var body: some View {
        ZStack {
            Circle()
                .fill(Brand.plum.opacity(0.12))
                .frame(width: 132, height: 132)
                .scaleEffect(pulsing ? 1.12 : 1)
            Image(systemName: "heart.fill")
                .font(.system(size: 54))
                .foregroundStyle(Brand.plum)
                .scaleEffect(pulsing ? 1.1 : 1)
        }
        .animation(
            bpm == nil
                ? nil
                : .easeInOut(duration: beatDuration / 2).repeatForever(autoreverses: true),
            value: pulsing
        )
        .onAppear { pulsing = bpm != nil }
        .onChange(of: bpm) { _, newValue in pulsing = newValue != nil }
        .accessibilityLabel(
            bpm == nil
                ? "Heart visualization, resting"
                : "Heart visualization beating at the latest estimated rate"
        )
    }
}
