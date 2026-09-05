import Foundation

public protocol ResponseQueueStorage: AnyObject {
    func load() throws -> [PendingResponse]
    func save(_ responses: [PendingResponse]) throws
}

public final class ResponseQueue {
    private let storage: ResponseQueueStorage
    public private(set) var pending: [PendingResponse]

    public init(storage: ResponseQueueStorage) throws {
        self.storage = storage
        self.pending = try storage.load()
    }

    @discardableResult
    public func enqueue(_ response: PendingResponse) throws -> PendingResponse {
        if let queued = pending.first(where: { $0.interactionID == response.interactionID }) {
            return queued
        }
        let updated = pending + [response]
        try storage.save(updated)
        pending = updated
        return response
    }

    public func remove(_ responses: Set<PendingResponse>) throws {
        let updated = pending.filter { !responses.contains($0) }
        try storage.save(updated)
        pending = updated
    }

    public func clear() throws {
        try storage.save([])
        pending = []
    }
}

public final class FileResponseQueueStorage: ResponseQueueStorage {
    private let url: URL
    private let encoder = JSONEncoder()
    private let decoder = JSONDecoder()
    public private(set) var quarantinedFileURL: URL?

    public init(url: URL) { self.url = url }

    public func load() throws -> [PendingResponse] {
        guard FileManager.default.fileExists(atPath: url.path) else { return [] }
        do {
            return try decoder.decode([PendingResponse].self, from: Data(contentsOf: url))
        } catch is DecodingError {
            var quarantineURL = url.appendingPathExtension("corrupt")
            if FileManager.default.fileExists(atPath: quarantineURL.path) {
                quarantineURL = url.appendingPathExtension("corrupt-\(UUID().uuidString)")
            }
            try FileManager.default.moveItem(at: url, to: quarantineURL)
            quarantinedFileURL = quarantineURL
            return []
        }
    }

    public func save(_ responses: [PendingResponse]) throws {
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        #if os(iOS)
        let options: Data.WritingOptions = [.atomic, .completeFileProtection]
        #else
        let options: Data.WritingOptions = [.atomic]
        #endif
        try encoder.encode(responses).write(to: url, options: options)
    }
}
