import SwiftUI
import UIKit

struct PairingView: View {
    @EnvironmentObject private var model: AppModel
    @State private var url = ""
    @State private var code = ""

    var body: some View {
        PairingContent(
            url: $url,
            code: $code,
            isBusy: model.isBusy,
            errorMessage: model.pairingErrorMessage,
            pair: { url, code in
                Task { await model.pair(urlText: url, code: code) }
            },
            clearError: model.clearPairingError
        )
    }
}

struct PairingContent: View {
    @Binding var url: String
    @Binding var code: String
    let isBusy: Bool
    let errorMessage: String?
    let pair: (String, String) -> Void
    let clearError: () -> Void

    @FocusState private var focusedField: Field?

    private enum Field {
        case serverAddress
        case pairingCode
    }

    private var input: PairingInput {
        PairingInput(url: url, code: code)
    }

    private var displayedError: String? {
        input.validationError?.errorDescription ?? errorMessage
    }

    private var canPair: Bool {
        input.isPairingEnabled && !isBusy
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 24) {
                    header
                    fields
                    action
                    Text("Create a single-use code with relayctl pair create. The code expires after 10 minutes.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .frame(maxWidth: 560)
                .safeAreaPadding(.horizontal, 24)
                .safeAreaPadding(.vertical, 32)
                .frame(maxWidth: .infinity, minHeight: 620)
            }
            .background { Color.calmCanvas.ignoresSafeArea() }
            .navigationBarTitleDisplayMode(.inline)
        }
    }

    private var header: some View {
        VStack(spacing: 12) {
            RelaySignalMark()
                .frame(width: 64, height: 64)
                .accessibilityHidden(true)
            Text("Relay")
                .font(.largeTitle.weight(.bold))
            Text("Private decisions and progress, delivered from your agent.")
                .font(.body)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Relay. Private decisions and progress, delivered from your agent.")
    }

    private var fields: some View {
        VStack(spacing: 16) {
            VStack(alignment: .leading, spacing: 8) {
                Text("Server address")
                    .font(.headline)
                TextField("https://relay.example.com", text: $url)
                    .textContentType(.URL)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .keyboardType(.URL)
                    .submitLabel(.next)
                    .focused($focusedField, equals: .serverAddress)
                    .onSubmit { focusedField = .pairingCode }
                    .textFieldStyle(.roundedBorder)
                    .accessibilityIdentifier("relay-server-address")
                    .accessibilityHint("Enter the full HTTPS address for your Relay server.")
            }

            VStack(alignment: .leading, spacing: 8) {
                Text("Pairing code")
                    .font(.headline)
                SecureField("8-character pairing code", text: $code)
                    .textInputAutocapitalization(.characters)
                    .autocorrectionDisabled()
                    .fontDesign(.monospaced)
                    .submitLabel(.go)
                    .focused($focusedField, equals: .pairingCode)
                    .onSubmit(submit)
                    .textFieldStyle(.roundedBorder)
                    .accessibilityIdentifier("relay-pairing-code")
                    .accessibilityHint("Enter the eight-character, single-use pairing code.")
            }

            if let displayedError {
                Label(displayedError, systemImage: "exclamationmark.circle")
                    .font(.footnote)
                    .foregroundStyle(.red)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .accessibilityAddTraits(.isStaticText)
                    .accessibilityLabel("Pairing error. \(displayedError)")
                    .onAppear { announce(displayedError) }
                    .onChange(of: displayedError) { _, newValue in
                        announce(newValue)
                    }
            }
        }
        .onChange(of: url) { _, _ in clearError() }
        .onChange(of: code) { _, _ in clearError() }
    }

    private var action: some View {
        Button(action: submit) {
            HStack(spacing: 8) {
                if isBusy { ProgressView() }
                Text(isBusy ? "Pairing…" : "Pair iPhone")
            }
            .frame(maxWidth: .infinity)
        }
        .buttonStyle(.glassProminent)
        .tint(.calmSage)
        .disabled(!canPair)
        .accessibilityHint(canPair ? "Pairs this iPhone with the server." : "Enter a complete HTTPS address and eight-character code to continue.")
    }

    private func submit() {
        guard canPair else { return }
        focusedField = nil
        pair(input.normalizedURL, input.normalizedCode)
    }

    private func announce(_ message: String) {
        UIAccessibility.post(notification: .announcement, argument: "Pairing error. \(message)")
    }
}

private struct PairingPreview: View {
    @State private var url: String
    @State private var code: String
    private let isBusy: Bool
    private let errorMessage: String?

    init(url: String, code: String, isBusy: Bool = false, errorMessage: String? = nil) {
        _url = State(initialValue: url)
        _code = State(initialValue: code)
        self.isBusy = isBusy
        self.errorMessage = errorMessage
    }

    var body: some View {
        PairingContent(
            url: $url,
            code: $code,
            isBusy: isBusy,
            errorMessage: errorMessage,
            pair: { _, _ in },
            clearError: {}
        )
    }
}

#Preview("Idle") {
    PairingPreview(url: "https://relay.example.com", code: "")
}

#Preview("Invalid code") {
    PairingPreview(url: "https://relay.example.com", code: "ABC")
}

#Preview("Server error") {
    PairingPreview(url: "https://relay.example.com", code: "AB12CD34", errorMessage: "The pairing code has expired.")
}

#Preview("Busy") {
    PairingPreview(url: "https://relay.example.com", code: "AB12CD34", isBusy: true)
}
