import SwiftUI
import RelayCore

enum CalmSignalTone: Equatable {
    case neutral
    case primary
    case success
    case warning
    case destructive
    case unavailable

    var color: Color {
        switch self {
        case .neutral, .unavailable:
            .secondary
        case .primary:
            .calmSage
        case .success:
            .green
        case .warning:
            .orange
        case .destructive:
            .red
        }
    }
}

enum CalmSignalStatusStyle {
    case pending
    case recorded
    case queued
    case failed
    case unavailable

    var symbol: String {
        switch self {
        case .pending: "hourglass"
        case .recorded: "checkmark.circle.fill"
        case .queued: "arrow.triangle.2.circlepath"
        case .failed: "exclamationmark.triangle.fill"
        case .unavailable: "wifi.slash"
        }
    }

    var label: String {
        switch self {
        case .pending: "Waiting"
        case .recorded: "Recorded"
        case .queued: "Queued"
        case .failed: "Failed"
        case .unavailable: "Unavailable"
        }
    }

    var tone: CalmSignalTone {
        switch self {
        case .pending: .neutral
        case .recorded: .success
        case .queued: .primary
        case .failed: .destructive
        case .unavailable: .unavailable
        }
    }
}

enum CalmSignalActivityStyle: Equatable {
    case task
    case stale
    case ended
    case checkpoint
    case acknowledged(LiveActivityCheckpointResult)

    var symbol: String {
        switch self {
        case .task: "ellipsis.circle.fill"
        case .stale: "clock.badge.exclamationmark"
        case .ended: "checkmark.circle.fill"
        case .checkpoint: "questionmark.circle.fill"
        case .acknowledged(let result):
            switch result {
            case .approve, .yes: "checkmark.circle.fill"
            case .deny, .no, .canceled: "xmark.circle.fill"
            case .expired: "clock.badge.exclamationmark"
            }
        }
    }

    var label: String {
        switch self {
        case .task: "In progress"
        case .stale: "Update delayed"
        case .ended: "Complete"
        case .checkpoint: "Response needed"
        case .acknowledged(let result): result.label
        }
    }

    var tone: CalmSignalTone {
        switch self {
        case .task: .primary
        case .stale, .checkpoint: .warning
        case .ended: .success
        case .acknowledged(let result):
            switch result {
            case .approve, .yes: .success
            case .deny, .no, .canceled: .destructive
            case .expired: .warning
            }
        }
    }

    func dynamicIslandAccessibilityLabel(progress: Double?) -> String {
        guard case .task = self, let progress else { return label }
        return "\(label), \(compactProgressLabel(progress)) complete"
    }
}

enum CalmSignalTaskAccent: Equatable {
    case calmSage
    case rgb(red: UInt8, green: UInt8, blue: UInt8)

    static func parse(_ hex: String) -> Self {
        let digits = hex.hasPrefix("#") ? String(hex.dropFirst()) : hex
        guard digits.utf8.count == 6,
              digits.utf8.allSatisfy({ byte in
                  (48...57).contains(byte) || (65...70).contains(byte) || (97...102).contains(byte)
              }),
              let value = UInt64(digits, radix: 16) else { return .calmSage }
        return .rgb(
            red: UInt8((value >> 16) & 0xff),
            green: UInt8((value >> 8) & 0xff),
            blue: UInt8(value & 0xff)
        )
    }
}

func compactProgressLabel(_ progress: Double) -> String {
    "\(Int((min(max(progress, 0), 1) * 100).rounded()))%"
}

func progressAccessibilityLabel(_ progress: Double) -> String {
    "Progress \(compactProgressLabel(progress))"
}

func acknowledgedContentAccessibilityLabel(
    result: LiveActivityCheckpointResult,
    detail: String?,
    resultAnnouncedByHeader: Bool
) -> String? {
    if resultAnnouncedByHeader {
        guard let detail, !detail.isEmpty else { return nil }
        return detail
    }
    guard let detail, !detail.isEmpty else { return result.label }
    return "\(result.label). \(detail)"
}

struct CheckpointActionAccessibility: Equatable {
    let label: String
    let hint: String?
}

func checkpointActionAccessibility(
    title: String,
    prompt: String,
    isExpired: Bool
) -> CheckpointActionAccessibility {
    CheckpointActionAccessibility(
        label: "\(title): \(prompt)",
        hint: isExpired ? "This interaction expired. \(title) is unavailable." : nil
    )
}

extension RelayActivityAttributes.ContentState {
    func calmActivityStyle(isStale: Bool) -> CalmSignalActivityStyle {
        switch effectivePresentation {
        case .checkpoint:
            .checkpoint
        case .acknowledged:
            .acknowledged(checkpoint?.result ?? .approve)
        case .task:
            if isEnded { .ended }
            else if isStale { .stale }
            else { .task }
        }
    }
}

extension Color {
    static let calmSage = Color("CalmSage")
    static let calmCanvas = Color("CalmCanvas")
    static let calmCard = Color("CalmCard")
    static let calmStone = Color("CalmStone")
}
