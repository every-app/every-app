import Foundation
import Testing

@testable import HelperCore

final class StubTransport: HTTPTransport, @unchecked Sendable {
  typealias Handler = (URLRequest) -> (Int, String, [String: String])
  private let lock = NSLock()
  private var handler: Handler
  private(set) var requests: [URLRequest] = []

  init(_ handler: @escaping Handler) { self.handler = handler }

  func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
    let (status, body, headers) = lock.withLock {
      requests.append(request)
      return handler(request)
    }
    var allHeaders = ["Content-Type": "application/json"]
    allHeaders.merge(headers) { $1 }
    let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: "HTTP/1.1", headerFields: allHeaders)!
    return (Data(body.utf8), response)
  }

  func form(_ request: URLRequest) -> [String: String] {
    let body = String(decoding: request.httpBody ?? Data(), as: UTF8.self)
    var out: [String: String] = [:]
    for pair in body.split(separator: "&") {
      let kv = pair.split(separator: "=", maxSplits: 1).map { String($0).removingPercentEncoding! }
      out[kv[0]] = kv.count > 1 ? kv[1] : ""
    }
    return out
  }
}

@Suite struct URLTests {
  @Test func typedURLs() {
    #expect(URL.typed("talk.example.com")?.absoluteString == "https://talk.example.com")
    #expect(URL.typed("https://talk.example.com/meetings")?.origin?.absoluteString == "https://talk.example.com")
    #expect(URL.typed("http://evil.example.com") == nil)
    #expect(URL.typed("http://localhost:3000")?.origin?.absoluteString == "http://localhost:3000")
    #expect(URL.typed("  ") == nil)
  }
}
