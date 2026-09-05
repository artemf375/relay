import RelayCore
import SwiftUI

enum InteractionCardControlsState: Equatable {
    case hidden
    case enabled
    case disabled
}

struct InteractionCardPresentation: Equatable {
    let statusSymbol: String
    let statusCopy: String
    let controlsState: InteractionCardControlsState
    let tone: CalmSignalTone

    init(interaction: InboxInteraction, submissionState: InteractionSubmissionState) {
        guard interaction.status == .pending else {
            statusSymbol = interaction.statusSymbol
            statusCopy = interaction.status.label
            controlsState = .hidden
            tone = interaction.status == .expired ? .warning : .neutral
            return
        }

        if case .unsupported = interaction.kind {
            statusSymbol = "questionmark.circle"
            statusCopy = "Update Relay to answer this prompt."
            controlsState = .hidden
            tone = .unavailable
            return
        }

        switch submissionState {
        case .idle:
            statusSymbol = "hourglass"
            statusCopy = "Waiting"
            controlsState = .enabled
            tone = .neutral
        case .sending:
            statusSymbol = "arrow.triangle.2.circlepath"
            statusCopy = "Sending…"
            controlsState = .disabled
            tone = .primary
        case .queued:
            statusSymbol = "arrow.triangle.2.circlepath"
            statusCopy = "Queued for retry"
            controlsState = .disabled
            tone = .primary
        case .recorded:
            statusSymbol = "checkmark.circle.fill"
            statusCopy = "Response recorded"
            controlsState = .hidden
            tone = .success
        case .failed:
            statusSymbol = "exclamationmark.triangle.fill"
            statusCopy = "Couldn't send your reply. Try again."
            controlsState = .enabled
            tone = .destructive
        }
    }

    var controlsVisible: Bool { controlsState != .hidden }
    var actionsEnabled: Bool { controlsState == .enabled }
    var isRecorded: Bool { tone == .success }
}

struct InteractionCard: View {
    let interaction: InboxInteraction
    let submissionState: InteractionSubmissionState
    @Binding var reply: String
    let onRespond: (InteractionResponse) -> Void

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency

    private var presentation: InteractionCardPresentation {
        InteractionCardPresentation(interaction: interaction, submissionState: submissionState)
    }

    var body: some View {
        cardSurface {
            VStack(alignment: .leading, spacing: 14) {
                header
                Text(interaction.prompt)
                    .font(.body)
                    .fixedSize(horizontal: false, vertical: true)

                if interaction.status == .pending {
                    Text("Expires \(interaction.expiresAt, style: .relative)")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }

                statusLabel

                if presentation.controlsVisible {
                    controls.disabled(!presentation.actionsEnabled)
                }
            }
            .padding(18)
        }
        .sensoryFeedback(.success, trigger: presentation.isRecorded) { oldValue, newValue in
            !oldValue && newValue
        }
    }

    private var header: some View {
        Label {
            Text(interaction.title)
                .font(.headline)
        } icon: {
            Image(systemName: presentation.statusSymbol)
                .foregroundStyle(presentation.tone.color)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(interaction.title). \(presentation.statusCopy)")
    }

    @ViewBuilder private var statusLabel: some View {
        if reduceMotion {
            statusLabelContent
        } else {
            statusLabelContent
                .symbolEffect(.pulse, value: presentation.statusSymbol)
        }
    }

    private var statusLabelContent: some View {
        Label(presentation.statusCopy, systemImage: presentation.statusSymbol)
            .font(.footnote.weight(.semibold))
            .foregroundStyle(presentation.tone.color)
            .accessibilityLabel("Status. \(presentation.statusCopy)")
    }

    @ViewBuilder private var controls: some View {
        switch interaction.kind {
        case .approval:
            ViewThatFits(in: .horizontal) {
                HStack(spacing: 12) {
                    responseButton("Approve", style: .prominent, response: .approve)
                    responseButton("Deny", style: .destructive, response: .deny)
                }
                VStack(alignment: .leading, spacing: 12) {
                    responseButton("Approve", style: .prominent, response: .approve)
                    responseButton("Deny", style: .destructive, response: .deny)
                }
            }
        case .yesNo:
            ViewThatFits(in: .horizontal) {
                HStack(spacing: 12) {
                    responseButton("Yes", style: .prominent, response: .yes)
                    responseButton("No", style: .neutral, response: .no)
                }
                VStack(alignment: .leading, spacing: 12) {
                    responseButton("Yes", style: .prominent, response: .yes)
                    responseButton("No", style: .neutral, response: .no)
                }
            }
        case .text:
            TextField("Short reply", text: $reply, axis: .vertical)
                .textFieldStyle(.roundedBorder)
                .lineLimit(1...5)
                .accessibilityHint("Enter a short response to this Relay prompt.")
            sendButton
        case .unsupported:
            EmptyView()
        }
    }

    private var trimmedReply: String {
        reply.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private enum ResponseButtonStyle { case prominent, destructive, neutral }

    @ViewBuilder private func responseButton(
        _ title: String,
        style: ResponseButtonStyle,
        response: InteractionResponse
    ) -> some View {
        if style == .prominent {
            if reduceTransparency {
                Button(title) { onRespond(response) }
                    .buttonStyle(.borderedProminent)
                    .tint(.calmSage)
                    .frame(minHeight: 44)
                    .contentShape(.rect)
                    .accessibilityHint("Responds \(title.lowercased()) to this Relay prompt.")
            } else {
                Button(title) { onRespond(response) }
                    .buttonStyle(.glassProminent)
                    .tint(.calmSage)
                    .frame(minHeight: 44)
                    .contentShape(.rect)
                    .accessibilityHint("Responds \(title.lowercased()) to this Relay prompt.")
            }
        } else {
            Button(title, role: style == .destructive ? .destructive : nil) { onRespond(response) }
                .buttonStyle(.bordered)
                .frame(minHeight: 44)
                .contentShape(.rect)
                .accessibilityHint("Responds \(title.lowercased()) to this Relay prompt.")
        }
    }

    @ViewBuilder private var sendButton: some View {
        if reduceTransparency {
            Button("Send") { onRespond(.reply(trimmedReply)) }
                .buttonStyle(.borderedProminent)
                .tint(.calmSage)
                .frame(minHeight: 44)
                .contentShape(.rect)
                .disabled(trimmedReply.isEmpty)
                .accessibilityHint(trimmedReply.isEmpty ? "Enter a reply before sending." : "Sends this reply to Relay.")
        } else {
            Button("Send") { onRespond(.reply(trimmedReply)) }
                .buttonStyle(.glassProminent)
                .tint(.calmSage)
                .frame(minHeight: 44)
                .contentShape(.rect)
                .disabled(trimmedReply.isEmpty)
                .accessibilityHint(trimmedReply.isEmpty ? "Enter a reply before sending." : "Sends this reply to Relay.")
        }
    }

    private func cardSurface<Content: View>(@ViewBuilder content: () -> Content) -> some View {
        let shape = RoundedRectangle(cornerRadius: 20, style: .continuous)
        return content()
            .background(Color.calmCard, in: shape)
    }
}

#Preview("Approval") {
    InteractionCardPreview(kind: "approval", status: "pending", submissionState: .idle)
}

#Preview("Sending") {
    InteractionCardPreview(kind: "approval", status: "pending", submissionState: .sending)
}

#Preview("Queued") {
    InteractionCardPreview(kind: "yes_no", status: "pending", submissionState: .queued)
}

#Preview("Yes or no") {
    InteractionCardPreview(kind: "yes_no", status: "pending", submissionState: .idle)
}

#Preview("Failed") {
    InteractionCardPreview(kind: "approval", status: "pending", submissionState: .failed("The queue is unavailable."))
}

#Preview("Text prompt") {
    InteractionCardPreview(kind: "text", status: "pending", submissionState: .idle)
}

#Preview("Completed") {
    InteractionCardPreview(kind: "approval", status: "approved", submissionState: .idle)
}

#Preview("Expired") {
    InteractionCardPreview(kind: "approval", status: "expired", submissionState: .idle)
}

#Preview("Unsupported") {
    InteractionCardPreview(kind: "future_kind", status: "pending", submissionState: .idle)
}

private struct InteractionCardPreview: View {
    @State private var reply = ""
    let kind: String
    let status: String
    let submissionState: InteractionSubmissionState

    var body: some View {
        InteractionCard(
            interaction: try! RelayJSONDecoder.make().decode(InboxInteraction.self, from: Data("""
            {"id":"preview","title":"Release decision","prompt":"Publish the verified Relay update?","kind":"\(kind)","status":"\(status)","response":null,"expiresAt":"2026-08-07T16:00:00.000Z","createdAt":"2026-08-07T15:00:00.000Z"}
            """.utf8)),
            submissionState: submissionState,
            reply: $reply,
            onRespond: { _ in }
        )
        .padding()
        .background(Color.calmCanvas)
    }
}
