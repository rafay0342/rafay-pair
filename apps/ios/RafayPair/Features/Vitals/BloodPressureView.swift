import SwiftUI

/// Blood pressure the user brings.
///
/// Master specification §5: a phone is not a blood-pressure instrument, so
/// nothing here estimates one. What it does is hold a reading taken with a real
/// cuff — refusing to store it would not make anyone safer, it would just send
/// them to a notes app — and keep the origin attached to every reading shown.
struct BloodPressureView: View {
    let repository: any BloodPressureRepository

    @State private var readings: [BloodPressureReading] = []
    @State private var systolic = ""
    @State private var diastolic = ""
    @State private var pulse = ""
    @State private var note = ""
    @State private var busy = false
    @State private var errorMessage: String?

    var body: some View {
        RPCard {
            VStack(alignment: .leading, spacing: 12) {
                Label("Blood pressure", systemImage: "cross.case.fill")
                    .font(.headline)
                    .foregroundStyle(Brand.plum)

                Text(
                    "RafayPair does not estimate blood pressure. A phone camera cannot measure it, and no amount of processing changes that."
                )
                .foregroundStyle(.secondary)
                Text("What you can keep here is a reading from a real cuff.")
                    .font(.subheadline.weight(.semibold))

                if let errorMessage {
                    Text(errorMessage).foregroundStyle(Color.orange)
                }

                HStack(spacing: 10) {
                    numberField("Systolic", text: $systolic, placeholder: "118")
                    numberField("Diastolic", text: $diastolic, placeholder: "76")
                }
                numberField("Pulse on the cuff (optional)", text: $pulse, placeholder: "64")

                TextField("Note (optional)", text: $note)
                    .textFieldStyle(.roundedBorder)

                Button("Save reading") { Task { await save() } }
                    .buttonStyle(.borderedProminent)
                    .disabled(busy || !entryIsComplete)

                Text(
                    "Yours alone. There is no consent switch for blood pressure because there is no partner surface for it."
                )
                .font(.caption2)
                .foregroundStyle(.tertiary)

                ForEach(readings) { reading in
                    row(reading)
                }
            }
        }
        .task { await reload() }
    }

    private var entryIsComplete: Bool {
        Int(systolic) != nil && Int(diastolic) != nil
    }

    private func numberField(
        _ title: String,
        text: Binding<String>,
        placeholder: String
    ) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(title).font(.caption).foregroundStyle(.secondary)
            TextField(placeholder, text: text)
                .keyboardType(.numberPad)
                .textFieldStyle(.roundedBorder)
        }
    }

    @ViewBuilder
    private func row(_ reading: BloodPressureReading) -> some View {
        HStack(alignment: .top) {
            VStack(alignment: .leading, spacing: 2) {
                Text("\(reading.systolic)/\(reading.diastolic)")
                    .font(.headline)
                HStack(spacing: 6) {
                    if let pulseBpm = reading.pulseBpm {
                        Text("\(pulseBpm) bpm")
                    }
                    // The origin travels with the reading, always. A cuff's
                    // pulse is never merged with the camera estimate either.
                    Text(
                        reading.source == .manualEntry
                            ? "entered by you"
                            : "from \(reading.externalOrigin ?? "a health record")"
                    )
                    Text(reading.measuredAt, style: .date)
                }
                .font(.caption2)
                .foregroundStyle(.tertiary)
            }
            Spacer()
            Button("Delete") { Task { await delete(reading.id) } }
                .font(.footnote)
                .disabled(busy)
        }
    }

    private func reload() async {
        do {
            readings = try await repository.readings().readings
            errorMessage = nil
        } catch {
            errorMessage = "Could not load your readings."
        }
    }

    private func save() async {
        guard let systolicValue = Int(systolic), let diastolicValue = Int(diastolic) else {
            return
        }
        busy = true
        defer { busy = false }
        do {
            _ = try await repository.record(
                RecordBloodPressureRequest(
                    systolic: systolicValue,
                    diastolic: diastolicValue,
                    pulseBpm: Int(pulse),
                    measuredAt: Date(),
                    note: note.trimmingCharacters(in: .whitespaces).isEmpty ? nil : note
                )
            )
            systolic = ""
            diastolic = ""
            pulse = ""
            note = ""
            await reload()
        } catch {
            // The server range-checks too; this is the message a person can act on.
            errorMessage = "That reading was not accepted. Check the numbers."
        }
    }

    private func delete(_ id: UUID) async {
        busy = true
        defer { busy = false }
        try? await repository.delete(id: id)
        await reload()
    }
}
