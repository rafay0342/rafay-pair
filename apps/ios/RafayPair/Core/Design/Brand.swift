import SwiftUI

enum Brand {
    static let plum = Color(red: 0.33, green: 0.10, blue: 0.28)
    static let coral = Color(red: 0.93, green: 0.26, blue: 0.48)
    static let peach = Color(red: 1.00, green: 0.64, blue: 0.48)
    static let mint = Color(red: 0.24, green: 0.71, blue: 0.61)
    static let ink = Color(red: 0.11, green: 0.07, blue: 0.12)

    static var background: LinearGradient {
        LinearGradient(
            colors: [Color(.systemBackground), coral.opacity(0.08), plum.opacity(0.06)],
            startPoint: .topLeading,
            endPoint: .bottomTrailing
        )
    }
}

struct RPCard<Content: View>: View {
    @ViewBuilder let content: Content

    var body: some View {
        content
            .padding(18)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: 22, style: .continuous)
                    .strokeBorder(Color.primary.opacity(0.07))
            }
    }
}

struct RPPrimaryButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.headline)
            .foregroundStyle(.white)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 14)
            .background(
                LinearGradient(
                    colors: [Brand.coral, Brand.plum],
                    startPoint: .leading,
                    endPoint: .trailing
                ),
                in: RoundedRectangle(cornerRadius: 15, style: .continuous)
            )
            .opacity(configuration.isPressed ? 0.82 : 1)
            .scaleEffect(configuration.isPressed ? 0.99 : 1)
    }
}

extension View {
    func rpPrimaryButton() -> some View {
        buttonStyle(RPPrimaryButtonStyle())
    }

    func errorAlert(message: Binding<String?>) -> some View {
        alert(
            "Something needs attention",
            isPresented: Binding(
                get: { message.wrappedValue != nil },
                set: { if !$0 { message.wrappedValue = nil } }
            ),
            actions: {
                Button("OK", role: .cancel) { message.wrappedValue = nil }
            },
            message: {
                Text(message.wrappedValue ?? "Please try again.")
            }
        )
    }
}
