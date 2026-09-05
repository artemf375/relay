import RelayCore
import Testing
@testable import Relay

@Test func calmSignalStatusStylesDoNotDependOnColorAlone() {
    #expect(CalmSignalStatusStyle.pending.symbol == "hourglass")
    #expect(CalmSignalStatusStyle.pending.label == "Waiting")
    #expect(CalmSignalStatusStyle.recorded.tone == .success)
    #expect(CalmSignalStatusStyle.queued.symbol == "arrow.triangle.2.circlepath")
    #expect(CalmSignalStatusStyle.failed.tone == .destructive)
}

@Test func liveActivityStylesGiveEachPresentationAVisibleMeaning() {
    let styles: [(CalmSignalActivityStyle, String, String, CalmSignalTone)] = [
        (.task, "ellipsis.circle.fill", "In progress", .primary),
        (.stale, "clock.badge.exclamationmark", "Update delayed", .warning),
        (.ended, "checkmark.circle.fill", "Complete", .success),
        (.checkpoint, "questionmark.circle.fill", "Response needed", .warning),
        (.acknowledged(.approve), "checkmark.circle.fill", "Approved", .success),
    ]

    for (style, symbol, label, tone) in styles {
        #expect(style.symbol == symbol)
        #expect(style.label == label)
        #expect(style.tone == tone)
    }
}

@Test func liveActivityDecisionResultsUseSemanticOutcomeStyles() {
    #expect(CalmSignalActivityStyle.acknowledged(.deny).symbol == "xmark.circle.fill")
    #expect(CalmSignalActivityStyle.acknowledged(.deny).tone == .destructive)
    #expect(CalmSignalActivityStyle.acknowledged(.expired).symbol == "clock.badge.exclamationmark")
    #expect(CalmSignalActivityStyle.acknowledged(.expired).tone == .warning)
}

@Test func liveActivityStatesSelectTheirSemanticStyleBeforeAnyServerAccent() {
    let task = RelayActivityAttributes.ContentState(
        status: "Working", detail: nil, progress: 0.42, symbol: "build", accentColor: "invalid", sequence: 1, isEnded: false
    )
    let ended = RelayActivityAttributes.ContentState(
        status: "Done", detail: nil, progress: 1, symbol: "success", accentColor: "#000000", sequence: 2, isEnded: true
    )
    let checkpoint = RelayActivityAttributes.ContentState(
        status: "Respond", detail: nil, progress: 0.42, symbol: "warning", accentColor: "#000000", sequence: 3, isEnded: false, presentation: .checkpoint
    )
    let acknowledged = RelayActivityAttributes.ContentState(
        status: "Approved", detail: nil, progress: 0.42, symbol: "success", accentColor: "#000000", sequence: 4, isEnded: false, presentation: .acknowledged
    )

    #expect(task.calmActivityStyle(isStale: false) == .task)
    #expect(task.calmActivityStyle(isStale: true) == .stale)
    #expect(ended.calmActivityStyle(isStale: false) == .ended)
    #expect(checkpoint.calmActivityStyle(isStale: false) == .checkpoint)
    #expect(acknowledged.calmActivityStyle(isStale: false) == .acknowledged(.approve))
}

@Test func liveActivityStylesProvideStateAccurateDynamicIslandAnnouncements() {
    #expect(CalmSignalActivityStyle.task.dynamicIslandAccessibilityLabel(progress: 0) == "In progress, 0% complete")
    #expect(CalmSignalActivityStyle.task.dynamicIslandAccessibilityLabel(progress: 1) == "In progress, 100% complete")
    #expect(CalmSignalActivityStyle.stale.dynamicIslandAccessibilityLabel(progress: nil) == "Update delayed")
    #expect(CalmSignalActivityStyle.ended.dynamicIslandAccessibilityLabel(progress: nil) == "Complete")
    #expect(CalmSignalActivityStyle.acknowledged(.deny).dynamicIslandAccessibilityLabel(progress: nil) == "Denied")
    #expect(CalmSignalActivityStyle.acknowledged(.canceled).dynamicIslandAccessibilityLabel(progress: nil) == "Canceled")
    #expect(CalmSignalActivityStyle.acknowledged(.expired).dynamicIslandAccessibilityLabel(progress: nil) == "Expired")
}

@Test func invalidTaskAccentFallsBackToCalmSage() {
    #expect(CalmSignalTaskAccent.parse("not-a-color") == .calmSage)
    #expect(CalmSignalTaskAccent.parse("#5ED8B7") == .rgb(red: 0x5e, green: 0xd8, blue: 0xb7))
    #expect(CalmSignalTaskAccent.parse("5ED8B7") == .rgb(red: 0x5e, green: 0xd8, blue: 0xb7))
}

@Test func taskAccentParserRejectsNonHexWhitespaceAndSignedInput() {
    for value in ["+12345", "-1234", " 5ED8B7", "5ED8B7 ", "#１２３４５６"] {
        #expect(CalmSignalTaskAccent.parse(value) == .calmSage)
    }
}

@Test func liveActivityContentAnnouncesProgressAndTheActualTerminalResult() {
    #expect(progressAccessibilityLabel(0.42) == "Progress 42%")
    let results: [(LiveActivityCheckpointResult, String)] = [
        (.approve, "Approved"),
        (.deny, "Denied"),
        (.yes, "Yes"),
        (.no, "No"),
        (.canceled, "Canceled"),
        (.expired, "Expired"),
    ]

    for (result, label) in results {
        #expect(
            acknowledgedContentAccessibilityLabel(
                result: result,
                detail: nil,
                resultAnnouncedByHeader: false
            ) == label
        )
        #expect(
            acknowledgedContentAccessibilityLabel(
                result: result,
                detail: "Response sent to Relay",
                resultAnnouncedByHeader: false
            )
                == "\(label). Response sent to Relay"
        )
        #expect(
            acknowledgedContentAccessibilityLabel(
                result: result,
                detail: nil,
                resultAnnouncedByHeader: true
            ) == nil
        )
        #expect(
            acknowledgedContentAccessibilityLabel(
                result: result,
                detail: "Response sent to Relay",
                resultAnnouncedByHeader: true
            ) == "Response sent to Relay"
        )
    }
}

@Test func liveActivityCheckpointActionsExposeExpiredAvailabilityWithoutChangingTheirLabel() {
    let active = checkpointActionAccessibility(
        title: "Approve",
        prompt: "Deploy this release?",
        isExpired: false
    )
    let expired = checkpointActionAccessibility(
        title: "Approve",
        prompt: "Deploy this release?",
        isExpired: true
    )

    #expect(active.label == "Approve: Deploy this release?")
    #expect(active.hint == nil)
    #expect(expired.label == active.label)
    #expect(expired.hint == "This interaction expired. Approve is unavailable.")
}
