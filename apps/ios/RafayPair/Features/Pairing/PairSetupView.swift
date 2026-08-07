import SwiftUI

struct PairSetupView: View {
    @Bindable var store: PairStore
    @State private var joinCode = ""

    var body: some View {
        RPCard {
            VStack(alignment: .leading, spacing: 18) {
                VStack(alignment: .leading, spacing: 6) {
                    Label("Connect with one person", systemImage: "link.circle.fill")
                        .font(.title3.bold())
                    Text(
                        "Create a short-lived code or enter the code your partner shared. Pairing never grants health or sensor access by itself."
                    )
                    .foregroundStyle(.secondary)
                }

                Button {
                    Task { await store.create() }
                } label: {
                    HStack {
                        if store.isMutating { ProgressView().tint(.white) }
                        Text("Create pairing code")
                    }
                }
                .rpPrimaryButton()
                .disabled(store.isMutating)

                HStack {
                    Rectangle().fill(Color.secondary.opacity(0.2)).frame(height: 1)
                    Text("or").font(.caption).foregroundStyle(.secondary)
                    Rectangle().fill(Color.secondary.opacity(0.2)).frame(height: 1)
                }

                TextField("Pairing code", text: $joinCode)
                    .textInputAutocapitalization(.characters)
                    .autocorrectionDisabled()
                    .font(.system(.body, design: .monospaced))
                    .textFieldStyle(.roundedBorder)
                    .onChange(of: joinCode) { _, value in
                        joinCode = String(value.uppercased().filter { $0.isLetter || $0.isNumber }.prefix(12))
                    }

                Button("Join pair") {
                    Task { await store.join(code: joinCode) }
                }
                .buttonStyle(.borderedProminent)
                .frame(maxWidth: .infinity, alignment: .trailing)
                .disabled(store.isMutating || joinCode.count < 6)
            }
        }
    }
}
