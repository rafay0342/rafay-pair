import Foundation

/// The speech gate.
///
/// `engines/speech-gate/SPEC.md` is normative. It decides, on the device and
/// before anything is transmitted, whether a frame is the person holding the
/// phone or the rest of the room.
///
/// It is near-field gating, not speaker identification: it distinguishes close
/// from far, not this person from that person. Someone else speaking directly
/// into the same phone will pass it.
enum SpeechGateTuning {
    static let floorFall = 0.2
    static let floorRise = 0.002
    static let floorMinimum = 0.0008
    static let openRatio = 6.0
    static let closeRatio = 3.0
    static let nearMinimum = 0.01
    static let hangoverFrames = 12
}

struct GateDecision: Sendable, Equatable {
    /// What the caller acts on: send this frame, or drop it.
    var transmit: Bool
    var open: Bool
    var rms: Double
    var floor: Double
}

/// Stateful across a session, because the floor is a memory of the room.
///
/// One instance per voice session. Reusing one would carry the previous room's
/// noise into a new one.
final class SpeechGate {
    private var floor = SpeechGateTuning.floorMinimum
    private var isOpen = false
    private var hangover = 0

    /// Root-mean-square amplitude of one PCM16 frame, normalised to `0...1`.
    static func rms(of samples: UnsafePointer<Int16>, count: Int) -> Double {
        guard count > 0 else { return 0 }
        var total = 0.0
        for index in 0..<count {
            let normalised = Double(samples[index]) / 32768
            total += normalised * normalised
        }
        return (total / Double(count)).squareRoot()
    }

    /// Every frame must be offered, including ones that are not transmitted.
    func accept(rms: Double) -> GateDecision {
        // The floor falls quickly and rises slowly. A floor that rose quickly
        // would climb during speech until the speaker no longer cleared it, and
        // the gate would close mid-sentence.
        let rate = rms < floor ? SpeechGateTuning.floorFall : SpeechGateTuning.floorRise
        floor = max(SpeechGateTuning.floorMinimum, floor + (rms - floor) * rate)

        let openLevel = max(floor * SpeechGateTuning.openRatio, SpeechGateTuning.nearMinimum)
        let closeLevel = floor * SpeechGateTuning.closeRatio

        if !isOpen {
            // Opening is harder than staying open, which is how a human
            // listener works too, and is what stops a voice at the boundary
            // from chopping a sentence into fragments.
            if rms >= openLevel {
                isOpen = true
                hangover = SpeechGateTuning.hangoverFrames
            }
        } else if rms >= closeLevel {
            hangover = SpeechGateTuning.hangoverFrames
        } else {
            hangover -= 1
            if hangover <= 0 { isOpen = false }
        }

        return GateDecision(transmit: isOpen, open: isOpen, rms: rms, floor: floor)
    }

    func reset() {
        floor = SpeechGateTuning.floorMinimum
        isOpen = false
        hangover = 0
    }
}
