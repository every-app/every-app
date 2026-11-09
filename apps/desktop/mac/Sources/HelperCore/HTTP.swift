import Foundation

/// The network, behind a protocol so the API and OAuth clients can be tested without it.
public protocol HTTPTransport: Sendable {
  func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse)
}

public struct URLSessionTransport: HTTPTransport {
  let session: URLSession

  public init(session: URLSession = .shared) { self.session = session }

  /// `followRedirects: false` hands a 3xx back as it is (to spot a bounce to a login page).
  public init(followRedirects: Bool) {
    session = followRedirects ? .shared : Self.noRedirects
  }

  /// One for the app's life: a session keeps its delegate until invalidated.
  static let noRedirects = URLSession(configuration: .ephemeral, delegate: NoRedirects(), delegateQueue: nil)

  public func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
    let (data, response) = try await session.data(for: request)
    guard let http = response as? HTTPURLResponse else { throw URLError(.badServerResponse) }
    return (data, http)
  }
}

extension URL {
  /// scheme://host[:port], no trailing slash: what `resource` and the API base are made of.
  public var origin: URL? {
    guard var c = URLComponents(url: self, resolvingAgainstBaseURL: false), c.scheme != nil, c.host != nil else { return nil }
    c.path = ""
    c.query = nil
    c.fragment = nil
    c.user = nil
    c.password = nil
    return c.url
  }

  /// Parses what a person types: adds https:// when there's no scheme, and wants a host.
  public static func typed(_ text: String) -> URL? {
    var s = text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !s.isEmpty else { return nil }
    if !s.contains("://") { s = "https://" + s }
    guard let url = URL(string: s), let scheme = url.scheme?.lowercased(), ["https", "http"].contains(scheme),
      let host = url.host, !host.isEmpty
    else { return nil }
    // Plain http only for local development.
    if scheme == "http" && !["localhost", "127.0.0.1", "::1"].contains(host) && !host.hasSuffix(".localhost") {
      return nil
    }
    return url
  }
}

final class NoRedirects: NSObject, URLSessionTaskDelegate, Sendable {
  func urlSession(
    _ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
    newRequest request: URLRequest
  ) async -> URLRequest? { nil }
}
