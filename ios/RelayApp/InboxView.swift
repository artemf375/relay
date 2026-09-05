import RelayCore
import SwiftUI
import UIKit

struct InboxView: View {
    @EnvironmentObject private var model: AppModel
    @State private var replies: [String: String] = [:]
    @State private var isShowingUnpairConfirmation = false
    @State private var activityPendingEnd: RelayActivity?

    private var presentation: InboxPresentation {
        InboxPresentation(interactions: model.interactions, notifications: model.notifications)
    }

    private var isEmpty: Bool {
        model.interactions.isEmpty && model.notifications.isEmpty && model.activities.isEmpty
    }

    private var earlierItems: [EarlierItem] {
        (presentation.earlierInteractions.map(EarlierItem.interaction)
            + presentation.notifications.map(EarlierItem.notification)
        ).sorted { $0.createdAt > $1.createdAt }
    }

    var body: some View {
        NavigationStack {
            inboxContent
            .background { Color.calmCanvas.ignoresSafeArea() }
            .navigationTitle("Inbox")
            .toolbar { unpairMenu }
            .confirmationDialog(
                "Unpair this iPhone?",
                isPresented: $isShowingUnpairConfirmation,
                titleVisibility: .visible
            ) {
                Button("Unpair", role: .destructive) { Task { await model.unpair() } }
                    .disabled(model.isUnpairing)
                Button("Cancel", role: .cancel) {}
            } message: {
                Text("This removes this phone’s Relay access, saved credential, and pending local replies.")
            }
            .alert("Unable to unpair", isPresented: Binding(
                get: { model.unpairErrorMessage != nil },
                set: { if !$0 { model.clearUnpairError() } }
            )) {
                Button("OK", role: .cancel) {}
            } message: {
                Text(model.unpairErrorMessage ?? "")
            }
            .confirmationDialog(
                "End Live Activity?",
                isPresented: Binding(
                    get: { activityPendingEnd != nil },
                    set: { if !$0 { activityPendingEnd = nil } }
                ),
                titleVisibility: .visible
            ) {
                if let activity = activityPendingEnd {
                    Button("End \(activity.title)", role: .destructive) {
                        activityPendingEnd = nil
                        Task { await model.endActivity(activity) }
                    }
                }
                Button("Cancel", role: .cancel) { activityPendingEnd = nil }
            } message: {
                Text("This stops the Live Activity on your iPhone. The agent keeps running.")
            }
            .task { await model.becameActive() }
        }
    }

    private var inboxContent: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 14) {
                if isEmpty {
                    emptyState
                } else {
                    if let error = model.inboxErrorMessage { refreshErrorBanner(error) }
                    if model.notificationAuthorizationState == .denied { permissionBanner }

                    if !model.activities.isEmpty {
                        section("Live Activities") {
                            ForEach(model.activities) { activity in
                                LiveActivityCard(
                                    activity: activity,
                                    isEnding: model.endingActivityIDs.contains(activity.id),
                                    onEnd: { activityPendingEnd = activity }
                                )
                            }
                        }
                    }

                    if !presentation.waiting.isEmpty {
                        section("Waiting for you") {
                            ForEach(presentation.waiting) { interaction in interactionCard(interaction) }
                        }
                    }

                    if !earlierItems.isEmpty {
                        section("Earlier") {
                            ForEach(earlierItems) { item in
                                switch item {
                                case .interaction(let interaction): interactionCard(interaction)
                                case .notification(let notification): NotificationCard(notification: notification)
                                }
                            }
                        }
                    }
                }
            }
            .frame(maxWidth: 680, alignment: .leading)
            .safeAreaPadding(.horizontal, 16)
            .safeAreaPadding(.vertical, 20)
        }
        .refreshable { await model.refresh() }
    }

    @ViewBuilder private var emptyState: some View {
        VStack(spacing: 16) {
            if model.notificationAuthorizationState == .denied { permissionBanner }
            if let error = model.inboxErrorMessage {
                ContentUnavailableView {
                    Label("Couldn’t refresh Inbox", systemImage: "exclamationmark.triangle")
                } description: {
                    Text(error)
                } actions: {
                    Button("Retry") { Task { await model.refresh() } }
                        .buttonStyle(.glassProminent)
                        .tint(.calmSage)
                }
            } else {
                ContentUnavailableView(
                    "All quiet",
                    systemImage: "bell.slash",
                    description: Text("Relay prompts and notifications will appear here.")
                )
            }
        }
    }

    @ToolbarContentBuilder private var unpairMenu: some ToolbarContent {
        ToolbarItem(placement: .topBarTrailing) {
            Menu {
                Button("Unpair", role: .destructive) { isShowingUnpairConfirmation = true }
                    .disabled(model.isUnpairing)
            } label: {
                Image(systemName: "ellipsis.circle")
            }
            .accessibilityLabel("Inbox options")
        }
    }

    private var permissionBanner: some View {
        NotificationPermissionBanner(openSettings: openSettings)
    }

    private func refreshErrorBanner(_ error: String) -> some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: "exclamationmark.triangle.fill")
                .foregroundStyle(.orange)
            VStack(alignment: .leading, spacing: 4) {
                Text("Inbox couldn’t refresh")
                    .font(.headline)
                Text(error)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
            Spacer(minLength: 0)
            Button("Retry") { Task { await model.refresh() } }
                .buttonStyle(.bordered)
                .frame(minHeight: 44)
                .contentShape(.rect)
        }
        .padding(14)
        .background(.orange.opacity(0.14), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .accessibilityElement(children: .combine)
    }

    private func section<Content: View>(_ title: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(title)
                .font(.title3.weight(.semibold))
                .accessibilityAddTraits(.isHeader)
            content()
        }
    }

    private func interactionCard(_ interaction: InboxInteraction) -> some View {
        InteractionCard(
            interaction: interaction,
            submissionState: model.submissionStates[interaction.id] ?? .idle,
            reply: Binding(
                get: { replies[interaction.id] ?? "" },
                set: { replies[interaction.id] = $0 }
            ),
            onRespond: { response in Task { await model.respond(to: interaction, with: response) } }
        )
    }

    private func openSettings() {
        guard let url = URL(string: UIApplication.openSettingsURLString) else { return }
        UIApplication.shared.open(url)
    }

    private enum EarlierItem: Identifiable {
        case interaction(InboxInteraction)
        case notification(InboxNotification)

        var id: String {
            switch self {
            case .interaction(let interaction): "interaction-\(interaction.id)"
            case .notification(let notification): "notification-\(notification.id)"
            }
        }

        var createdAt: Date {
            switch self {
            case .interaction(let interaction): interaction.createdAt
            case .notification(let notification): notification.createdAt
            }
        }
    }
}

private struct LiveActivityCard: View {
    let activity: RelayActivity
    let isEnding: Bool
    let onEnd: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .top, spacing: 12) {
                Image(systemName: "wave.3.right.circle.fill")
                    .font(.title2)
                    .foregroundStyle(Color.calmSage)
                VStack(alignment: .leading, spacing: 3) {
                    Text(activity.title).font(.headline)
                    Text(activity.status).font(.subheadline).foregroundStyle(.secondary)
                }
                Spacer(minLength: 0)
                Button("End", role: .destructive, action: onEnd)
                    .buttonStyle(.bordered)
                    .disabled(isEnding)
            }
            if let detail = activity.detail, !detail.isEmpty {
                Text(detail).font(.footnote).foregroundStyle(.secondary)
            }
            ProgressView(value: activity.progress)
                .tint(.calmSage)
        }
        .padding(16)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
        .accessibilityElement(children: .contain)
    }
}

private struct NotificationPermissionBanner: View {
    let openSettings: () -> Void

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: "bell.slash")
                .foregroundStyle(.orange)
            VStack(alignment: .leading, spacing: 4) {
                Text("Notifications are off")
                    .font(.headline)
                Text("Turn them on to receive Relay prompts when the app is closed.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
            Spacer(minLength: 0)
            Button("Open Settings") { openSettings() }
                .buttonStyle(.bordered)
                .frame(minHeight: 44)
                .contentShape(.rect)
        }
        .padding(14)
        .background(.orange.opacity(0.14), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .accessibilityElement(children: .combine)
    }
}

#Preview("Empty") {
    ContentUnavailableView(
        "All quiet",
        systemImage: "bell.slash",
        description: Text("Relay prompts and notifications will appear here.")
    )
    .background(Color.calmCanvas)
}

#Preview("Load failure") {
    ContentUnavailableView {
        Label("Couldn’t refresh Inbox", systemImage: "exclamationmark.triangle")
    } description: {
        Text("Relay could not reach the server.")
    } actions: {
        Button("Retry") {}
            .buttonStyle(.glassProminent)
            .tint(.calmSage)
    }
    .background(Color.calmCanvas)
}

#Preview("Notifications denied") {
    NotificationPermissionBanner(openSettings: {})
        .padding()
        .background(Color.calmCanvas)
}

#Preview("Unpair dialog") {
    UnpairDialogPreview()
}

private struct UnpairDialogPreview: View {
    @State private var isPresented = true

    var body: some View {
        NavigationStack {
            Text("Inbox")
                .navigationTitle("Inbox")
                .confirmationDialog(
                    "Unpair this iPhone?",
                    isPresented: $isPresented,
                    titleVisibility: .visible
                ) {
                    Button("Unpair", role: .destructive) {}
                    Button("Cancel", role: .cancel) {}
                } message: {
                    Text("This removes this phone’s Relay access, saved credential, and pending local replies.")
                }
        }
    }
}
