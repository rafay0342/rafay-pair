import SwiftUI

/// Veins Alive.
///
/// Master specification §8. A vascular network, a contracting heart, a
/// breathing-synchronized chest glow, and the muscles the current exercise
/// works — all driven by values the product already holds.
///
/// The one rule the drawing obeys is the one `VeinsAlive` encodes: with no fresh
/// pulse estimate the network rests. It does not fall back to a comfortable
/// rhythm, and it does not keep beating at whatever it saw last, because a
/// moving picture is the most persuasive way there is to state a number.
struct VeinsAliveView: View {
    var pulseBpm: Double?
    var breathingPhase: BreathingPhase?
    var breathingProgress: Double
    var repetitionsPerMinute: Double?
    var activeMuscles: [MuscleGroup]

    @State private var mode: VeinsMode = .calm

    private var drivers: VeinsDrivers {
        VeinsAlive.drivers(
            for: VeinsInput(
                mode: mode,
                pulseBpm: pulseBpm,
                breathingPhase: breathingPhase,
                breathingProgress: breathingProgress,
                repetitionsPerMinute: repetitionsPerMinute,
                activeMuscles: activeMuscles
            )
        )
    }

    var body: some View {
        RPCard {
            VStack(alignment: .leading, spacing: 12) {
                Label("Veins Alive", systemImage: "waveform.path.ecg")
                    .font(.headline)
                    .foregroundStyle(Brand.plum)

                // The disclosure sits above the picture, not under it. It is the
                // first thing read, because the picture is the persuasive part.
                Text(drivers.disclosure)
                    .font(.subheadline.weight(.semibold))

                Picker("State", selection: $mode) {
                    ForEach(VeinsMode.allCases, id: \.self) { state in
                        Text(state.title).tag(state)
                    }
                }
                .pickerStyle(.segmented)

                TimelineView(.animation) { timeline in
                    Canvas { context, size in
                        draw(
                            in: &context,
                            size: size,
                            drivers: drivers,
                            now: timeline.date.timeIntervalSince1970 * 1000
                        )
                    }
                    .frame(height: 240)
                    .accessibilityHidden(true)
                }

                if drivers.pulseProvenance == .estimated, let bpm = pulseBpm {
                    Text("Beating at your latest estimate, \(Int(bpm.rounded())) bpm.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                } else {
                    // Said in words as well as shown, because stillness alone
                    // could be read as the app being broken.
                    Text("Resting. There is no current pulse estimate to animate.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }

                if !drivers.activeMuscles.isEmpty {
                    Text(
                        "Highlighted: "
                            + drivers.activeMuscles.map(\.rawValue).joined(separator: ", ")
                            + " — the muscles this exercise works, from its definition."
                    )
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
                }
            }
        }
    }

    // MARK: - Drawing

    private func draw(
        in context: inout GraphicsContext,
        size: CGSize,
        drivers: VeinsDrivers,
        now: Double
    ) {
        let centre = CGPoint(x: size.width / 2, y: size.height / 2)
        let torso = CGSize(width: size.width * 0.42, height: size.height * 0.78)

        // Chest glow follows the breath and is absent outside a session.
        if drivers.chestGlow > 0 {
            let radius = torso.width * (0.45 + 0.25 * drivers.chestGlow)
            context.fill(
                Circle().path(
                    in: CGRect(
                        x: centre.x - radius,
                        y: centre.y - radius * 0.9,
                        width: radius * 2,
                        height: radius * 2
                    )
                ),
                with: .radialGradient(
                    Gradient(colors: [
                        Brand.plum.opacity(0.35 * drivers.chestGlow),
                        Brand.plum.opacity(0),
                    ]),
                    center: CGPoint(x: centre.x, y: centre.y - radius * 0.1),
                    startRadius: 0,
                    endRadius: radius
                )
            )
        }

        // The vascular network. Its phase advances only when there is a period
        // to advance it by; at rest the branches are drawn still.
        let phase: Double
        if let period = drivers.contractionPeriodMs {
            phase = (now.truncatingRemainder(dividingBy: period)) / period
        } else {
            phase = 0
        }

        let branches = 7
        for index in 0..<branches {
            let fraction = Double(index) / Double(branches - 1)
            let x = centre.x + CGFloat((fraction - 0.5) * Double(torso.width) * 1.6)
            var path = Path()
            path.move(to: CGPoint(x: centre.x, y: centre.y - torso.height * 0.18))
            path.addCurve(
                to: CGPoint(x: x, y: centre.y + torso.height * 0.42),
                control1: CGPoint(x: centre.x, y: centre.y + torso.height * 0.05),
                control2: CGPoint(x: x, y: centre.y + torso.height * 0.15)
            )

            // A travelling brightness along each branch: pulse propagation, at
            // rest a flat dim line.
            let travel =
                drivers.contractionPeriodMs == nil
                ? 0.0
                : max(0, 1 - abs(((phase + fraction * 0.35).truncatingRemainder(dividingBy: 1)) - 0.5) * 3)
            let brightness = 0.18 + 0.55 * travel * drivers.intensity

            context.stroke(
                path,
                with: .color(Brand.plum.opacity(brightness)),
                lineWidth: 1.5 + 2.5 * travel
            )
        }

        // The heart. It contracts on the beat, and simply sits there when there
        // is nothing current to beat to.
        let contraction =
            drivers.contractionPeriodMs == nil
            ? 0.0
            : max(0, 1 - abs(phase - 0.15) * 6)
        let heartRadius = torso.width * (0.16 + 0.05 * contraction)
        context.fill(
            Circle().path(
                in: CGRect(
                    x: centre.x - heartRadius,
                    y: centre.y - torso.height * 0.18 - heartRadius,
                    width: heartRadius * 2,
                    height: heartRadius * 2
                )
            ),
            with: .color(Brand.plum.opacity(0.35 + 0.4 * contraction))
        )

        // Muscle activation: a mark per group the exercise names, brightened by
        // effort. Nothing is inferred from the body here — the list comes from
        // the exercise definition.
        for (index, muscle) in drivers.activeMuscles.enumerated() {
            let y = centre.y + torso.height * (0.05 + 0.12 * Double(index))
            let rect = CGRect(
                x: centre.x - torso.width * 0.5,
                y: y,
                width: torso.width,
                height: 6
            )
            context.fill(
                RoundedRectangle(cornerRadius: 3).path(in: rect),
                with: .color(Brand.plum.opacity(0.2 + 0.5 * drivers.intensity))
            )
            _ = muscle
        }
    }
}
