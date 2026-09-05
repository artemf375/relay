import ActivityKit
import Foundation
import RelayCore

public struct RelayActivityAttributes: ActivityAttributes {
    public struct ContentState: Codable, Hashable {
        public let status: String
        public let detail: String?
        public let progress: Double
        public let symbol: String
        public let accentColor: String
        public let sequence: Int
        public let isEnded: Bool
        public let presentation: LiveActivityPresentation?
        public let checkpoint: LiveActivityCheckpoint?

        public init(
            status: String,
            detail: String?,
            progress: Double,
            symbol: String,
            accentColor: String,
            sequence: Int,
            isEnded: Bool,
            presentation: LiveActivityPresentation? = .task,
            checkpoint: LiveActivityCheckpoint? = nil
        ) {
            self.status = status
            self.detail = detail
            self.progress = progress
            self.symbol = symbol
            self.accentColor = accentColor
            self.sequence = sequence
            self.isEnded = isEnded
            self.presentation = presentation
            self.checkpoint = checkpoint
        }

        public var effectivePresentation: LiveActivityPresentation { presentation ?? .task }

        public func acknowledging(_ result: LiveActivityCheckpointResult) -> Self {
            let acknowledgedCheckpoint = checkpoint.map {
                LiveActivityCheckpoint(
                    interactionID: $0.interactionID,
                    kind: $0.kind,
                    prompt: $0.prompt,
                    expiresAt: $0.expiresAt,
                    result: result
                )
            }
            return Self(
                status: result.label,
                detail: detail,
                progress: progress,
                symbol: symbol,
                accentColor: accentColor,
                sequence: sequence,
                isEnded: isEnded,
                presentation: .acknowledged,
                checkpoint: acknowledgedCheckpoint
            )
        }
    }

    public let relayActivityId: String
    public let title: String
}
