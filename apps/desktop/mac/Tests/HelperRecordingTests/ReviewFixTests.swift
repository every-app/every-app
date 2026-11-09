import Foundation
import Testing
import HelperCore
@testable import HelperRecording

/// Regressions for the #4 review: stop racing a pending start, the final flush racing a
/// periodic one, and the fallback's unbounded upload backlog.
@Suite @MainActor struct StopDuringStartTests {
  let rig = FakeRig()
  let out = Output()

  static let start = #"{"id":1,"cmd":"record.start","params":{"meetingId":"m1","apiBase":"https://talk.example.com","accessToken":"t"}}"#

  @Test func stopWhileTheMicPromptIsUpCancelsTheStart() async {
    let prompt = Gate()
    var env = environment(worker: .happy(), rig: rig)
    env.requestMic = {
      await prompt.wait()
      return true
    }
    let out = self.out
    let s = HelperServer(environment: env, write: { out.write($0) })
    let start = Task { await s.handle(Self.start) }
    #expect(await out.waitFor { prompt.arrived == 1 })
    await s.handle(#"{"id":2,"cmd":"record.stop"}"#)
    #expect(out.response(2)?["result"] == ["segments": 0, "cancelled": true])
    prompt.release()
    await start.value
    #expect(out.response(1)?["error"]?["code"] == "cancelled")
    #expect(rig.mic == nil && rig.system == nil)
    #expect(!s.isRecording)
  }

  @Test func stopWhileKeysAreBeingFetchedNeverCaptures() async {
    let keys = Gate()
    let worker = FakeWorker.happy()
    worker.hold = { path, _ in if path.hasSuffix("/transcription-token") { await keys.wait() } }
    let out = self.out
    let s = HelperServer(environment: environment(worker: worker, rig: rig), write: { out.write($0) })
    let start = Task { await s.handle(Self.start) }
    #expect(await out.waitFor { keys.arrived == 2 })
    await s.handle(#"{"id":2,"cmd":"record.stop"}"#)
    #expect(out.response(2)?["result"]?["cancelled"] == true)
    keys.release()
    await start.value
    #expect(out.response(1)?["error"]?["code"] == "cancelled")
    #expect(rig.mic == nil && rig.system == nil)
    #expect(!s.isRecording)
    #expect(!worker.paths().contains("/api/v1/meetings/m1/finish"))
    // A new start works afterwards.
    worker.hold = nil
    await s.handle(Self.start.replacingOccurrences(of: "\"id\":1", with: "\"id\":3"))
    #expect(out.response(3)?["ok"] == true)
    await s.handle(#"{"id":4,"cmd":"record.stop"}"#)
    #expect(out.response(4)?["result"] == ["segments": 0, "finished": true])
  }
}

@Suite @MainActor struct FinalFlushTests {
  @Test func finishWaitsForAPostInFlightAndTheRest() async throws {
    let rig = FakeRig()
    let firstPost = Gate()
    let worker = FakeWorker.happy()
    worker.hold = { path, index in if path.hasSuffix("/segments"), index == 0 { await firstPost.wait() } }
    var deps = rig.dependencies
    deps.flushInterval = 0.02
    let segments = Output()
    let pipeline = RecordingPipeline(
      meetingID: "m1", api: APIClient(auth: AccessTokenAuthProvider(appURL: URL(string: "https://t.example.com")!, token: "t"), transport: worker),
      language: "en", dependencies: deps
    ) { event in if case .segment(let s) = event { segments.write("\(s.seq)") } }
    try await pipeline.start()
    rig.mic?.speak()
    // The periodic flush is now stuck posting segment 0.
    let out = Output()
    #expect(await out.waitFor { firstPost.arrived == 1 })
    rig.system?.speak()
    #expect(await segments.waitFor { segments.lines.count == 2 })
    let stop = Task { await pipeline.stop() }
    // Give stop every chance to (wrongly) reach /finish while the post is held. Only a broken
    // stop could make this fail; a slow runner can't.
    try await Task.sleep(for: .milliseconds(50))
    #expect(!worker.paths().contains("/api/v1/meetings/m1/finish"))
    firstPost.release()
    let result = await stop.value
    #expect(result == RecordingPipeline.StopResult(segments: 2, problem: nil))
    #expect(worker.completed == ["/api/v1/meetings/m1/transcription-token", "/api/v1/meetings/m1/transcription-token",
      "/api/v1/meetings/m1/segments", "/api/v1/meetings/m1/segments", "/api/v1/meetings/m1/finish"])
  }
}

@Suite struct FallbackBacklogTests {
  /// 30 s of a tone: one full chunk.
  static let thirtySeconds = PCM16.encode((0..<(24_000 * 30)).map { sin(Float($0) / 10) * 0.2 })

  final class Events: @unchecked Sendable {
    let lock = NSLock()
    var backlog: [String] = []
    var problems: [String] = []
    var stored = 0
  }

  func channel(
    limits: ChunkChannel.Limits, events: Events,
    upload: @escaping @Sendable (Data, Int, Int, Int) async throws -> Segment?
  ) -> ChunkChannel {
    ChunkChannel(
      speaker: .them, language: "en", seqFor: { $0 }, upload: upload,
      callbacks: ChannelCallbacks(
        segment: { _, _, _, _ in },
        stored: { _ in events.lock.withLock { events.stored += 1 } },
        delta: { _, _, _ in },
        problem: { _, p in if let p { events.lock.withLock { events.problems.append(p) } } },
        backlog: { _, m in events.lock.withLock { events.backlog.append(m) } }),
      limits: limits)
  }

  @Test func aStuckUploadDropsTheOldestWaitingChunks() async {
    let stuck = Gate()
    let seqs = Output()
    let clock = ManualClock()
    var limits = ChunkChannel.Limits()
    limits.maxQueuedBytes = 3 << 20  // two 30 s chunks (~1.4 MB each)
    limits.now = { clock.now }  // frozen: only the byte limit applies
    let events = Events()
    let c = channel(limits: limits, events: events) { _, seq, _, _ in
      seqs.write("\(seq)")
      await stuck.wait()
      return nil
    }
    for _ in 0..<6 { await c.feed(Self.thirtySeconds) }
    #expect(await seqs.waitFor { seqs.lines == ["0"] })
    // Chunk 0 is uploading; 1–5 waited, and only the newest two fit.
    #expect(await c.queuedCount == 2)
    #expect(await c.queuedBytes <= limits.maxQueuedBytes)
    #expect(events.lock.withLock { events.backlog.count } == 3)
    #expect(events.lock.withLock { events.backlog.first }?.contains("30 s of audio was dropped") == true)
    stuck.release()
    await c.finish()
    #expect(seqs.lines == ["0", "120000", "150000"])  // seq = start ms here: chunks 0, 4 and 5
  }

  @Test func oldChunksAreDroppedByAge() async {
    let stuck = Gate()
    let seqs = Output()
    let clock = ManualClock()
    var limits = ChunkChannel.Limits()
    limits.maxQueuedAge = .seconds(180)
    limits.now = { clock.now }
    let events = Events()
    let c = channel(limits: limits, events: events) { _, seq, _, _ in
      seqs.write("\(seq)")
      await stuck.wait()
      return nil
    }
    await c.feed(Self.thirtySeconds)
    #expect(await seqs.waitFor { seqs.lines == ["0"] })  // chunk 0 is uploading
    await c.feed(Self.thirtySeconds)  // chunk 1 waits
    clock.advance(by: .seconds(181))
    await c.feed(Self.thirtySeconds)  // chunk 2 arrives; chunk 1 is now too old
    #expect(await c.queuedCount == 1)
    #expect(events.lock.withLock { events.backlog.count } == 1)
    stuck.release()
    await c.finish()
    #expect(seqs.lines == ["0", "60000"])  // chunks 0 and 2
  }

  @Test func anUploadThatHangsTimesOutAndGivesUp() async {
    let attempts = Output()
    var limits = ChunkChannel.Limits()
    limits.uploadTimeout = .milliseconds(20)
    limits.retryBase = .milliseconds(1)
    let events = Events()
    let c = channel(limits: limits, events: events) { _, seq, _, _ in
      attempts.write("\(seq)")
      try await Task.sleep(for: .seconds(3600))
      return nil
    }
    await c.feed(Self.thirtySeconds)
    await c.finish()
    #expect(attempts.lines == ["0", "0", "0"])
    #expect(events.lock.withLock { events.problems.count } == 1)
    #expect(events.lock.withLock { events.problems.first }?.contains("took too long") == true)
  }
}
