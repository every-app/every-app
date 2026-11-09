import Foundation
import Testing

@testable import HelperCore

@Suite struct ResamplerTests {
  func sine(_ freq: Double, rate: Double, seconds: Double, amplitude: Float = 0.5) -> [Float] {
    (0..<Int(rate * seconds)).map { amplitude * Float(sin(2 * .pi * freq * Double($0) / rate)) }
  }

  func rms(_ x: ArraySlice<Float>) -> Double {
    (x.reduce(0.0) { $0 + Double($1) * Double($1) } / Double(x.count)).squareRoot()
  }

  @Test func outputLengthFollowsTheRatio() {
    for rate in [48_000.0, 44_100, 16_000, 96_000] {
      var r = Resampler(from: rate, to: 24_000)
      var total = 0
      for _ in 0..<10 { total += r.process([Float](repeating: 0, count: Int(rate / 10))).count }
      // One second in; all but the filter's lookahead (halfWidth input samples) out.
      let lookahead = Int((Double(r.halfWidth) * 24_000 / rate).rounded(.up))
      #expect(abs(total - 24_000) <= lookahead + 2, "rate \(rate): \(total)")
    }
  }

  @Test func dcPassesUnchanged() {
    var r = Resampler(from: 48_000, to: 24_000)
    let out = r.process([Float](repeating: 0.25, count: 48_000))
    for v in out[200..<out.count] { #expect(abs(v - 0.25) < 0.002) }
  }

  @Test func speechBandKeepsItsLevel() {
    var r = Resampler(from: 48_000, to: 24_000)
    let out = r.process(sine(1_000, rate: 48_000, seconds: 1))
    #expect(abs(rms(out[1_000..<out.count]) - 0.5 / 2.0.squareRoot()) < 0.01)
  }

  @Test func aboveNewNyquistIsRemoved() {
    // 18 kHz would alias to 6 kHz at 24 kHz without the low-pass.
    var r = Resampler(from: 48_000, to: 24_000)
    let out = r.process(sine(18_000, rate: 48_000, seconds: 1))
    #expect(rms(out[1_000..<out.count]) < 0.01)
  }

  @Test func upsamplingWorks() {
    var r = Resampler(from: 16_000, to: 24_000)
    let out = r.process(sine(440, rate: 16_000, seconds: 1))
    #expect(abs(rms(out[1_000..<out.count]) - 0.5 / 2.0.squareRoot()) < 0.01)
  }

  @Test func chunkingDoesNotChangeTheOutput() {
    let input = sine(700, rate: 44_100, seconds: 0.5)
    var whole = Resampler(from: 44_100, to: 24_000)
    let a = whole.process(input)
    var pieces = Resampler(from: 44_100, to: 24_000)
    var b: [Float] = []
    var i = 0
    let sizes = [1, 7, 100, 333, 4_096, 512]
    var k = 0
    while i < input.count {
      let n = min(sizes[k % sizes.count], input.count - i)
      b += pieces.process(Array(input[i..<i + n]))
      i += n
      k += 1
    }
    #expect(a.count == b.count)
    for j in 0..<min(a.count, b.count) { #expect(abs(a[j] - b[j]) < 1e-5) }
  }

  @Test func sameRateIsPassThrough() {
    var r = Resampler(from: 24_000, to: 24_000)
    #expect(r.process([0.1, 0.2]) == [0.1, 0.2])
  }

  @Test func pcm16EncodingClipsAndRoundTrips() {
    let data = PCM16.encode([0, 1, -1, 2, -2, 0.5])
    #expect(data.count == 12)
    #expect(PCM16.decode(data) == [0, 32_767, -32_767, 32_767, -32_768, 16_384])
  }

  @Test func downmixAverages() {
    let stereo: [Float] = [1, 0, 0.5, 0.5, -1, 1]
    let mono = stereo.withUnsafeBufferPointer { PCM16.downmix(interleaved: $0, channels: 2) }
    #expect(mono == [0.5, 0.5, 0])
  }

  @Test func converterProduces24kPCM16() {
    var c = AudioConverter24k(inputRate: 48_000)
    let data = c.convert(mono: [Float](repeating: 0, count: 4_800))
    #expect(data.count % 2 == 0)
    #expect(abs(data.count / 2 - 2_400) <= c.resampler.halfWidth + 1)
  }
}

@Suite struct TurnDetectorTests {
  func tone(ms: Int) -> [Int16] { (0..<(24 * ms)).map { Int16(8_000 * sin(Double($0) * 0.1)) } }
  func silence(ms: Int) -> [Int16] { [Int16](repeating: 0, count: 24 * ms) }

  @Test func commitsAfterSilence() {
    var d = TurnDetector()
    #expect(d.feed(tone(ms: 1_000)).isEmpty)
    let actions = d.feed(silence(ms: 700))
    #expect(actions == [.commit(t0: 0, t1: 1_600)])
  }

  @Test func shortBlipIsNotATurn() {
    var d = TurnDetector()
    #expect(d.feed(tone(ms: 100) + silence(ms: 700)).isEmpty)
  }

  @Test func longSpeechCommitsAtThirtySeconds() {
    var d = TurnDetector()
    let actions = d.feed(tone(ms: 31_000))
    #expect(actions == [.commit(t0: 0, t1: 30_000)])
  }

  @Test func longSilenceIsSkipped() {
    var d = TurnDetector()
    #expect(d.feed(silence(ms: 30_000)) == [.skipSilence])
    _ = d.feed(tone(ms: 500))
    #expect(d.flush() == .commit(t0: 30_000, t1: 30_500))
  }

  @Test func flushWithoutSpeechIsNil() {
    var d = TurnDetector()
    _ = d.feed(silence(ms: 500))
    #expect(d.flush() == nil)
  }
}

@Suite struct SegmentBatcherTests {
  @Test func assignsSeqAndSkipsBlank() {
    var b = SegmentBatcher()
    b.add(speaker: .me, startedMs: 0, endedMs: 1_000, text: "  hello   there ")
    #expect(b.add(speaker: .them, startedMs: 0, endedMs: 10, text: "   ") == nil)
    b.add(speaker: .them, startedMs: 500, endedMs: 2_000, text: "hi")
    #expect(b.pending.map(\.seq) == [0, 2_002])  // startedMs × 4, + 2 for them
    #expect(b.pending[0].text == "hello there")
    #expect(b.pending[1].speaker == .them)
  }

  @Test func batchesAreBoundedAndRestoredInOrder() {
    var b = SegmentBatcher()
    for i in 0..<5 { b.add(speaker: .me, startedMs: i, endedMs: i + 1, text: "t\(i)") }
    let first = b.takeBatch(max: 3)
    #expect(first.map(\.seq) == [0, 4, 8])
    b.add(speaker: .me, startedMs: 9, endedMs: 10, text: "late")
    b.restore(first)
    #expect(b.pending.map(\.seq) == [0, 4, 8, 12, 16, 36])
    #expect(b.takeBatch().count == 6)
    #expect(b.isEmpty)
    #expect(b.takeBatch().isEmpty)
  }

  @Test func restoreDoesNotDuplicate() {
    var b = SegmentBatcher()
    b.add(speaker: .me, startedMs: 0, endedMs: 1, text: "a")
    let batch = b.takeBatch()
    b.restore(batch)
    b.restore(batch)
    #expect(b.pending.count == 1)
  }

  @Test func timesAreSane() {
    var b = SegmentBatcher()
    let s = b.add(speaker: .me, startedMs: -5, endedMs: -10, text: "x")!
    #expect(s.startedMs == 0)
    #expect(s.endedMs >= s.startedMs)
  }

  @Test func encodesAsSpecSays() throws {
    var b = SegmentBatcher()
    b.add(speaker: .them, startedMs: 10, endedMs: 20, text: "yo")
    let json = try JSONSerialization.jsonObject(with: JSONEncoder().encode(b.pending)) as! [[String: Any]]
    #expect(json[0]["seq"] as? Int == 42)
    #expect(json[0]["startedMs"] as? Int == 10)
    #expect(json[0]["endedMs"] as? Int == 20)
    #expect(json[0]["speaker"] as? String == "them")
    #expect(json[0]["text"] as? String == "yo")
  }
}

@Suite struct APIClientTests {
  func client(_ handler: @escaping StubTransport.Handler) -> (APIClient, StubTransport) {
    let stub = StubTransport(handler)
    return (APIClient(auth: AccessTokenAuthProvider(appURL: URL(string: "https://talk.example.com")!, token: "epat_1"), transport: stub), stub)
  }

  @Test func meDecodesNestedAndFlat() async throws {
    let (api, stub) = client { _ in
      (200, #"{"user":{"id":"u1","email":"ben@example.com"},"google":{"connected":false,"connectUrl":"https://gw/connect"}}"#, [:])
    }
    let me = try await api.me()
    #expect(me.email == "ben@example.com")
    #expect(!me.googleConnected)
    #expect(me.connectURL?.absoluteString == "https://gw/connect")
    #expect(stub.requests[0].value(forHTTPHeaderField: "Authorization") == "Bearer epat_1")
    #expect(stub.requests[0].url?.absoluteString == "https://talk.example.com/api/v1/me")

    let flat = try JSONDecoder().decode(Me.self, from: Data(#"{"id":7,"email":"a@b","googleConnected":true}"#.utf8))
    #expect(flat.id == "7")
    #expect(flat.googleConnected)
  }

  @Test func upcomingDecodesEventsAndDates() async throws {
    let (api, stub) = client { _ in
      (
        200,
        """
        {"connected":true,"events":[
          {"id":"e1","title":"Standup","start":"2026-10-27T16:00:00Z","end":"2026-10-27T16:15:00.000Z",
           "attendees":[{"email":"ben@x","self":true},{"email":"kit@x","name":"Kit"}],"conferenceUrl":"https://meet.google.com/abc"},
          {"id":"e2","summary":"Lunch","start":1793116800000,"attendees":["a@x","b@x"]},
          {"id":"e3","title":"All day","start":"2026-10-28","conferenceUrl":""}
        ]}
        """, [:]
      )
    }
    let upcoming = try await api.upcoming(hours: 24)
    #expect(stub.requests[0].url?.query == "hours=24")
    #expect(upcoming.connected)
    #expect(upcoming.events.count == 3)
    let e1 = upcoming.events[0]
    #expect(e1.start == FlexibleDate.parse("2026-10-27T16:00:00Z"))
    #expect(e1.end == e1.start.addingTimeInterval(15 * 60))
    #expect(e1.attendees[0].isSelf == true)
    #expect(e1.attendees[1].name == "Kit")
    #expect(e1.isMeeting)
    #expect(upcoming.events[1].title == "Lunch")
    #expect(upcoming.events[1].start == Date(timeIntervalSince1970: 1_793_116_800))
    #expect(upcoming.events[1].isMeeting)
    #expect(upcoming.events[2].conferenceURL == nil)
    #expect(!upcoming.events[2].isMeeting)
  }

  @Test func upcomingNotConnected() async throws {
    let (api, _) = client { _ in (200, #"{"connected":false,"connectUrl":"https://gw/connect","events":[]}"#, [:]) }
    let upcoming = try await api.upcoming()
    #expect(!upcoming.connected)
    #expect(upcoming.connectURL != nil)
  }

  @Test func upcomingConflictFallsBackToMe() async throws {
    let (api, _) = client { request in
      request.url!.path.hasSuffix("upcoming")
        ? (409, #"{"error":"Google isn't connected"}"#, [:])
        : (200, #"{"user":{"id":"u"},"google":{"connected":false,"connectUrl":"https://gw/c"}}"#, [:])
    }
    let upcoming = try await api.upcoming()
    #expect(!upcoming.connected)
    #expect(upcoming.connectURL?.absoluteString == "https://gw/c")
  }

  @Test func meetingFlow() async throws {
    let (api, stub) = client { request in
      switch request.url!.path {
      case "/api/v1/meetings": (201, #"{"meeting":{"id":"m1","title":"Standup","calendarEventId":null}}"#, [:])
      case "/api/v1/meetings/m1/transcription-token":
        (200, #"{"value":"ek_abc","expiresAt":1793116800,"model":"gpt-live-transcribe","sampleRate":24000}"#, [:])
      case "/api/v1/meetings/m1/segments": (204, "", [:])
      case "/api/v1/meetings/m1/finish": (202, #"{"ok":true}"#, [:])
      default: (404, "", [:])
      }
    }
    let created = try await api.createMeeting(title: "Standup", startsAt: Date(timeIntervalSince1970: 0), calendarEventId: "e1")
    #expect(created.id == "m1")
    let body = try JSONSerialization.jsonObject(with: stub.requests[0].httpBody!) as! [String: Any]
    #expect(body["title"] as? String == "Standup")
    #expect(body["startsAt"] as? String == "1970-01-01T00:00:00Z")
    #expect(body["calendarEventId"] as? String == "e1")

    let token = try await api.transcriptionToken(meetingID: "m1", source: "mic", language: "en")
    #expect(token.value == "ek_abc")
    let tokenBody = try JSONSerialization.jsonObject(with: stub.requests[1].httpBody!) as! [String: Any]
    #expect(tokenBody["source"] as? String == "mic")
    #expect(tokenBody["language"] as? String == "en")
    #expect(token.expiresAt == Date(timeIntervalSince1970: 1_793_116_800))
    #expect(token.model == "gpt-live-transcribe")

    try await api.appendSegments(meetingID: "m1", [Segment(seq: 0, startedMs: 0, endedMs: 5, speaker: .me, text: "hi")])
    let segments = try JSONSerialization.jsonObject(with: stub.requests[2].httpBody!) as! [[String: Any]]
    #expect(segments.count == 1)
    try await api.finish(meetingID: "m1")
    #expect(stub.requests.map(\.httpMethod) == ["POST", "POST", "POST", "POST"])
  }

  @Test func createSendsAttendees() async throws {
    let (api, stub) = client { _ in (201, #"{"meeting":{"id":"m1"}}"#, [:]) }
    _ = try await api.createMeeting(
      title: "Standup", startsAt: Date(timeIntervalSince1970: 0), calendarEventId: "e1",
      attendees: [Attendee(email: "ben@x", name: "Ben", isSelf: true), Attendee(email: "kit@x"), Attendee(email: nil, name: "Room")])
    let body = try JSONSerialization.jsonObject(with: stub.requests[0].httpBody!) as! [String: Any]
    let attendees = body["attendees"] as! [[String: Any]]
    #expect(attendees.count == 3)
    #expect(attendees[0]["email"] as? String == "ben@x")
    #expect(attendees[0]["name"] as? String == "Ben")
    #expect(attendees[0]["self"] as? Bool == true)
    #expect(attendees[1]["self"] as? Bool == false)
    #expect(attendees[1]["name"] is NSNull)
    #expect(attendees[2]["email"] is NSNull)

    _ = try await api.createMeeting(title: "Solo", startsAt: Date(timeIntervalSince1970: 0), calendarEventId: nil)
    let bare = try JSONSerialization.jsonObject(with: stub.requests[1].httpBody!) as! [String: Any]
    #expect(bare["attendees"] == nil)
    #expect(bare["calendarEventId"] == nil)
  }

  @Test func openAIShapedTokenAndISOExpiry() throws {
    let nested = try JSONDecoder().decode(
      TranscriptionToken.self, from: Data(#"{"client_secret":{"value":"ek_1","expires_at":1793116800}}"#.utf8))
    #expect(nested.value == "ek_1")
    let iso = try JSONDecoder().decode(TranscriptionToken.self, from: Data(#"{"value":"ek_2","expiresAt":"2026-10-27T16:00:00.123Z"}"#.utf8))
    #expect(abs(iso.expiresAt.timeIntervalSince(FlexibleDate.parse("2026-10-27T16:00:00Z")!) - 0.123) < 0.001)
  }

  @Test func meetingsListAndPageURL() async throws {
    let (api, _) = client { _ in
      (200, #"{"meetings":[{"id":"m1","title":"A","startsAt":"2026-10-27T16:00:00Z","status":"done","visibility":"team"},{"id":"m2","title":"B","url":"/m/m2"}]}"#, [:])
    }
    let list = try await api.meetings()
    #expect(list.map(\.id) == ["m1", "m2"])
    let app = URL(string: "https://talk.example.com")!
    #expect(list[0].pageURL(appURL: app).absoluteString == "https://talk.example.com/meetings/m1")
    #expect(list[1].pageURL(appURL: app).absoluteString == "https://talk.example.com/m/m2")
    let bare = try JSONDecoder().decode(MeetingList.self, from: Data(#"[{"id":"x","title":"X"}]"#.utf8))
    #expect(bare.meetings.count == 1)
  }

  @Test func unauthorizedMeansSignedOut() async {
    let (api, _) = client { _ in (401, "", [:]) }
    await #expect(throws: APIError.signedOut) { try await api.me() }
  }

  @Test func serverErrorsCarryTheirMessage() async {
    let (api, _) = client { _ in (500, #"{"error":"internal","message":"D1 is down"}"#, [:]) }
    await #expect(throws: APIError.server(status: 500, code: "internal", message: "D1 is down")) { try await api.me() }
  }

  @Test func htmlLoginPageIsReported() async {
    let (api, _) = client { _ in (200, "<html>login</html>", ["Content-Type": "text/html"]) }
    await #expect {
      try await api.me()
    } throws: { error in
      if case APIError.server(200, _, _) = error { return true }
      return false
    }
  }

  /// Renews on a 401, the way the helper's `token.needed` → `token.update` does.
  final class RenewingAuth: AuthProvider, @unchecked Sendable {
    let appURL = URL(string: "https://talk.example.com")!
    private let lock = NSLock()
    private var current = "stale"
    func accessToken() async throws -> String { lock.withLock { current } }
    func tokenRejected(_ token: String) async throws -> String { lock.withLock { current = "fresh"; return current } }
  }

  @Test func retriesOnceWithTheRenewedToken() async throws {
    let stub = StubTransport { request in
      request.value(forHTTPHeaderField: "Authorization") == "Bearer fresh" ? (200, #"{"user":{"id":"u"}}"#, [:]) : (401, "", [:])
    }
    let me = try await APIClient(auth: RenewingAuth(), transport: stub).me()
    #expect(me.id == "u")
    #expect(stub.requests.map { $0.value(forHTTPHeaderField: "Authorization") } == ["Bearer stale", "Bearer fresh"])
  }
}

@Suite struct FallbackTests {
  @Test func wavHeader() {
    let wav = WAV.encode(pcm16: Data(count: 48_000))
    #expect(wav.count == 48_044)
    #expect(String(decoding: wav.prefix(4), as: UTF8.self) == "RIFF")
    #expect(String(decoding: wav[8..<16], as: UTF8.self) == "WAVEfmt ")
    let rate = wav[24..<28].withUnsafeBytes { $0.loadUnaligned(as: UInt32.self) }
    #expect(UInt32(littleEndian: rate) == 24_000)
    let size = wav[40..<44].withUnsafeBytes { $0.loadUnaligned(as: UInt32.self) }
    #expect(UInt32(littleEndian: size) == 48_000)
  }

  @Test func routeNotAllowedCarriesItsCode() async {
    let stub = StubTransport { _ in (503, #"{"error":"ai_route_not_allowed","message":"Ask your operator"}"#, [:]) }
    let api = APIClient(auth: AccessTokenAuthProvider(appURL: URL(string: "https://talk.example.com")!, token: "t"), transport: stub)
    do {
      _ = try await api.transcriptionToken(meetingID: "m", source: "mic", language: nil)
      Issue.record("expected a refusal")
    } catch let error as APIError {
      #expect(error.code == "ai_route_not_allowed")
      #expect(error.localizedDescription == "Ask your operator")
    } catch {
      Issue.record("unexpected \(error)")
    }
  }

  @Test func audioChunkIsMultipart() async throws {
    let stub = StubTransport { _ in
      (201, #"{"segment":{"seq":3,"startedMs":0,"endedMs":1000,"speaker":"them","text":"hello"}}"#, [:])
    }
    let api = APIClient(auth: AccessTokenAuthProvider(appURL: URL(string: "https://talk.example.com")!, token: "t"), transport: stub)
    let segment = try await api.appendAudioChunk(
      meetingID: "m1", wav: WAV.encode(pcm16: Data(count: 10)), seq: 3, startedMs: 0, endedMs: 1000, speaker: .them, language: "en")
    #expect(segment?.text == "hello")
    let request = stub.requests[0]
    #expect(request.url?.path == "/api/v1/meetings/m1/audio-chunk")
    let type = request.value(forHTTPHeaderField: "Content-Type")!
    #expect(type.hasPrefix("multipart/form-data; boundary="))
    let boundary = String(type.split(separator: "=", maxSplits: 1)[1])
    let body = String(decoding: request.httpBody!, as: UTF8.self)
    #expect(body.contains("--\(boundary)\r\nContent-Disposition: form-data; name=\"seq\"\r\n\r\n3\r\n"))
    #expect(body.contains("name=\"speaker\"\r\n\r\nthem\r\n"))
    #expect(body.contains("name=\"file\"; filename=\"chunk-3.wav\"\r\nContent-Type: audio/wav"))
    #expect(body.hasSuffix("--\(boundary)--\r\n"))
  }
}
