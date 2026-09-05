import Foundation

public final class RelayRedirectPolicy: NSObject, URLSessionTaskDelegate {
    public func urlSession(
        _ session: URLSession, task: URLSessionTask,
        willPerformHTTPRedirection response: HTTPURLResponse,
        newRequest request: URLRequest,
        completionHandler: @escaping @Sendable (URLRequest?) -> Void
    ) {
        guard let original = task.originalRequest?.url, let destination = request.url,
              original.scheme == "https", destination.scheme == "https",
              original.host?.lowercased() == destination.host?.lowercased(),
              (original.port ?? 443) == (destination.port ?? 443) else {
            completionHandler(nil)
            return
        }
        completionHandler(request)
    }
}
