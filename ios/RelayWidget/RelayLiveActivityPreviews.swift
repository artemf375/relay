import ActivityKit
import RelayCore
import SwiftUI
import WidgetKit

@MainActor private let previewAttributes = RelayActivityAttributes(
    relayActivityId: "preview",
    title: "Relay task"
)

@MainActor private let longTitlePreviewAttributes = RelayActivityAttributes(
    relayActivityId: "preview-long-title",
    title: "Verify the complete Relay Live Activity presentation across every compact and expanded state"
)

#Preview("Task at 42%", as: .content, using: previewAttributes) {
    RelayLiveActivityWidget()
} contentStates: {
    RelayActivityAttributes.ContentState(
        status: "Building the Relay update",
        detail: "Verifying the iOS target",
        progress: 0.42,
        symbol: "build",
        accentColor: "#5ED8B7",
        sequence: 1,
        isEnded: false
    )
}

#Preview("Stale task") {
    RelayTaskActivityView(state: staleTaskState(), isStale: true)
}

#Preview("Ended task", as: .content, using: previewAttributes) {
    RelayLiveActivityWidget()
} contentStates: {
    RelayActivityAttributes.ContentState(
        status: "Release complete",
        detail: "Relay is ready.",
        progress: 1,
        symbol: "success",
        accentColor: "#5ED8B7",
        sequence: 3,
        isEnded: true
    )
}

#Preview("Approval checkpoint", as: .content, using: previewAttributes) {
    RelayLiveActivityWidget()
} contentStates: {
    RelayActivityAttributes.ContentState(
        status: "Approval required",
        detail: nil,
        progress: 0.42,
        symbol: "warning",
        accentColor: "#5ED8B7",
        sequence: 4,
        isEnded: false,
        presentation: .checkpoint,
        checkpoint: previewCheckpoint(kind: .approval)
    )
}

#Preview("Yes or no checkpoint", as: .content, using: previewAttributes) {
    RelayLiveActivityWidget()
} contentStates: {
    RelayActivityAttributes.ContentState(
        status: "Decision required",
        detail: nil,
        progress: 0.42,
        symbol: "warning",
        accentColor: "#5ED8B7",
        sequence: 5,
        isEnded: false,
        presentation: .checkpoint,
        checkpoint: previewCheckpoint(kind: .yesNo)
    )
}

#Preview("Acknowledged result", as: .content, using: previewAttributes) {
    RelayLiveActivityWidget()
} contentStates: {
    RelayActivityAttributes.ContentState(
        status: "Approved",
        detail: "Relay recorded your response.",
        progress: 0.42,
        symbol: "success",
        accentColor: "#5ED8B7",
        sequence: 6,
        isEnded: false,
        presentation: .acknowledged,
        checkpoint: previewCheckpoint(kind: .approval, result: .approve)
    )
}

#Preview("Dynamic Island compact task 0%", as: .dynamicIsland(.compact), using: previewAttributes) {
    RelayLiveActivityWidget()
} contentStates: {
    taskPreviewState(progress: 0, sequence: 7)
}

#Preview("Dynamic Island compact task 100%", as: .dynamicIsland(.compact), using: previewAttributes) {
    RelayLiveActivityWidget()
} contentStates: {
    taskPreviewState(progress: 1, sequence: 8)
}

#Preview("Dynamic Island minimal task", as: .dynamicIsland(.minimal), using: previewAttributes) {
    RelayLiveActivityWidget()
} contentStates: {
    taskPreviewState(progress: 0.42, sequence: 9)
}

#Preview("Dynamic Island expanded long title", as: .dynamicIsland(.expanded), using: longTitlePreviewAttributes) {
    RelayLiveActivityWidget()
} contentStates: {
    taskPreviewState(progress: 0.42, sequence: 10)
}

private func previewCheckpoint(
    kind: LiveActivityCheckpointKind,
    result: LiveActivityCheckpointResult? = nil
) -> LiveActivityCheckpoint {
    LiveActivityCheckpoint(
        interactionID: "preview-interaction",
        kind: kind,
        prompt: kind == .approval ? "Publish the verified update?" : "Continue with the next step?",
        expiresAt: .now.addingTimeInterval(300),
        result: result
    )
}

@MainActor private func staleTaskState() -> RelayActivityAttributes.ContentState {
    RelayActivityAttributes.ContentState(
        status: "Waiting for a remote update",
        detail: "Relay will refresh when the task reports progress.",
        progress: 0.42,
        symbol: "build",
        accentColor: "invalid",
        sequence: 2,
        isEnded: false
    )
}

@MainActor private func taskPreviewState(
    progress: Double,
    sequence: Int
) -> RelayActivityAttributes.ContentState {
    RelayActivityAttributes.ContentState(
        status: "Building the Relay update",
        detail: "Verifying the iOS target",
        progress: progress,
        symbol: "build",
        accentColor: "#5ED8B7",
        sequence: sequence,
        isEnded: false
    )
}
