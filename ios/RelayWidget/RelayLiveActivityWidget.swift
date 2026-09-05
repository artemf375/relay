import ActivityKit
import AppIntents
import RelayCore
import SwiftUI
import WidgetKit

struct RelayLiveActivityWidget: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: RelayActivityAttributes.self) { context in
            VStack(alignment: .leading, spacing: 10) {
                HStack {
                    Image(systemName: context.state.calmActivityStyle(isStale: context.isStale).symbol)
                        .foregroundStyle(context.state.calmActivityStyle(isStale: context.isStale).tone.color)
                        .accessibilityHidden(true)
                    Text(context.attributes.title)
                        .font(.headline)
                        .lineLimit(1)
                        .truncationMode(.tail)
                        .minimumScaleFactor(0.8)
                    Spacer()
                    RelayActivityStatusView(state: context.state, isStale: context.isStale)
                }
                activityContent(context: context)
            }
            .padding()
            .activityBackgroundTint(.calmCanvas)
            .activitySystemActionForegroundColor(.calmSage)
        } dynamicIsland: { context in
            DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    Image(systemName: context.state.calmActivityStyle(isStale: context.isStale).symbol)
                        .foregroundStyle(context.state.calmActivityStyle(isStale: context.isStale).tone.color)
                        .accessibilityHidden(true)
                }
                DynamicIslandExpandedRegion(.trailing) {
                    RelayActivityStatusView(state: context.state, isStale: context.isStale)
                }
                DynamicIslandExpandedRegion(.center) {
                    Text(context.attributes.title)
                        .font(.headline)
                        .lineLimit(1)
                        .truncationMode(.tail)
                        .minimumScaleFactor(0.8)
                }
                DynamicIslandExpandedRegion(.bottom) {
                    activityContent(context: context)
                }
            } compactLeading: {
                Image(systemName: context.state.calmActivityStyle(isStale: context.isStale).symbol)
                    .foregroundStyle(context.state.calmActivityStyle(isStale: context.isStale).tone.color)
                    .accessibilityHidden(true)
            } compactTrailing: {
                if context.state.effectivePresentation == .task {
                    Text(progressLabel(context.state.progress))
                        .font(.caption.monospacedDigit())
                        .frame(width: 34, alignment: .trailing)
                        .lineLimit(1)
                        .fixedSize(horizontal: true, vertical: false)
                        .accessibilityLabel(context.state.calmActivityStyle(isStale: context.isStale).dynamicIslandAccessibilityLabel(progress: context.state.progress))
                } else {
                    Image(systemName: context.state.calmActivityStyle(isStale: context.isStale).symbol)
                        .accessibilityLabel(context.state.calmActivityStyle(isStale: context.isStale).dynamicIslandAccessibilityLabel(progress: nil))
                }
            } minimal: {
                Image(systemName: context.state.calmActivityStyle(isStale: context.isStale).symbol)
                    .foregroundStyle(context.state.calmActivityStyle(isStale: context.isStale).tone.color)
                    .accessibilityLabel(context.state.calmActivityStyle(isStale: context.isStale).dynamicIslandAccessibilityLabel(progress: nil))
            }
            .keylineTint(activityKeylineColor(for: context.state, isStale: context.isStale))
        }
    }

    @ViewBuilder
    private func activityContent(context: ActivityViewContext<RelayActivityAttributes>) -> some View {
        switch context.state.effectivePresentation {
        case .checkpoint:
            if let checkpoint = context.state.checkpoint {
                RelayCheckpointActivityView(checkpoint: checkpoint, showsStatus: false)
            } else {
                RelayTaskActivityView(state: context.state, isStale: context.isStale, showsStatus: false)
            }
        case .acknowledged:
            RelayAcknowledgedActivityView(state: context.state, showsStatus: false)
        case .task:
            RelayTaskActivityView(state: context.state, isStale: context.isStale, showsStatus: false)
        }
    }
}
