import Foundation

// The shapes of Scribe's /api/v1 (docs/scribe.md). Decoding is lenient on purpose: a list may come
// bare or wrapped, a date as ISO 8601 or epoch, an attendee as an object or a plain email.

public struct Me: Decodable, Equatable, Sendable {
  public var id: String?
  public var email: String?
  public var name: String?
  public var googleConnected: Bool
  public var connectURL: URL?

  enum Keys: String, CodingKey { case user, google, id, email, name, googleConnected, connected, connectUrl }

  public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: Keys.self)
    let user = (try? c.nestedContainer(keyedBy: Keys.self, forKey: .user)) ?? c
    id = try? user.decodeIfPresent(LenientString.self, forKey: .id)?.value
    email = try? user.decodeIfPresent(String.self, forKey: .email)
    name = try? user.decodeIfPresent(String.self, forKey: .name)
    if let google = try? c.nestedContainer(keyedBy: Keys.self, forKey: .google) {
      googleConnected = (try? google.decode(Bool.self, forKey: .connected)) ?? false
      connectURL = try? google.decodeIfPresent(URL.self, forKey: .connectUrl)
    } else {
      googleConnected = (try? c.decode(Bool.self, forKey: .googleConnected)) ?? (try? c.decode(Bool.self, forKey: .connected)) ?? false
      connectURL = try? c.decodeIfPresent(URL.self, forKey: .connectUrl)
    }
  }
}

public struct Attendee: Decodable, Equatable, Sendable {
  public var email: String?
  public var name: String?
  /// Google marks the calendar's owner `self: true`; nil when the server didn't say.
  public var isSelf: Bool?

  enum Keys: String, CodingKey { case email, name, displayName, `self` }

  public init(email: String?, name: String? = nil, isSelf: Bool? = nil) {
    self.email = email
    self.name = name
    self.isSelf = isSelf
  }

  public init(from decoder: Decoder) throws {
    if let single = try? decoder.singleValueContainer(), let email = try? single.decode(String.self) {
      self.init(email: email)
      return
    }
    let c = try decoder.container(keyedBy: Keys.self)
    self.init(
      email: try? c.decodeIfPresent(String.self, forKey: .email),
      name: (try? c.decodeIfPresent(String.self, forKey: .name)) ?? (try? c.decodeIfPresent(String.self, forKey: .displayName)),
      isSelf: try? c.decodeIfPresent(Bool.self, forKey: .self))
  }
}

public struct CalendarEvent: Decodable, Equatable, Sendable, Identifiable {
  public var id: String
  public var title: String
  public var start: Date
  public var end: Date?
  public var attendees: [Attendee]
  public var conferenceURL: URL?

  enum Keys: String, CodingKey { case id, title, summary, start, startsAt, end, endsAt, attendees, conferenceUrl, hangoutLink }

  public init(id: String, title: String, start: Date, end: Date?, attendees: [Attendee], conferenceURL: URL?) {
    self.id = id
    self.title = title
    self.start = start
    self.end = end
    self.attendees = attendees
    self.conferenceURL = conferenceURL
  }

  public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: Keys.self)
    id = try c.decode(LenientString.self, forKey: .id).value
    title = (try? c.decode(String.self, forKey: .title)) ?? (try? c.decode(String.self, forKey: .summary)) ?? "Untitled meeting"
    if let start = try? c.decode(FlexibleDate.self, forKey: .start) {
      self.start = start.date
    } else {
      self.start = try c.decode(FlexibleDate.self, forKey: .startsAt).date
    }
    end = (try? c.decode(FlexibleDate.self, forKey: .end))?.date ?? (try? c.decode(FlexibleDate.self, forKey: .endsAt))?.date
    attendees = (try? c.decode([Attendee].self, forKey: .attendees)) ?? []
    let link = (try? c.decodeIfPresent(String.self, forKey: .conferenceUrl)) ?? (try? c.decodeIfPresent(String.self, forKey: .hangoutLink))
    conferenceURL = link.flatMap { $0.isEmpty ? nil : URL(string: $0) }
  }

  /// SPEC: remind for an event that has other attendees or a conference link.
  public var isMeeting: Bool {
    if conferenceURL != nil { return true }
    if attendees.contains(where: { $0.isSelf != nil }) {
      return attendees.contains { $0.isSelf != true }
    }
    // Without `self` flags the owner is probably in the list too.
    return attendees.count >= 2
  }
}

public struct UpcomingResponse: Decodable, Equatable, Sendable {
  public var events: [CalendarEvent]
  public var connected: Bool
  public var connectURL: URL?

  enum Keys: String, CodingKey { case events, items, connected, googleConnected, connectUrl }

  public init(events: [CalendarEvent], connected: Bool, connectURL: URL?) {
    self.events = events
    self.connected = connected
    self.connectURL = connectURL
  }

  public init(from decoder: Decoder) throws {
    if let single = try? decoder.singleValueContainer(), let events = try? single.decode([CalendarEvent].self) {
      self.init(events: events, connected: true, connectURL: nil)
      return
    }
    let c = try decoder.container(keyedBy: Keys.self)
    let events = (try? c.decode([CalendarEvent].self, forKey: .events)) ?? (try? c.decode([CalendarEvent].self, forKey: .items)) ?? []
    let connectURL = try? c.decodeIfPresent(URL.self, forKey: .connectUrl)
    let connected = (try? c.decode(Bool.self, forKey: .connected)) ?? (try? c.decode(Bool.self, forKey: .googleConnected)) ?? (connectURL == nil)
    self.init(events: events, connected: connected, connectURL: connectURL)
  }
}

public struct TranscriptionToken: Decodable, Equatable, Sendable {
  public var value: String
  public var expiresAt: Date
  /// The transcription model the Worker set up the session for.
  public var model: String?

  enum Keys: String, CodingKey { case value, expiresAt, expires_at, model, clientSecret = "client_secret" }

  public init(value: String, expiresAt: Date, model: String? = nil) {
    self.value = value
    self.expiresAt = expiresAt
    self.model = model
  }

  public init(from decoder: Decoder) throws {
    let top = try decoder.container(keyedBy: Keys.self)
    model = try? top.decodeIfPresent(String.self, forKey: .model)
    var c = top
    // OpenAI's own shape nests it: { client_secret: { value, expires_at } }.
    if let nested = try? c.nestedContainer(keyedBy: Keys.self, forKey: .clientSecret) { c = nested }
    value = try c.decode(String.self, forKey: .value)
    let expiry = (try? c.decode(FlexibleDate.self, forKey: .expiresAt)) ?? (try? c.decode(FlexibleDate.self, forKey: .expires_at))
    // Unknown expiry: assume the shortest sensible life and renew early.
    expiresAt = expiry?.date ?? Date().addingTimeInterval(10 * 60)
  }
}

public enum Speaker: String, Codable, Sendable {
  case me
  case them
}

public struct Segment: Codable, Equatable, Sendable {
  public var seq: Int
  public var startedMs: Int
  public var endedMs: Int
  public var speaker: Speaker
  public var text: String

  public init(seq: Int, startedMs: Int, endedMs: Int, speaker: Speaker, text: String) {
    self.seq = seq
    self.startedMs = startedMs
    self.endedMs = endedMs
    self.speaker = speaker
    self.text = text
  }
}

public struct CreatedMeeting: Decodable, Equatable, Sendable {
  public var id: String

  enum Keys: String, CodingKey { case id, meeting }

  public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: Keys.self)
    if let meeting = try? c.nestedContainer(keyedBy: Keys.self, forKey: .meeting) {
      id = try meeting.decode(LenientString.self, forKey: .id).value
    } else {
      id = try c.decode(LenientString.self, forKey: .id).value
    }
  }
}

public struct MeetingSummary: Decodable, Equatable, Sendable, Identifiable {
  public var id: String
  public var title: String
  public var startsAt: Date?
  public var status: String?
  public var visibility: String?
  public var url: URL?

  enum Keys: String, CodingKey { case id, title, startsAt, starts_at, createdAt, status, visibility, url }

  public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: Keys.self)
    id = try c.decode(LenientString.self, forKey: .id).value
    title = (try? c.decode(String.self, forKey: .title)) ?? "Untitled meeting"
    startsAt =
      (try? c.decode(FlexibleDate.self, forKey: .startsAt))?.date ?? (try? c.decode(FlexibleDate.self, forKey: .starts_at))?.date
      ?? (try? c.decode(FlexibleDate.self, forKey: .createdAt))?.date
    status = try? c.decodeIfPresent(String.self, forKey: .status)
    visibility = try? c.decodeIfPresent(String.self, forKey: .visibility)
    url = try? c.decodeIfPresent(URL.self, forKey: .url)
  }

  /// The web app's page for this meeting.
  public func pageURL(appURL: URL) -> URL {
    if let url, url.scheme == "https" || url.scheme == "http" { return url }
    if let url, url.scheme == nil, let resolved = URL(string: url.relativeString, relativeTo: appURL)?.absoluteURL {
      return resolved
    }
    return appURL.appendingPathComponent("meetings").appendingPathComponent(id)
  }
}

struct MeetingList: Decodable {
  var meetings: [MeetingSummary]

  enum Keys: String, CodingKey { case meetings, items }

  init(from decoder: Decoder) throws {
    if let single = try? decoder.singleValueContainer(), let list = try? single.decode([MeetingSummary].self) {
      meetings = list
      return
    }
    let c = try decoder.container(keyedBy: Keys.self)
    meetings = try (try? c.decode([MeetingSummary].self, forKey: .meetings)) ?? c.decode([MeetingSummary].self, forKey: .items)
  }
}

/// An ISO 8601 string (with or without fractional seconds, or a bare date) or an epoch number
/// (seconds, or milliseconds when it's too big to be seconds).
public struct FlexibleDate: Decodable, Equatable, Sendable {
  public var date: Date

  public init(from decoder: Decoder) throws {
    let c = try decoder.singleValueContainer()
    if let number = try? c.decode(Double.self) {
      date = Date(timeIntervalSince1970: number > 100_000_000_000 ? number / 1000 : number)
      return
    }
    let text = try c.decode(String.self)
    guard let date = FlexibleDate.parse(text) else {
      throw DecodingError.dataCorruptedError(in: c, debugDescription: "Not a date: \(text)")
    }
    self.date = date
  }

  public static func parse(_ text: String) -> Date? {
    if let d = try? Date(text, strategy: .iso8601) { return d }
    if let d = try? Date(text, strategy: Date.ISO8601FormatStyle(includingFractionalSeconds: true)) { return d }
    if let d = try? Date(text, strategy: Date.ISO8601FormatStyle().year().month().day()) { return d }
    return nil
  }
}

/// An id that may arrive as a string or a number.
struct LenientString: Decodable {
  var value: String

  init(from decoder: Decoder) throws {
    let c = try decoder.singleValueContainer()
    if let s = try? c.decode(String.self) {
      value = s
    } else {
      value = String(try c.decode(Int.self))
    }
  }
}
