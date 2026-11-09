import Foundation
import Testing
import HelperCore
@testable import HelperRecording

/// `/segments` gets at most 50 per request, oldest first, and a failure stops the drain so seqs
/// stay in order (Codex pass 4: a 300-segment backlog in one request got a 500).
@Suite @MainActor struct PostBatchTests {
  /// Answers `/segments` by request number (1-based); keys and /finish always succeed.
  final class Worker: @unchecked Sendable {
    private let lock = NSLock()
    private var count = 0
    var offline = false
    let transport: FakeWorker

    init(segments: @escaping @Sendable (Int) -> Int = { _ in 204 }) {
      var me: Worker!
      transport = FakeWorker { path, _ in
        switch path {
        case "/api/v1/meetings/m1/transcription-token": return (200, #"{"value":"ek","expiresAt":4102444800}"#)
        case "/api/v1/meetings/m1/segments":
          let (n, offline) = me.lock.withLock { () -> (Int, Bool) in
            me.count += 1
            return (me.count, me.offline)
          }
          let status = offline ? 503 : segments(n)
          return (status, status < 300 ? "" : #"{"error":"x","message":"status \#(status)"}"#)
        case "/api/v1/meetings/m1/finish": return (202, "{}")
        default: return (404, "")
        }
      }
      me = self
    }

    func setOffline(_ value: Bool) { lock.withLock { offline = value } }

    /// Every `/segments` request body, in order (failed ones included).
    func batches() throws -> [[Segment]] {
      try transport.requests.filter { $0.url!.path.hasSuffix("/segments") }.map { try JSONDecoder().decode([Segment].self, from: $0.httpBody!) }
    }
  }

  func pipeline(_ worker: Worker, rig: FakeRig, flushEvery: TimeInterval = 3_600, events: Output) -> RecordingPipeline {
    var deps = rig.dependencies
    deps.flushInterval = flushEvery
    deps.finalRetryDelay = .milliseconds(1)
    return RecordingPipeline(
      meetingID: "m1",
      api: APIClient(auth: AccessTokenAuthProvider(appURL: URL(string: "https://t.example.com")!, token: "t"), transport: worker.transport),
      language: "en", dependencies: deps
    ) { event in if case .segment = event { events.write("s") } }
  }

  /// 300 of my turns, 100 ms apart.
  func speak300(_ rig: FakeRig, _ events: Output) async {
    for _ in 0..<300 { rig.mic?.speak() }
    _ = await events.waitFor { events.lines.count == 300 }
  }

  @Test func aBacklogOf300PostsInFiftiesInOrder() async throws {
    let rig = FakeRig(), events = Output(), worker = Worker()
    let p = pipeline(worker, rig: rig, events: events)
    try await p.start()
    await speak300(rig, events)
    #expect(events.lines.count == 300)
    let result = await p.stop()
    let batches = try worker.batches()
    #expect(batches.map(\.count) == [50, 50, 50, 50, 50, 50])
    let seqs = batches.flatMap { $0.map(\.seq) }
    #expect(seqs == seqs.sorted() && Set(seqs).count == 300)
    #expect(result == RecordingPipeline.StopResult(segments: 300, problem: nil, finished: true, unsaved: []))
  }

  @Test func theBacklogAfterAnOutageGoesOutInFiftiesToo() async throws {
    let rig = FakeRig(), events = Output(), worker = Worker()
    worker.setOffline(true)
    let p = pipeline(worker, rig: rig, flushEvery: 0.01, events: events)
    try await p.start()
    await speak300(rig, events)
    worker.setOffline(false)  // back: the periodic flush drains the backlog
    #expect(await events.waitFor { (try? worker.batches().suffix(6).map(\.count)) == [50, 50, 50, 50, 50, 50] })
    let batches = try worker.batches()
    #expect(batches.allSatisfy { $0.count <= 50 })  // never more, offline attempts included
    let posted = batches.suffix(6).flatMap { $0.map(\.seq) }
    #expect(posted == posted.sorted() && Set(posted).count == 300)
    #expect(await p.stop().segments == 300)
  }

  @Test func aFailureStopsTheDrainAndTheRestComesBackInOrder() async throws {
    // Requests 1–2 go through; from the 3rd on the Worker is down.
    let rig = FakeRig(), events = Output(), worker = Worker(segments: { $0 <= 2 ? 204 : 503 })
    let p = pipeline(worker, rig: rig, events: events)
    try await p.start()
    await speak300(rig, events)
    let result = await p.stop()
    let batches = try worker.batches()
    // Batch 3 tried 3 times, batches 4–6 never sent ahead of it.
    #expect(batches.count == 5)
    #expect(batches[2] == batches[3] && batches[3] == batches[4])
    #expect(result.segments == 100)
    #expect(result.finished == false)
    #expect(result.unsaved.count == 200)
    #expect(result.unsaved.map(\.seq) == result.unsaved.map(\.seq).sorted())
    #expect(result.unsaved.first?.seq == batches[2].first?.seq)
  }

  @Test func aPermanentRefusalIsHandedBackNotRetried() async throws {
    let rig = FakeRig(), events = Output(), worker = Worker(segments: { $0 == 2 ? 400 : 204 })
    let p = pipeline(worker, rig: rig, events: events)
    try await p.start()
    await speak300(rig, events)
    let result = await p.stop()
    let batches = try worker.batches()
    #expect(batches.count == 6)  // the refused batch once, no retries; the rest posted
    #expect(result.segments == 250)
    #expect(result.unsaved == batches[1])
    #expect(result.finished == false)  // /finish waits for the app's replay
    #expect(result.problem?.contains("refused") == true)
    #expect(!worker.transport.paths().contains("/api/v1/meetings/m1/finish"))
  }

  @Test func conflictsAndRateLimitsAreRetried() async throws {
    for status in [409, 429] {
      let rig = FakeRig(), events = Output(), worker = Worker(segments: { $0 == 1 ? status : 204 })
      let p = pipeline(worker, rig: rig, events: events)
      try await p.start()
      rig.mic?.speak()
      _ = await events.waitFor { events.lines.count == 1 }
      let result = await p.stop()
      #expect(result == RecordingPipeline.StopResult(segments: 1, problem: nil, finished: true, unsaved: []), "HTTP \(status)")
      #expect(try worker.batches().count == 2)
    }
  }

  @Test func permanentMeansA4xxARetryWontChange() {
    #expect(APIError.server(status: 400, message: nil).isPermanentRefusal)
    #expect(APIError.server(status: 413, message: nil).isPermanentRefusal)
    #expect(APIError.server(status: 422, message: nil).isPermanentRefusal)
    for transient in [401, 408, 409, 429, 500, 503] { #expect(!APIError.server(status: transient, message: nil).isPermanentRefusal) }
    #expect(!APIError.signedOut.isPermanentRefusal)
  }
}
