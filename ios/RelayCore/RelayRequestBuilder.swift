import Foundation

public struct RelayRequestBuilder: Sendable {
    public let baseURL: URL
    public let deviceCredential: String

    public init(baseURL: URL, deviceCredential: String) {
        self.baseURL = baseURL
        self.deviceCredential = deviceCredential
    }

    public func request<Body: Encodable>(path: String, method: String, body: Body) throws -> URLRequest {
        guard let url = URL(string: path, relativeTo: baseURL)?.absoluteURL,
              url.scheme == "https",
              url.host == baseURL.host else {
            throw URLError(.badURL)
        }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.setValue("Bearer \(deviceCredential)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(body)
        return request
    }

    public func request(path: String, method: String = "GET") throws -> URLRequest {
        guard let url = URL(string: path, relativeTo: baseURL)?.absoluteURL,
              url.scheme == "https",
              url.host == baseURL.host else {
            throw URLError(.badURL)
        }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.setValue("Bearer \(deviceCredential)", forHTTPHeaderField: "Authorization")
        return request
    }
}
