import Foundation
import Testing

import HelperCore
@testable import HelperRecording

/// A person's own transcription server: what the channel does while it's down, and that a
/// recording set to use it sends audio nowhere else.
@Suite struct OwnServerChannelTests {
  /// 30 s of a tone: one full chunk.
  static let thirtySeconds = PCM16.encode((0..<(24_000 * 30)).map { sin(Float($0) / 10) * 0.2 })

  final class Heard: @unchecked Sendable {
    let lock = NSLock()
    var segments: [(Int, Int, String)] = []
    var problems: [String?] = []
    var backlog: [String] = []
    var attempts = 0
    var answering = false

    var texts: [String] { lock.withLock { segments.map(\.2) } }
    var attemptCount: Int { lock.withLock { attempts } }
    var backlogs: [String] { lock.withLock { backlog } }
    /// The problems said, without the all-clears.
    var said: [String] { lock.withLock { problems.compactMap { $0 } } }
  }

  static var fast: OwnServerChannel.Limits {
    var limits = OwnServerChannel.Limits()
    limits.retryBase = .milliseconds(5)
    limits.retryMax = .milliseconds(5)
    return limits
  }

  /// A channel whose server answers "chunk <start ms>" once `heard.answering`, and fails with
  /// `failure` until then.
  func channel(_ heard: Heard, limits: OwnServerChannel.Limits = OwnServerChannelTests.fast, failure: TranscriptionServerError = .unreachable(host: "localhost:50060"))
    -> OwnServerChannel
  {
    OwnServerChannel(
      speaker: .them, language: "en",
      transcribe: { wav, _ in
        let up = heard.lock.withLock {
          heard.attempts += 1
          return heard.answering
        }
        guard up else { throw failure }
        return "chunk of \(wav.count) bytes"
      },
      callbacks: ChannelCallbacks(
        segment: { _, t0, t1, text in heard.lock.withLock { heard.segments.append((t0, t1, text)) } },
        stored: { _ in }, delta: { _, _, _ in },
        problem: { _, p in heard.lock.withLock { heard.problems.append(p) } },
        backlog: { _, m in heard.lock.withLock { heard.backlog.append(m) } }),
      limits: limits)
  }

  @Test func aDownServerKeepsTheAudioAndRetriesTheSameChunk() async {
    let heard = Heard()
    let c = channel(heard)
    await c.feed(Self.thirtySeconds)
    await c.feed(Self.thirtySeconds)
    #expect(await Output().waitFor { heard.attemptCount >= 4 })
    // Still the first chunk, the second waits behind it, and the person was told once.
    #expect(heard.texts.isEmpty)
    #expect(await c.queuedCount == 1)
    #expect(heard.said == ["Your transcription server at localhost:50060 isn't answering. Your audio is kept for up to 5 minutes and sent when it answers."])
    #expect(heard.backlogs.isEmpty)

    heard.lock.withLock { heard.answering = true }
    await c.finish()
    let segments = heard.lock.withLock { heard.segments }
    #expect(segments.map(\.0) == [0, 30_000])
    #expect(segments.map(\.1) == [30_000, 60_000])
    #expect(heard.lock.withLock { heard.problems.last! } == nil)  // all clear
    #expect(await c.queuedCount == 0)
  }

  @Test func pastFiveMinutesTheOldestWaitingAudioGoes() async {
    let heard = Heard()
    var limits = Self.fast
    limits.maxQueuedBytes = 2 * Self.thirtySeconds.count
    let c = channel(heard, limits: limits)
    for _ in 0..<5 { await c.feed(Self.thirtySeconds) }
    // Chunk 0 is being retried; of the four waiting, the newest two fit.
    #expect(await c.queuedCount == 2)
    #expect(heard.backlogs == ["Your transcription server didn't answer for over 5 minutes, so the oldest audio from the wait was dropped."])
    heard.lock.withLock { heard.answering = true }
    await c.finish()
    #expect(heard.lock.withLock { heard.segments.map(\.0) } == [0, 90_000, 120_000])
  }

  @Test func stopGivesUpOnADeadServerAndSaysWhatWasLost() async {
    let heard = Heard()
    let c = channel(heard)
    await c.feed(Self.thirtySeconds)
    await c.feed(Self.thirtySeconds)
    #expect(await Output().waitFor { heard.attemptCount >= 1 })
    await c.finish()  // returns: two more tries, then both chunks are given up
    #expect(heard.texts.isEmpty)
    #expect(heard.backlogs == ["60 s of audio couldn't be transcribed. Your transcription server at localhost:50060 isn't answering."])
    #expect(await c.queuedCount == 0)
  }

  @Test func aRefusedChunkIsNotRetried() async {
    let heard = Heard()
    let c = channel(heard, failure: .status(401, message: nil))
    await c.feed(Self.thirtySeconds)
    #expect(await Output().waitFor { !heard.backlogs.isEmpty })
    #expect(heard.attemptCount == 1)
    #expect(heard.backlogs == ["30 s of audio couldn't be transcribed. Your transcription server refused the API key (HTTP 401)."])
    await c.cancel()
  }
}

@Suite @MainActor struct OwnServerRecordingTests {
  let rig = FakeRig()
  let out = Output()

  static let start =
    #"{"id":10,"cmd":"record.start","params":{"meetingId":"m1","apiBase":"https://talk.example.com","accessToken":"t","transcription":{"baseUrl":"http://localhost:50060/v1","model":"large-v3","apiKey":"sk-local"}}}"#

  /// Scribe (segments, finish; it would also mint keys and take audio chunks) and the person's
  /// server at /v1/audio/transcriptions, which answers `status`.
  func worker(server status: @escaping @Sendable () -> Int = { 200 }) -> FakeWorker {
    FakeWorker { path, _ in
      switch path {
      case "/v1/audio/transcriptions": (status(), status() == 200 ? #"{"text":"From my own server."}"# : #"{"error":{"message":"no"}}"#)
      case "/api/v1/meetings/m1/transcription-token": (200, #"{"value":"ek_abc","expiresAt":4102444800,"model":"gpt-live-transcribe"}"#)
      case "/api/v1/meetings/m1/audio-chunk": (201, "{}")
      case "/api/v1/meetings/m1/segments": (204, "")
      case "/api/v1/meetings/m1/finish": (202, #"{"ok":true}"#)
      default: (404, "")
      }
    }
  }

  func server(_ worker: FakeWorker) -> HelperServer {
    let out = self.out
    return HelperServer(environment: environment(worker: worker, rig: rig), write: { out.write($0) })
  }

  @Test func audioGoesOnlyToThePersonsServerAndTheTextToScribe() async throws {
    let worker = worker()
    let s = server(worker)
    await s.handle(Self.start)
    #expect(out.response(10)?["ok"] == true)
    #expect(out.events("state").last?["mode"] == "custom")

    // Five seconds from the other side, then stop: one chunk.
    rig.system?.onAudio(PCM16.encode((0..<(5_000 * 24)).map { sin(Float($0) / 10) * 0.2 }))
    await s.handle(#"{"id":11,"cmd":"record.stop"}"#)
    #expect(out.response(11)?["result"] == ["segments": 1, "finished": true])

    // No Realtime key was asked for and no audio went to Scribe.
    let paths = worker.paths()
    #expect(!paths.contains("/api/v1/meetings/m1/transcription-token"))
    #expect(!paths.contains("/api/v1/meetings/m1/audio-chunk"))
    #expect(Set(paths) == ["/v1/audio/transcriptions", "/api/v1/meetings/m1/segments", "/api/v1/meetings/m1/finish"])
    // Every request with audio in it went to the address set, with the person's key (not Scribe's token).
    let audio = worker.requests.filter { ($0.value(forHTTPHeaderField: "Content-Type") ?? "").hasPrefix("multipart/") }
    #expect(audio.count == 2)  // the start check, then the chunk
    #expect(audio.allSatisfy { $0.url?.absoluteString == "http://localhost:50060/v1/audio/transcriptions" })
    #expect(audio.allSatisfy { $0.value(forHTTPHeaderField: "Authorization") == "Bearer sk-local" })
    let posted = try JSONDecoder().decode([Segment].self, from: worker.requests.first { $0.url!.path.hasSuffix("/segments") }!.httpBody!)
    #expect(posted.map(\.text) == ["From my own server."])
    #expect(posted.first?.speaker == .them)
  }

  @Test func aServerThatRefusesStopsTheStartInsteadOfFallingBack() async {
    let worker = worker(server: { 401 })
    let s = server(worker)
    await s.handle(Self.start)
    #expect(out.response(10)?["error"]?["code"] == "transcription_server")
    #expect(
      out.response(10)?["error"]?["message"]
        == "Your transcription server refused the API key (HTTP 401): no. Start it, or turn off your own server in Settings → Transcription.")
    #expect(!s.isRecording)
    #expect(rig.mic == nil)
    #expect(worker.paths() == ["/v1/audio/transcriptions"])
  }

  @Test func aBusyServerStillRecords() async {
    let s = server(worker(server: { 503 }))
    await s.handle(Self.start)
    #expect(out.response(10)?["ok"] == true)
    #expect(out.events("state").last?["mode"] == "custom")
    await s.shutdown()
  }

  @Test func aBadAddressIsRefused() async {
    let s = server(worker())
    await s.handle(
      #"{"id":1,"cmd":"record.start","params":{"meetingId":"m1","apiBase":"https://talk.example.com","accessToken":"t","transcription":{"baseUrl":"http://whisper.example.com/v1","model":"m"}}}"#)
    await s.handle(
      #"{"id":2,"cmd":"record.start","params":{"meetingId":"m1","apiBase":"https://talk.example.com","accessToken":"t","transcription":{"baseUrl":"http://localhost:1/v1"}}}"#)
    for id in 1...2 { #expect(out.response(id)?["error"]?["code"] == "bad_params") }
    #expect(!s.isRecording)
  }

  @Test func theTestCommandSaysWhetherTheServerAnswers() async {
    let s = server(worker())
    await s.handle(#"{"id":1,"cmd":"transcribe.test","params":{"baseUrl":"localhost:50060/v1","model":"large-v3"}}"#)
    #expect(out.response(1)?["result"]?["text"] == "From my own server.")
    #expect(out.response(1)?["result"]?["endpoint"] == "http://localhost:50060/v1/audio/transcriptions")
    #expect(out.response(1)?["result"]?["ms"]?.int != nil)

    let down = server(worker(server: { 404 }))
    await down.handle(#"{"id":2,"cmd":"transcribe.test","params":{"baseUrl":"localhost:50060/v1","model":"large-v3"}}"#)
    #expect(out.response(2)?["error"]?["code"] == "transcription_server")
    await down.handle(#"{"id":3,"cmd":"transcribe.test","params":{"model":"large-v3"}}"#)
    #expect(out.response(3)?["error"]?["code"] == "bad_params")
  }
}
