import Foundation

/// A person's own OpenAI-compatible transcription server (Settings → Transcription), for example
/// a Whisper server on this Mac. When one is set, meeting audio goes only there: never to OpenAI
/// and never to Scribe's backend. Only the transcript text is posted to Scribe.
public struct TranscriptionServer: Sendable, Equatable {
  /// What the person typed, parsed: usually ends in `/v1`.
  public let baseURL: URL
  public let model: String
  /// Sent as `Authorization: Bearer` only when set; most local servers want none.
  public let apiKey: String?

  public init(baseURL: URL, model: String, apiKey: String? = nil) {
    self.baseURL = baseURL
    self.model = model
    self.apiKey = apiKey?.isEmpty == true ? nil : apiKey
  }

  /// `<base URL>/audio/transcriptions` (OpenAI's path). A base that already ends there is used
  /// as it is.
  public var endpoint: URL {
    let suffix = "/audio/transcriptions"
    var c = URLComponents(url: baseURL, resolvingAgainstBaseURL: false)!
    var path = c.path
    while path.hasSuffix("/") { path.removeLast() }
    c.path = path.hasSuffix(suffix) ? path : path + suffix
    return c.url!
  }

  /// `localhost:50060`, for messages.
  public var hostLabel: String {
    let host = baseURL.host ?? baseURL.absoluteString
    if let port = baseURL.port { return "\(host):\(port)" }
    return host
  }

  /// Parses the address a person typed. https to anywhere; plain http only to this Mac or the
  /// local network (`isLocal`), so audio never crosses the internet unencrypted. Without a
  /// scheme, a local host gets http and any other https. No user or password in the URL.
  public static func typedBaseURL(_ text: String) -> URL? {
    let s = text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !s.isEmpty, s.count <= 2048 else { return nil }
    let hasScheme = s.contains("://")
    guard var c = URLComponents(string: hasScheme ? s : "http://" + s), let host = c.host, !host.isEmpty else { return nil }
    guard c.user == nil, c.password == nil else { return nil }
    let local = isLocal(host: host)
    if !hasScheme { c.scheme = local ? "http" : "https" }
    guard let scheme = c.scheme?.lowercased(), scheme == "https" || (scheme == "http" && local) else { return nil }
    c.scheme = scheme
    c.query = nil
    c.fragment = nil
    return c.url
  }

  /// This Mac or its local network: localhost, `*.localhost`, `*.local` (a Bonjour name, answered
  /// on the local link only), `::1`, and the private, link-local and carrier-grade NAT
  /// (Tailscale) IPv4 ranges. A bare name such as `nas` is not local: a DNS search domain can
  /// resolve it anywhere, so it needs https.
  public static func isLocal(host: String) -> Bool {
    let h = host.lowercased().trimmingCharacters(in: CharacterSet(charactersIn: "[]"))
    if h == "localhost" || h == "::1" || h.hasSuffix(".localhost") || h.hasSuffix(".local") { return true }
    if h.contains(":") { return false }  // any other IPv6
    let parts = h.split(separator: ".", omittingEmptySubsequences: false)
    if parts.count == 4, parts.allSatisfy({ !$0.isEmpty && $0.count <= 3 && $0.allSatisfy(\.isNumber) }) {
      let n = parts.compactMap { Int($0) }
      guard n.count == 4, n.allSatisfy({ $0 <= 255 }) else { return false }
      if n[0] == 127 || n[0] == 10 { return true }
      if n[0] == 172, (16...31).contains(n[1]) { return true }
      if n[0] == 192, n[1] == 168 { return true }
      if n[0] == 169, n[1] == 254 { return true }
      if n[0] == 100, (64...127).contains(n[1]) { return true }
      return false
    }
    return false
  }
}

public enum TranscriptionServerError: Error, LocalizedError, Equatable {
  /// No answer at all: nothing listening, a timeout, no route. `host` is for the message.
  case unreachable(host: String)
  /// The server answered with an error; `message` is its own, if it gave one.
  case status(Int, message: String?)
  /// A 2xx that isn't `{ "text": … }`: probably not a transcription server.
  case notATranscript

  /// The same request would fail the same way: a refused key, a wrong address or model. Not a
  /// timeout, a busy server (408, 409, 425, 429) or a 5xx.
  public var isPermanent: Bool {
    switch self {
    case .unreachable: false
    case .status(let status, _): (300..<500).contains(status) && ![408, 409, 425, 429].contains(status)
    case .notATranscript: true
    }
  }

  public var errorDescription: String? {
    switch self {
    case .unreachable(let host):
      return "Your transcription server at \(host) isn't answering."
    case .status(let status, let message):
      let said = message.map { ": \($0)\($0.hasSuffix(".") ? "" : ".")" } ?? "."
      switch status {
      case 401, 403: return "Your transcription server refused the API key (HTTP \(status))\(said)"
      case 404: return "Your transcription server has no /audio/transcriptions at that address, or doesn't know the model (HTTP 404)\(said)"
      case 300..<400: return "Your transcription server answered with a redirect (HTTP \(status)), which Every App doesn't follow with audio."
      default: return "Your transcription server answered HTTP \(status)\(said)"
      }
    case .notATranscript:
      return "That server answered, but not with a transcript. Is it an OpenAI-compatible transcription server?"
    }
  }
}

/// `POST <base URL>/audio/transcriptions`, OpenAI's shape: multipart `file`, `model`,
/// `response_format=json` and `language` when known; answers `{ "text": … }`.
public struct TranscriptionServerClient: Sendable {
  public let server: TranscriptionServer
  let transport: HTTPTransport

  /// The default transport doesn't follow redirects, so audio only ever goes to the address set.
  public init(server: TranscriptionServer, transport: HTTPTransport = URLSessionTransport(followRedirects: false)) {
    self.server = server
    self.transport = transport
  }

  func makeRequest(wav: Data, language: String?, boundary: String, timeout: TimeInterval) -> URLRequest {
    var fields = [("model", server.model), ("response_format", "json")]
    if let language, !language.isEmpty { fields.append(("language", language)) }
    var request = URLRequest(url: server.endpoint)
    request.httpMethod = "POST"
    request.timeoutInterval = timeout
    request.setValue("application/json", forHTTPHeaderField: "Accept")
    request.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
    if let key = server.apiKey { request.setValue("Bearer \(key)", forHTTPHeaderField: "Authorization") }
    request.httpBody = Multipart.encode(boundary: boundary, fields: fields, file: ("file", "audio.wav", "audio/wav", wav))
    return request
  }

  /// The words in `wav` (empty when the server heard none).
  public func transcribe(wav: Data, language: String?, timeout: TimeInterval = 120) async throws -> String {
    let request = makeRequest(wav: wav, language: language, boundary: "everyapp-\(Random.token(bytes: 12))", timeout: timeout)
    let data: Data
    let response: HTTPURLResponse
    do {
      (data, response) = try await transport.send(request)
    } catch let error as URLError where error.code != .cancelled {
      throw TranscriptionServerError.unreachable(host: server.hostLabel)
    }
    guard (200..<300).contains(response.statusCode) else {
      throw TranscriptionServerError.status(response.statusCode, message: Self.errorMessage(data))
    }
    guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any], let text = json["text"] as? String else {
      throw TranscriptionServerError.notATranscript
    }
    return Self.clean(text)
  }

  /// Proves the server answers a transcription request: one second of silence, as a recording
  /// would send it. Returns what it transcribed (usually nothing).
  @discardableResult
  public func check(language: String? = nil, timeout: TimeInterval = 60) async throws -> String {
    try await transcribe(wav: Self.wav(pcm24k: Data(count: 48_000)), language: language, timeout: timeout)
  }

  /// The helper's PCM16 24 kHz mono as a 16 kHz WAV: the rate Whisper models take, and the only
  /// one some servers read (they all resample to it anyway, so nothing is lost).
  public static func wav(pcm24k: Data) -> Data {
    var resampler = Resampler(from: 24_000, to: 16_000)
    // A little silence after the end pushes the last samples through the filter.
    let samples = PCM16.decode(pcm24k).map { Float($0) / 32_768 } + [Float](repeating: 0, count: 64)
    return WAV.encode(pcm16: PCM16.encode(resampler.process(samples)), sampleRate: 16_000)
  }

  /// whisper.cpp writes `[BLANK_AUDIO]` for a stretch without words.
  static func clean(_ text: String) -> String {
    text.replacingOccurrences(of: "[BLANK_AUDIO]", with: " ").trimmingCharacters(in: .whitespacesAndNewlines)
  }

  /// `{ error: { message } }` (OpenAI), `{ error: "…" }`, `{ detail: "…" }` (FastAPI) or
  /// `{ message }`, cut to 200 characters.
  static func errorMessage(_ data: Data) -> String? {
    guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
    let found =
      (json["error"] as? [String: Any])?["message"] as? String ?? json["error"] as? String ?? json["detail"] as? String
      ?? json["message"] as? String
    guard let message = found?.trimmingCharacters(in: .whitespacesAndNewlines), !message.isEmpty else { return nil }
    return String(message.prefix(200))
  }
}
