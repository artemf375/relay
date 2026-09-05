import Foundation
import RelayCore
import Testing
@testable import Relay

@Test func interactionSubmissionTrackerKeepsPerInteractionOutcomesDistinct() {
    var tracker = InteractionSubmissionTracker()

    tracker.start("int_1", response: .approve)
    #expect(tracker["int_1"] == .sending)

    tracker.finish("int_1", response: .approve, disposition: .queued)
    #expect(tracker["int_1"] == .queued)

    tracker.start("int_3", response: .yes)
    tracker.finish("int_3", response: .yes, disposition: .recorded)
    #expect(tracker["int_3"] == .recorded)

    tracker.start("int_2", response: .deny)
    tracker.fail("int_2", response: .deny, message: "Queue unavailable")
    #expect(tracker["int_2"] == .failed("Queue unavailable"))
    #expect(tracker["int_1"] == .queued)
}

@Test func interactionSubmissionTrackerClearsOnlyDurablyRecordedTerminalOutcomes() throws {
    let interactions = try RelayJSONDecoder.make().decode(
        [InboxInteraction].self,
        from: Data(
            #"""
            [
              {"id":"pending","title":"Pending","prompt":"Ready?","kind":"approval","status":"pending","response":null,"expiresAt":"2026-08-07T10:00:00.000Z","createdAt":"2026-08-07T09:00:00.000Z"},
              {"id":"terminal","title":"Done","prompt":"Ready?","kind":"approval","status":"approved","response":"approve","expiresAt":"2026-08-07T10:00:00.000Z","createdAt":"2026-08-07T09:00:00.000Z"},
              {"id":"recorded","title":"Recorded","prompt":"Continue?","kind":"yes_no","status":"yes","response":"yes","expiresAt":"2026-08-07T10:00:00.000Z","createdAt":"2026-08-07T09:00:00.000Z"}
            ]
            """#.utf8
        )
    )
    var tracker = InteractionSubmissionTracker()
    tracker.start("pending", response: .approve)
    tracker.finish("pending", response: .approve, disposition: .queued)
    tracker.start("terminal", response: .approve)
    tracker.fail("terminal", response: .approve, message: "Could not update the durable queue")
    tracker.start("recorded", response: .yes)
    tracker.finish("recorded", response: .yes, disposition: .recorded)

    tracker.removeTerminalInteractions(in: interactions)

    #expect(tracker["pending"] == .queued)
    #expect(tracker["terminal"] == .failed("Could not update the durable queue"))
    #expect(tracker["recorded"] == .idle)
}

@Test func interactionSubmissionTrackerIgnoresOlderCompletionForCompetingResponse() {
    var tracker = InteractionSubmissionTracker()
    tracker.start("int_1", response: .approve)
    tracker.start("int_1", response: .deny)

    tracker.finish("int_1", response: .approve, disposition: .recorded)

    #expect(tracker["int_1"] == .sending)
}
