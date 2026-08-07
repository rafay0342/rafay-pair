import SwiftUI

struct AuthenticationView: View {
    @Bindable var store: SessionStore
    @State private var mode: Mode = .signIn
    @State private var email = ""
    @State private var password = ""
    @State private var displayName = ""

    private enum Mode: String, CaseIterable, Identifiable {
        case signIn = "Sign in"
        case register = "Create account"
        var id: String { rawValue }
    }

    private var isValid: Bool {
        email.contains("@") && password.count >= 12
            && (mode == .signIn || !displayName.trimmingCharacters(in: .whitespaces).isEmpty)
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 26) {
                    VStack(spacing: 10) {
                        Image(systemName: "heart.circle.fill")
                            .font(.system(size: 64, weight: .semibold))
                            .symbolRenderingMode(.palette)
                            .foregroundStyle(Brand.coral, Brand.plum)
                            .accessibilityHidden(true)
                        Text("Care, together")
                            .font(.largeTitle.bold())
                        Text("A private space for two people to check in, move, and feel present.")
                            .font(.body)
                            .foregroundStyle(.secondary)
                            .multilineTextAlignment(.center)
                            .frame(maxWidth: 430)
                    }

                    RPCard {
                        VStack(spacing: 16) {
                            Picker("Account action", selection: $mode) {
                                ForEach(Mode.allCases) { item in
                                    Text(item.rawValue).tag(item)
                                }
                            }
                            .pickerStyle(.segmented)

                            if mode == .register {
                                TextField("Your name", text: $displayName)
                                    .textContentType(.name)
                                    .textInputAutocapitalization(.words)
                                    .textFieldStyle(.roundedBorder)
                                    .accessibilityLabel("Display name")
                            }

                            TextField("Email", text: $email)
                                .textContentType(.emailAddress)
                                .textInputAutocapitalization(.never)
                                .keyboardType(.emailAddress)
                                .autocorrectionDisabled()
                                .textFieldStyle(.roundedBorder)

                            SecureField("Password", text: $password)
                                .textContentType(mode == .register ? .newPassword : .password)
                                .textFieldStyle(.roundedBorder)

                            if mode == .register {
                                Text("Use at least 12 characters. Passwords are never stored in plain text.")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                            }

                            Button {
                                Task {
                                    if mode == .signIn {
                                        await store.login(email: email, password: password)
                                    } else {
                                        await store.register(email: email, password: password, displayName: displayName)
                                    }
                                }
                            } label: {
                                HStack {
                                    if store.isSubmitting { ProgressView().tint(.white) }
                                    Text(mode.rawValue)
                                }
                            }
                            .rpPrimaryButton()
                            .disabled(!isValid || store.isSubmitting)
                            .accessibilityHint(
                                isValid ? "Submits the secure account form" : "Complete all required fields first")
                        }
                    }
                    .frame(maxWidth: 520)

                    Text("RafayPair never lets a partner turn on your camera or microphone.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                }
                .padding(24)
                .frame(maxWidth: .infinity)
            }
            .background(Brand.background.ignoresSafeArea())
            .navigationTitle("RafayPair")
            .navigationBarTitleDisplayMode(.inline)
        }
        .errorAlert(message: $store.errorMessage)
    }
}
