import Foundation
import RelayCore
import Testing
@testable import Relay

@Test func inboxPresentationGroupsAndSortsItemsNewestFirst() throws {
    let interactions = try RelayJSONDecoder.make().decode(
        [InboxInteraction].self,
        from: Data(
            #"""
            [
              {"id":"done-old","title":"Done old","prompt":"Done?","kind":"approval","status":"approved","response":"approve","expiresAt":"2026-08-07T10:00:00.000Z","createdAt":"2026-08-07T09:00:00.000Z"},
              {"id":"pending-old","title":"Pending old","prompt":"Ready?","kind":"yes_no","status":"pending","response":null,"expiresAt":"2026-08-07T10:00:00.000Z","createdAt":"2026-08-07T09:15:00.000Z"},
              {"id":"done-new","title":"Done new","prompt":"Later?","kind":"future_kind","status":"future_status","response":null,"expiresAt":"2026-08-07T10:00:00.000Z","createdAt":"2026-08-07T09:45:00.000Z"},
              {"id":"pending-new","title":"Pending new","prompt":"Ship?","kind":"approval","status":"pending","response":null,"expiresAt":"2026-08-07T10:00:00.000Z","createdAt":"2026-08-07T09:30:00.000Z"}
            ]
            """#.utf8
        )
    )
    let notifications = try RelayJSONDecoder.make().decode(
        [InboxNotification].self,
        from: Data(
            #"""
            [
              {"id":"note-old","title":"Old","body":"Earlier","url":null,"status":"delivered","createdAt":"2026-08-07T08:00:00.000Z"},
              {"id":"note-new","title":"New","body":"Latest","url":null,"status":"delivered","createdAt":"2026-08-07T08:30:00.000Z"}
            ]
            """#.utf8
        )
    )

    let presentation = InboxPresentation(interactions: interactions, notifications: notifications)

    #expect(presentation.waiting.map(\.id) == ["pending-new", "pending-old"])
    #expect(presentation.earlierInteractions.map(\.id) == ["done-new", "done-old"])
    #expect(presentation.notifications.map(\.id) == ["note-new", "note-old"])
}

@Test func interactionPresentationDerivesStatusAndActionAvailabilityFromServerValues() throws {
    let interactions = try RelayJSONDecoder.make().decode(
        [InboxInteraction].self,
        from: Data(
            #"""
            [
              {"id":"pending","title":"Pending","prompt":"Ready?","kind":"approval","status":"pending","response":null,"expiresAt":"2026-08-07T10:00:00.000Z","createdAt":"2026-08-07T09:00:00.000Z"},
              {"id":"unsupported-kind","title":"Unknown","prompt":"Ready?","kind":"future_kind","status":"pending","response":null,"expiresAt":"2026-08-07T10:00:00.000Z","createdAt":"2026-08-07T09:00:00.000Z"},
              {"id":"unsupported-status","title":"Future","prompt":"Done?","kind":"approval","status":"future_status","response":null,"expiresAt":"2026-08-07T10:00:00.000Z","createdAt":"2026-08-07T09:00:00.000Z"}
            ]
            """#.utf8
        )
    )

    #expect(interactions[0].statusSymbol == "hourglass")
    #expect(interactions[0].statusLabel == "Waiting")
    #expect(interactions[0].actionsAvailable)
    #expect(!interactions[1].actionsAvailable)
    #expect(interactions[2].statusSymbol == "questionmark.circle")
    #expect(interactions[2].statusLabel == "Future Status")
    #expect(!interactions[2].actionsAvailable)
}

@Test func interactionCardPresentationKeepsSubmissionAndTerminalStatesTruthful() throws {
    let interactions = try RelayJSONDecoder.make().decode(
        [InboxInteraction].self,
        from: Data(
            #"""
            [
              {"id":"approval","title":"Approval","prompt":"Deploy this release?","kind":"approval","status":"pending","response":null,"expiresAt":"2026-08-07T10:00:00.000Z","createdAt":"2026-08-07T09:00:00.000Z"},
              {"id":"approved","title":"Approved","prompt":"Deploy this release?","kind":"approval","status":"approved","response":"approve","expiresAt":"2026-08-07T10:00:00.000Z","createdAt":"2026-08-07T09:00:00.000Z"},
              {"id":"expired","title":"Expired","prompt":"Deploy this release?","kind":"approval","status":"expired","response":null,"expiresAt":"2026-08-07T10:00:00.000Z","createdAt":"2026-08-07T09:00:00.000Z"},
              {"id":"unsupported","title":"Unsupported","prompt":"Deploy this release?","kind":"new_kind","status":"pending","response":null,"expiresAt":"2026-08-07T10:00:00.000Z","createdAt":"2026-08-07T09:00:00.000Z"}
            ]
            """#.utf8
        )
    )

    let cases: [(InboxInteraction, InteractionSubmissionState, InteractionCardControlsState, String)] = [
        (interactions[0], .idle, .enabled, "Waiting"),
        (interactions[0], .sending, .disabled, "Sending…"),
        (interactions[0], .queued, .disabled, "Queued for retry"),
        (interactions[0], .failed("The queue is unavailable."), .enabled, "Couldn't send your reply. Try again."),
        (interactions[1], .idle, .hidden, "Approved"),
        (interactions[2], .idle, .hidden, "Expired"),
        (interactions[3], .idle, .hidden, "Update Relay to answer this prompt.")
    ]

    for (interaction, submissionState, controlsState, statusCopy) in cases {
        let presentation = InteractionCardPresentation(
            interaction: interaction,
            submissionState: submissionState
        )

        #expect(presentation.controlsState == controlsState)
        #expect(presentation.controlsVisible == (controlsState != .hidden))
        #expect(presentation.actionsEnabled == (controlsState == .enabled))
        #expect(presentation.statusCopy == statusCopy)
    }
}
