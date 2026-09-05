import XCTest
@testable import RelayCore

private final class MemoryQueueStorage: ResponseQueueStorage {
    enum Failure: Error { case save }

    var responses: [PendingResponse] = []
    var shouldFailSave = false
    func load() throws -> [PendingResponse] { responses }
    func save(_ responses: [PendingResponse]) throws {
        if shouldFailSave { throw Failure.save }
        self.responses = responses
    }
}

final class ResponseQueueTests: XCTestCase {
    func testDeduplicatesAndRemovesOnlySuccessfullySubmittedResponses() throws {
        let storage = MemoryQueueStorage()
        let queue = try ResponseQueue(storage: storage)
        let first = PendingResponse(
            interactionID: "int_1",
            responseCredential: "relay_response_1",
            response: .approve
        )
        let second = PendingResponse(
            interactionID: "int_2",
            responseCredential: "relay_response_2",
            response: .reply("Later")
        )

        try queue.enqueue(first)
        try queue.enqueue(first)
        try queue.enqueue(second)
        XCTAssertEqual(queue.pending.count, 2)

        try queue.remove([first])
        XCTAssertEqual(queue.pending.map(\.interactionID), ["int_2"])
        XCTAssertEqual(storage.responses.map(\.interactionID), ["int_2"])
    }

    func testClearsQueuedResponsesOnUnpair() throws {
        let storage = MemoryQueueStorage()
        let queue = try ResponseQueue(storage: storage)
        try queue.enqueue(PendingResponse(interactionID: "int-1", responseCredential: "token", response: .approve))
        try queue.clear()
        XCTAssertTrue(queue.pending.isEmpty)
        XCTAssertTrue(storage.responses.isEmpty)
    }

    func testFailedEnqueueDoesNotCommitOnlyToMemory() throws {
        let storage = MemoryQueueStorage()
        let queue = try ResponseQueue(storage: storage)
        storage.shouldFailSave = true

        XCTAssertThrowsError(
            try queue.enqueue(PendingResponse(interactionID: "int-1", responseCredential: "token", response: .approve))
        )
        XCTAssertTrue(queue.pending.isEmpty)
    }

    func testFailedRemovalKeepsAcceptedResponseQueuedForDurableRetry() throws {
        let storage = MemoryQueueStorage()
        storage.responses = [PendingResponse(interactionID: "int-1", responseCredential: "token", response: .approve)]
        let queue = try ResponseQueue(storage: storage)
        storage.shouldFailSave = true

        XCTAssertThrowsError(try queue.remove(Set(queue.pending)))
        XCTAssertEqual(queue.pending.map(\.interactionID), ["int-1"])
    }

    func testFailedClearKeepsResponsesQueuedDuringUnpair() throws {
        let storage = MemoryQueueStorage()
        storage.responses = [PendingResponse(interactionID: "int-1", responseCredential: "token", response: .approve)]
        let queue = try ResponseQueue(storage: storage)
        storage.shouldFailSave = true

        XCTAssertThrowsError(try queue.clear())
        XCTAssertEqual(queue.pending.map(\.interactionID), ["int-1"])
    }

    func testQuarantinesAnUndecodableFileInsteadOfFailingQueueInitialization() throws {
        let directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString, directoryHint: .isDirectory)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let url = directory.appending(path: "response-queue.json")
        try Data("not-json".utf8).write(to: url)

        let storage = FileResponseQueueStorage(url: url)
        let queue = try ResponseQueue(storage: storage)

        XCTAssertTrue(queue.pending.isEmpty)
        XCTAssertFalse(FileManager.default.fileExists(atPath: url.path))
        XCTAssertTrue(FileManager.default.fileExists(atPath: url.appendingPathExtension("corrupt").path))
        XCTAssertEqual(storage.quarantinedFileURL, url.appendingPathExtension("corrupt"))
    }
}
