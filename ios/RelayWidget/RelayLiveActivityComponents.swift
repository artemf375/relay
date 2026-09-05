import ActivityKit
import AppIntents
import RelayCore
import SwiftUI

struct RelayTaskActivityView: View {
    let state: RelayActivityAttributes.ContentState
    let isStale: Bool
    let showsStatus: Bool

    init(
        state: RelayActivityAttributes.ContentState,
        isStale: Bool,
        showsStatus: Bool = true
    ) {
        self.state = state
        self.isStale = isStale
        self.showsStatus = showsStatus
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(state.status)
                .font(.subheadline.weight(.semibold))
                .lineLimit(2)
            if showsStatus {
                RelayActivityStatusView(state: state, isStale: isStale)
            }
            if let detail = state.detail {
                Text(detail)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }
            ProgressView(value: state.progress)
                .tint(taskProgressColor(for: state, isStale: isStale))
                .accessibilityLabel(progressAccessibilityLabel(state.progress))
        }
        .accessibilityElement(children: .combine)
    }
}

struct RelayCheckpointActivityView: View {
    let checkpoint: LiveActivityCheckpoint
    let showsStatus: Bool

    init(checkpoint: LiveActivityCheckpoint, showsStatus: Bool = true) {
        self.checkpoint = checkpoint
        self.showsStatus = showsStatus
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            if showsStatus {
                RelayActivityStatusView(style: .checkpoint)
            }
            Text(checkpoint.prompt)
                .font(.subheadline.weight(.semibold))
                .lineLimit(3)
                .accessibilityLabel("Relay asks: \(checkpoint.prompt)")
            Text(checkpoint.expiresAt, style: .relative)
                .font(.caption.monospacedDigit())
                .foregroundStyle(.secondary)
                .accessibilityLabel("Response expires \(checkpoint.expiresAt.formatted(.relative(presentation: .named)))")
            HStack(spacing: 10) {
                switch checkpoint.kind {
                case .approval:
                    actionButton("Approve", systemImage: "checkmark", action: .approve, tint: .green)
                    actionButton("Deny", systemImage: "xmark", action: .deny, tint: .red)
                case .yesNo:
                    actionButton("Yes", systemImage: "checkmark", action: .yes, tint: .green)
                    actionButton("No", systemImage: "xmark", action: .no, tint: .red)
                }
            }
        }
    }

    @ViewBuilder
    private func actionButton(
        _ title: String,
        systemImage: String,
        action: LiveActivityInteractionAction,
        tint: Color
    ) -> some View {
        let isExpired = checkpoint.expiresAt <= .now
        let accessibility = checkpointActionAccessibility(
            title: title,
            prompt: checkpoint.prompt,
            isExpired: isExpired
        )
        let button = Button(intent: RelayLiveActivityResponseIntent(
            interactionID: checkpoint.interactionID,
            action: action
        )) {
            Label(title, systemImage: systemImage)
                .frame(maxWidth: .infinity)
        }
        .buttonStyle(.borderedProminent)
        .tint(tint)
        .disabled(isExpired)
        .accessibilityLabel(accessibility.label)

        if let hint = accessibility.hint {
            button.accessibilityHint(hint)
        } else {
            button
        }
    }
}

struct RelayAcknowledgedActivityView: View {
    let state: RelayActivityAttributes.ContentState
    let showsStatus: Bool

    init(state: RelayActivityAttributes.ContentState, showsStatus: Bool = true) {
        self.state = state
        self.showsStatus = showsStatus
    }

    private var result: LiveActivityCheckpointResult? {
        state.checkpoint?.result
    }

    private var contentAccessibilityLabel: String? {
        if let result {
            return acknowledgedContentAccessibilityLabel(
                result: result,
                detail: state.detail,
                resultAnnouncedByHeader: !showsStatus
            )
        }
        if showsStatus {
            guard let detail = state.detail, !detail.isEmpty else { return state.status }
            return "\(state.status). \(detail)"
        }
        return state.detail
    }

    var body: some View {
        let content = VStack(alignment: .leading, spacing: 6) {
            if showsStatus {
                RelayActivityStatusView(style: result.map(CalmSignalActivityStyle.acknowledged) ?? .acknowledged(.approve))
            }
            Text(result?.label ?? state.status)
                .font(.headline)
            if let detail = state.detail {
                Text(detail)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }
        }

        if let contentAccessibilityLabel {
            content
                .accessibilityElement(children: .ignore)
                .accessibilityLabel(contentAccessibilityLabel)
        } else {
            content.accessibilityHidden(true)
        }
    }
}

struct RelayActivityStatusView: View {
    let style: CalmSignalActivityStyle

    init(state: RelayActivityAttributes.ContentState, isStale: Bool) {
        style = state.calmActivityStyle(isStale: isStale)
    }

    init(style: CalmSignalActivityStyle) {
        self.style = style
    }

    var body: some View {
        Label(style.label, systemImage: style.symbol)
            .font(.caption.weight(.semibold))
            .foregroundStyle(style.tone.color)
            .lineLimit(1)
            .accessibilityLabel(style.label)
    }
}

func progressLabel(_ progress: Double) -> String {
    compactProgressLabel(progress)
}

func taskProgressColor(for state: RelayActivityAttributes.ContentState, isStale: Bool) -> Color {
    let style = state.calmActivityStyle(isStale: isStale)
    guard style == .task else { return style.tone.color }
    return Color(taskAccent: .parse(state.accentColor))
}

func activityKeylineColor(for state: RelayActivityAttributes.ContentState, isStale: Bool) -> Color {
    taskProgressColor(for: state, isStale: isStale)
}

private extension Color {
    init(taskAccent: CalmSignalTaskAccent) {
        switch taskAccent {
        case .calmSage:
            self = .calmSage
        case .rgb(let red, let green, let blue):
            self.init(
                red: Double(red) / 255,
                green: Double(green) / 255,
                blue: Double(blue) / 255
            )
        }
    }
}
