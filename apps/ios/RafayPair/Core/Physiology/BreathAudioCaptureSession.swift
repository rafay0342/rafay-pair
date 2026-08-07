import AVFoundation

/// Supplies a captured buffer to `AVAudioConverter` exactly once.
///
/// The converter calls its input block synchronously during `convert`, so no
/// concurrent access is possible; the box makes that transfer explicit.
private final class ConverterFeed: @unchecked Sendable {
    private let buffer: AVAudioPCMBuffer
    private var supplied = false

    init(buffer: AVAudioPCMBuffer) {
        self.buffer = buffer
    }

    func next(status: UnsafeMutablePointer<AVAudioConverterInputStatus>) -> AVAudioPCMBuffer? {
        if supplied {
            status.pointee = .noDataNow
            return nil
        }
        supplied = true
        status.pointee = .haveData
        return buffer
    }
}

/// Microphone capture for breathing rhythm.
///
/// Audio is consumed inside the tap callback, converted to the three per-hop
/// scalars the estimator needs, and released. Nothing writes audio to disk, no
/// encoder is instantiated, and no audio buffer crosses a network boundary — the
/// only thing that leaves this type is a `[AudioHopFeature]`, from which no
/// intelligible content is reconstructible.
///
/// It runs only during an explicit breathing session the user started. There is
/// no background listening.
@MainActor
@Observable
final class BreathAudioCaptureSession {
    enum State: Equatable {
        case idle
        case denied
        case unavailable(String)
        case listening
    }

    private(set) var state: State = .idle
    /// Features collected in the current session. Reset on each start.
    private(set) var hops: [AudioHopFeature] = []
    /// Rolling audibility so the interface can say "a little closer" while the
    /// session is still running.
    private(set) var audible = false

    private let engine = AVAudioEngine()
    private var converter: AVAudioConverter?
    private var elapsedMs: Double = 0
    /// Samples left over from the previous buffer, so hop boundaries stay exact
    /// across callbacks rather than resetting at each one.
    private var carry: [Double] = []

    func start() async {
        guard state != .listening else { return }
        hops = []
        audible = false
        elapsedMs = 0
        carry = []

        guard await Self.requestMicrophoneAccess() else {
            state = .denied
            return
        }

        let session = AVAudioSession.sharedInstance()
        do {
            // `.record` rather than `.playAndRecord`: nothing is played back, and
            // the narrower category makes that visible to the system too.
            try session.setCategory(.record, mode: .measurement, options: [])
            try session.setActive(true)
        } catch {
            state = .unavailable("The microphone could not be opened.")
            return
        }

        let input = engine.inputNode
        let inputFormat = input.outputFormat(forBus: 0)
        guard inputFormat.sampleRate > 0,
            let target = AVAudioFormat(
                commonFormat: .pcmFormatFloat32,
                sampleRate: PhysiologyTuning.audioSampleRateHz,
                channels: 1,
                interleaved: false
            ),
            let converter = AVAudioConverter(from: inputFormat, to: target)
        else {
            state = .unavailable("This device's microphone format is unsupported.")
            return
        }
        self.converter = converter

        input.installTap(onBus: 0, bufferSize: 4096, format: inputFormat) {
            [weak self] buffer, _ in
            guard let self else { return }
            let samples = Self.resampleToMono16k(buffer, using: converter, target: target)
            guard !samples.isEmpty else { return }
            Task { @MainActor [weak self] in
                self?.consume(samples)
            }
            // `buffer` goes out of scope here. Nothing retains it, nothing
            // encodes it, and nothing transmits it.
        }

        do {
            engine.prepare()
            try engine.start()
        } catch {
            input.removeTap(onBus: 0)
            state = .unavailable("The microphone could not be started.")
            return
        }
        state = .listening
    }

    func stop() {
        guard state == .listening else { return }
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
        converter = nil
        try? AVAudioSession.sharedInstance().setActive(
            false, options: .notifyOthersOnDeactivation
        )
        state = .idle
    }

    /// Appends whole hops and keeps the remainder for the next buffer, so hop
    /// boundaries follow the session clock rather than the audio callback size.
    private func consume(_ samples: [Double]) {
        guard state == .listening else { return }
        carry.append(contentsOf: samples)

        let hopSamples = PhysiologyTuning.audioHopSamples
        let whole = carry.count / hopSamples
        guard whole > 0 else { return }

        let consumed = Array(carry.prefix(whole * hopSamples))
        carry.removeFirst(whole * hopSamples)

        let produced = AudioBreathingEstimator.extractHops(
            consumed, startTimestampMs: elapsedMs
        )
        elapsedMs +=
            Double(whole * hopSamples) * 1000 / PhysiologyTuning.audioSampleRateHz
        hops.append(contentsOf: produced)
        if let last = produced.last {
            audible = AudioBreathingEstimator.isHopUsable(last)
        }
    }

    private static func requestMicrophoneAccess() async -> Bool {
        await withCheckedContinuation { continuation in
            AVAudioApplication.requestRecordPermission { granted in
                continuation.resume(returning: granted)
            }
        }
    }

    /// Converts a captured buffer to mono 16 kHz floats.
    nonisolated private static func resampleToMono16k(
        _ buffer: AVAudioPCMBuffer,
        using converter: AVAudioConverter,
        target: AVAudioFormat
    ) -> [Double] {
        let ratio = target.sampleRate / buffer.format.sampleRate
        let capacity = AVAudioFrameCount(Double(buffer.frameLength) * ratio) + 1
        guard
            let output = AVAudioPCMBuffer(pcmFormat: target, frameCapacity: capacity)
        else { return [] }

        // `AVAudioConverter` invokes its input block synchronously, on this
        // thread, exactly while `convert` runs. Swift cannot prove that, so the
        // one-shot state and the non-Sendable buffer are handed over through a
        // single named box rather than by relaxing concurrency checking for all
        // of AVFAudio.
        let feed = ConverterFeed(buffer: buffer)
        var error: NSError?
        converter.convert(to: output, error: &error) { _, status in
            feed.next(status: status)
        }
        guard error == nil, let channel = output.floatChannelData?[0] else { return [] }

        var samples: [Double] = []
        samples.reserveCapacity(Int(output.frameLength))
        for index in 0..<Int(output.frameLength) {
            samples.append(Double(channel[index]))
        }
        return samples
    }
}
