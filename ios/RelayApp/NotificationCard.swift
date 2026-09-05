import RelayCore
import SwiftUI

struct NotificationCard: View {
    let notification: InboxNotification

    var body: some View {
        cardSurface {
            VStack(alignment: .leading, spacing: 12) {
                Text(notification.title)
                    .font(.headline)
                Text(notification.body)
                    .font(.body)
                    .fixedSize(horizontal: false, vertical: true)

                if let url = safeURL {
                    Link("Open link", destination: url)
                        .frame(minHeight: 44)
                        .contentShape(.rect)
                        .accessibilityHint("Opens the related secure link.")
                }

                HStack {
                    Label(statusCopy, systemImage: statusSymbol)
                    Spacer(minLength: 12)
                    Text(notification.createdAt, style: .relative)
                }
                .font(.footnote)
                .foregroundStyle(.secondary)
                .accessibilityElement(children: .combine)
                .accessibilityLabel("\(statusCopy). \(notification.createdAt.formatted(.relative(presentation: .named)))")
            }
            .padding(18)
        }
    }

    private var safeURL: URL? {
        guard notification.url?.scheme?.lowercased() == "https" else { return nil }
        return notification.url
    }

    private var statusCopy: String {
        switch notification.status.lowercased() {
        case "delivered": "Delivered to this iPhone"
        case "failed": "Delivery was not confirmed"
        default: "Relay notification"
        }
    }

    private var statusSymbol: String {
        notification.status.lowercased() == "failed" ? "exclamationmark.triangle.fill" : "bell.badge.fill"
    }

    private func cardSurface<Content: View>(@ViewBuilder content: () -> Content) -> some View {
        let shape = RoundedRectangle(cornerRadius: 20, style: .continuous)
        return content()
            .background(Color.calmCard, in: shape)
    }
}

#Preview("Notification") {
    NotificationCard(
        notification: try! RelayJSONDecoder.make().decode(InboxNotification.self, from: Data(#"""
        {"id":"preview","title":"Verification finished","body":"The Relay update is ready for review.","url":"https://relay.example.com","status":"delivered","createdAt":"2026-08-07T15:00:00.000Z"}
        """#.utf8))
    )
    .padding()
    .background(Color.calmCanvas)
}
