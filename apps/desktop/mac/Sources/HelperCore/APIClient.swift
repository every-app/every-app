import Foundation

public enum APIError: Error, LocalizedError, Equatable {
  case signedOut
  /// Cloudflare Access stood in front of the app and wanted a browser login: a bearer alone
  /// (a personal access token) doesn't get through this Gateway.
  case accessLogin
  /// `code` is the server's machine-readable `error` (e.g. `ai_route_not_allowed`).
  case server(status: Int, code: String? = nil, message: String?)
  case decoding(String)

  public var code: String? {
    if case .server(_, let code, _) = self { return code }
    return nil
  }

  /// The transcription-token route says live keys can't be had (the Gateway doesn't allow the
  /// Realtime route, or the upstream refused): use the audio-chunk fallback. Not for a missing
  /// OpenAI key, which the fallback can't fix either, nor for sign-in problems.
  /// The server refused the request itself (a 4xx that a retry won't change): not 401 (sign-in,
  /// handled by the auth provider), 408, 409 or 429 (transient).
  public var isPermanentRefusal: Bool {
    guard case .server(let status, _, _) = self else { return false }
    return (400..<500).contains(status) && ![401, 408, 409, 429].contains(status)
  }

  public var isRealtimeUnavailable: Bool {
    guard case .server(let status, let code, _) = self else { return false }
    if code == "ai_route_not_allowed" { return true }
    if code == "ai_provider_not_configured" { return false }
    return [403, 501, 502, 503].contains(status)
  }

  public var errorDescription: String? {
    switch self {
    case .signedOut: "You're signed out. Sign in again."
    case .accessLogin:
      "Gateway requires Sign in with Every App. Its Cloudflare Access login stopped the request, so an access token alone can't reach Scribe."
    case .server(let status, _, let message): message ?? "Scribe answered HTTP \(status)."
    case .decoding(let what): "Scribe sent something unexpected (\(what))."
    }
  }
}

/// Scribe's /api/v1 over HTTPS with a bearer token (docs/scribe.md "API").
public struct APIClient: Sendable {
  public let auth: AuthProvider
  let transport: HTTPTransport

  /// The default transport doesn't follow redirects, so a bounce to the Access login is seen as one.
  public init(auth: AuthProvider, transport: HTTPTransport = URLSessionTransport(followRedirects: false)) {
    self.auth = auth
    self.transport = transport
  }

  public var appURL: URL { auth.appURL }

  public func me() async throws -> Me {
    try await get("api/v1/me")
  }

  public func upcoming(hours: Int = 24) async throws -> UpcomingResponse {
    do {
      return try await get("api/v1/calendar/upcoming", query: [URLQueryItem(name: "hours", value: String(hours))])
    } catch APIError.server(let status, _, _) where status == 409 || status == 412 || status == 428 {
      // "Google isn't connected" as an error status: ask /me for the connect link.
      let me = try await me()
      return UpcomingResponse(events: [], connected: false, connectURL: me.connectURL)
    }
  }

  /// `attendees` (a calendar event's) go along only when there are some.
  public func createMeeting(
    title: String, startsAt: Date, calendarEventId: String?, attendees: [Attendee] = []
  ) async throws -> CreatedMeeting {
    var body: [String: Any] = ["title": title, "startsAt": Self.iso(startsAt)]
    if let calendarEventId { body["calendarEventId"] = calendarEventId }
    if !attendees.isEmpty {
      body["attendees"] = attendees.map { a -> [String: Any] in
        ["email": a.email ?? NSNull(), "name": a.name ?? NSNull(), "self": a.isSelf ?? false]
      }
    }
    return try await send("POST", "api/v1/meetings", json: body)
  }

  /// `source` picks the noise reduction: "mic" (near field) or "system" (none).
  public func transcriptionToken(meetingID: String, source: String, language: String?) async throws -> TranscriptionToken {
    var body: [String: Any] = ["source": source]
    if let language { body["language"] = language }
    return try await send("POST", "api/v1/meetings/\(Self.escape(meetingID))/transcription-token", json: body)
  }

  /// The fallback when the Realtime route isn't allowed: one short WAV chunk, which the Worker
  /// passes to OpenAI and drops. Returns the stored segment (nil if the chunk held no words).
  public func appendAudioChunk(
    meetingID: String, wav: Data, seq: Int, startedMs: Int, endedMs: Int, speaker: Speaker, language: String?
  ) async throws -> Segment? {
    let boundary = "talk-\(Random.token(bytes: 12))"
    var fields = [("seq", String(seq)), ("startedMs", String(startedMs)), ("endedMs", String(endedMs)), ("speaker", speaker.rawValue)]
    if let language { fields.append(("language", language)) }
    let body = Multipart.encode(boundary: boundary, fields: fields, file: ("file", "chunk-\(seq).wav", "audio/wav", wav))
    let response: ChunkResponse = try await request(
      "POST", "api/v1/meetings/\(Self.escape(meetingID))/audio-chunk", body: body,
      contentType: "multipart/form-data; boundary=\(boundary)")
    return response.segment
  }

  struct ChunkResponse: Decodable {
    var segment: Segment?

    enum Keys: String, CodingKey { case segment }

    // The chunk is stored either way; a segment we can't read (say, speaker null) isn't a failure.
    init(from decoder: Decoder) throws {
      segment = try? decoder.container(keyedBy: Keys.self).decodeIfPresent(Segment.self, forKey: .segment)
    }
  }

  public func appendSegments(meetingID: String, _ segments: [Segment]) async throws {
    let body = try JSONEncoder().encode(segments)
    let _: Empty = try await request("POST", "api/v1/meetings/\(Self.escape(meetingID))/segments", body: body)
  }

  /// Idempotent: the Worker answers 404 for a meeting that's already finished, which is done too.
  public func finish(meetingID: String) async throws {
    do {
      let _: Empty = try await send("POST", "api/v1/meetings/\(Self.escape(meetingID))/finish", json: [String: Any]())
    } catch APIError.server(404, _, _) {
      return
    }
  }

  public func meetings() async throws -> [MeetingSummary] {
    let list: MeetingList = try await get("api/v1/meetings")
    return list.meetings
  }

  // MARK: Plumbing

  struct Empty: Decodable {}

  private func get<T: Decodable>(_ path: String, query: [URLQueryItem] = []) async throws -> T {
    try await request("GET", path, query: query, body: nil)
  }

  private func send<T: Decodable>(_ method: String, _ path: String, json: [String: Any]) async throws -> T {
    try await request(method, path, body: try JSONSerialization.data(withJSONObject: json))
  }

  func makeRequest(
    _ method: String, _ path: String, query: [URLQueryItem], body: Data?, token: String, contentType: String = "application/json"
  ) -> URLRequest {
    var c = URLComponents(url: appURL.appendingPathComponent(path), resolvingAgainstBaseURL: false)!
    if !query.isEmpty { c.queryItems = query }
    var request = URLRequest(url: c.url!)
    request.httpMethod = method
    request.timeoutInterval = 30
    request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
    request.setValue("application/json", forHTTPHeaderField: "Accept")
    if let body {
      request.httpBody = body
      request.setValue(contentType, forHTTPHeaderField: "Content-Type")
    }
    return request
  }

  private func request<T: Decodable>(
    _ method: String, _ path: String, query: [URLQueryItem] = [], body: Data?, contentType: String = "application/json"
  ) async throws -> T {
    var token: String
    do {
      token = try await auth.accessToken()
    } catch AuthError.signedOut {
      throw APIError.signedOut
    }
    var (data, response) = try await transport.send(makeRequest(method, path, query: query, body: body, token: token, contentType: contentType))
    // Before the 401 handling: Access can answer 401/403 too, and that isn't a dead token.
    if Self.isAccessLogin(data, response) { throw APIError.accessLogin }
    if response.statusCode == 401 {
      do {
        token = try await auth.tokenRejected(token)
      } catch {
        throw APIError.signedOut
      }
      (data, response) = try await transport.send(makeRequest(method, path, query: query, body: body, token: token, contentType: contentType))
      if Self.isAccessLogin(data, response) { throw APIError.accessLogin }
      if response.statusCode == 401 { throw APIError.signedOut }
    }
    guard (200..<300).contains(response.statusCode) else {
      let (code, message) = Self.errorParts(data)
      throw APIError.server(status: response.statusCode, code: code, message: message)
    }
    if T.self == Empty.self { return Empty() as! T }
    // A gateway that bounced us to a login page answers 200 with HTML.
    if let type = response.value(forHTTPHeaderField: "Content-Type"), type.contains("text/html") {
      throw APIError.server(status: response.statusCode, message: "Got a web page instead of the API. Is the app URL right, and is the token allowed through?")
    }
    do {
      return try JSONDecoder().decode(T.self, from: data)
    } catch {
      throw APIError.decoding("\(T.self)")
    }
  }

  /// Whether Cloudflare Access answered instead of the app: a redirect to (or a page from)
  /// `*.cloudflareaccess.com`, or Access's own login page or headers.
  static func isAccessLogin(_ data: Data, _ response: HTTPURLResponse) -> Bool {
    func isAccessHost(_ url: URL?) -> Bool {
      guard let host = url?.host?.lowercased() else { return false }
      return host == "cloudflareaccess.com" || host.hasSuffix(".cloudflareaccess.com")
    }
    if isAccessHost(response.url) { return true }
    if (300..<400).contains(response.statusCode), let location = response.value(forHTTPHeaderField: "Location") {
      if isAccessHost(URL(string: location)) || location.contains("/cdn-cgi/access/") { return true }
    }
    guard let type = response.value(forHTTPHeaderField: "Content-Type"), type.contains("text/html") else { return false }
    let page = String(decoding: data.prefix(64 * 1024), as: UTF8.self).lowercased()
    return page.contains("cloudflareaccess.com") || page.contains("/cdn-cgi/access/")
  }

  /// `{ error: code, message? }` (SPEC), or `{ error: { code, message } }`, or `{ message }`.
  static func errorParts(_ data: Data) -> (code: String?, message: String?) {
    guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return (nil, nil) }
    if let error = json["error"] as? String { return (error, json["message"] as? String ?? error) }
    if let error = json["error"] as? [String: Any] { return (error["code"] as? String, error["message"] as? String) }
    return (nil, json["message"] as? String)
  }

  static func iso(_ date: Date) -> String { date.formatted(.iso8601) }

  static func escape(_ s: String) -> String {
    s.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed.subtracting(CharacterSet(charactersIn: "/"))) ?? s
  }
}
