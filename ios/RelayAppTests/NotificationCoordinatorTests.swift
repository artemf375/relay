import Foundation
import RelayCore
import Testing
@testable import Relay

private final class CoordinatorQueueStorage: ResponseQueueStorage {
    enum Failure: Error { case save }

    var responses: [PendingResponse] = []
    var failOnSaveCall: Int?
    private var saveCallCount = 0

    func load() throws -> [PendingResponse] { responses }

    func save(_ responses: [PendingResponse]) throws {
        saveCallCount += 1
        if saveCallCount == failOnSaveCall { throw Failure.save }
        self.responses = responses
    }
}

@Suite(.serialized)
@MainActor
struct NotificationCoordinatorTests {
    @Test func durableRemovalFailureDoesNotReportRecorded() async throws {
        let storage = CoordinatorQueueStorage()
        let queue = try ResponseQueue(storage: storage)
        let coordinator = NotificationCoordinator(queue: queue) { pending in .response(pending.response) }
        storage.failOnSaveCall = 2

        await #expect(throws: ResponseFlushPersistenceError.self) {
            _ = try await coordinator.handleInbox(interactionID: "int_1", response: .approve)
        }
        #expect(queue.pending == [PendingResponse(interactionID: "int_1", response: .approve)])
    }

    @Test func competingSubmissionIsNotRecordedAsTheRequestedResponse() async throws {
        let storage = CoordinatorQueueStorage()
        let queue = try ResponseQueue(storage: storage)
        try queue.enqueue(PendingResponse(interactionID: "int_1", response: .approve))
        let coordinator = NotificationCoordinator(queue: queue) { _ in .response(.approve) }

        await #expect(throws: NotificationCoordinatorError.self) {
            _ = try await coordinator.handleInbox(interactionID: "int_1", response: .deny)
        }
        #expect(queue.pending.isEmpty)
    }

    @Test func sameQueuedResponseWithDifferentServerWinnerIsRemovedButNotRecorded() async throws {
        let storage = CoordinatorQueueStorage()
        let queue = try ResponseQueue(storage: storage)
        let coordinator = NotificationCoordinator(queue: queue) { _ in .response(.deny) }

        await #expect(throws: NotificationCoordinatorError.self) {
            _ = try await coordinator.handleInbox(interactionID: "int_1", response: .approve)
        }
        #expect(queue.pending.isEmpty)
    }

    @Test(arguments: [RelayInteractionTerminalOutcome.canceled, .expired])
    func canceledOrExpiredServerTerminalIsRemovedButNotRecorded(
        outcome: RelayInteractionTerminalOutcome
    ) async throws {
        let storage = CoordinatorQueueStorage()
        let queue = try ResponseQueue(storage: storage)
        let coordinator = NotificationCoordinator(queue: queue) { _ in outcome }

        await #expect(throws: NotificationCoordinatorError.self) {
            _ = try await coordinator.handleInbox(interactionID: "int_1", response: .approve)
        }
        #expect(queue.pending.isEmpty)
    }
}
