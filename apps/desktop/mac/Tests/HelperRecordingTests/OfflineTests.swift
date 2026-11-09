import Foundation
import Testing
import HelperCore
@testable import HelperRecording

/// Offline robustness (M3): unsaved segments are handed back on stop instead of lost, and
/// `state.transcription` says when transcription is reconnecting.
@Suite @MainActor struct OfflineStopTests {
  static let start = #"{"id":1,"cmd":"record.start","params":{"meetingId":"m1","apiBase":"https://t.example.com","accessToken":"t"}}"#

  func server(_ worker: FakeWorker, _ rig: FakeRig, _ out: Output) -> HelperServer {
    HelperServer(environment: environment(worker: worker, rig: rig), write: { out.write($0) })
  }

  /// Keys mint (the recording started online); then segment posts and /finish can't get through.
  static func offlineAfterStart(segments: Int = 503, finish: Int = 503) -> FakeWorker {
    FakeWorker { path, _ in
      switch path {
      case "/api/v1/meetings/m1/transcription-token": (200, #"{"value":"ek","expiresAt":4102444800}"#)
      case "/api/v1/meetings/m1/segments": (segments, segments == 204 ? "" : #"{"error":"unavailable"}"#)
      case "/api/v1/meetings/m1/finish": (finish, finish == 202 ? "{}" : #"{"error":"unavailable"}"#)
      default: (404, "")
      }
    }
  }

  @Test func offlineStopHandsBackTheSegmentsAndDoesntFinish() async throws {
    let rig = FakeRig()
    let out = Output()
    let worker = Self.offlineAfterStart()
    let s = server(worker, rig, out)
    await s.handle(Self.start)
    rig.mic?.speak()
    rig.system?.speak()
    #expect(await out.waitFor { out.events("transcript.segment").count == 2 })
    await s.handle(#"{"id":2,"cmd":"record.stop"}"#)
    let result = try #require(out.response(2)?["result"])
    #expect(result["segments"] == 0)
    #expect(result["finished"] == false)
    guard case .array(let unsaved)? = result["unsaved"] else { Issue.record("no unsaved"); return }
    #expect(unsaved.compactMap { $0["seq"]?.int }.sorted() == [0, 2])
    #expect(unsaved.contains { $0 == ["seq": 0, "speaker": "me", "text": "me turn 1", "startedMs": 0, "endedMs": 100] })
    // Notes would miss the unsaved segments: /finish is left to the app's replay.
    #expect(!worker.paths().contains("/api/v1/meetings/m1/finish"))
    #expect(out.events("error").contains { $0["code"] == "save_failed" })
  }

  @Test func onlyFinishFailing() async throws {
    let rig = FakeRig()
    let out = Output()
    let s = server(Self.offlineAfterStart(segments: 204, finish: 503), rig, out)
    await s.handle(Self.start)
    rig.mic?.speak()
    #expect(await out.waitFor { out.events("transcript.segment").count == 1 })
    await s.handle(#"{"id":2,"cmd":"record.stop"}"#)
    #expect(out.response(2)?["result"] == ["segments": 1, "finished": false])
    #expect(out.events("error").contains { $0["code"] == "save_failed" })
  }

  @Test func theConnectionDropsMidMeeting() async throws {
    // The first segments post goes through; then the network is gone.
    final class Posts: @unchecked Sendable {
      let lock = NSLock()
      var count = 0
      func next() -> Int { lock.withLock { count += 1; return count } }
    }
    let posts = Posts()
    let worker = FakeWorker { path, _ in
      switch path {
      case "/api/v1/meetings/m1/transcription-token": (200, #"{"value":"ek","expiresAt":4102444800}"#)
      case "/api/v1/meetings/m1/segments": posts.next() == 1 ? (204, "") : (503, "{}")
      default: (503, "{}")
      }
    }
    let rig = FakeRig()
    let out = Output()
    var deps = rig.dependencies
    deps.flushInterval = 0.01  // the periodic flush posts segment 0
    let p = RecordingPipeline(
      meetingID: "m1",
      api: APIClient(auth: AccessTokenAuthProvider(appURL: URL(string: "https://t.example.com")!, token: "t"), transport: worker),
      language: "en", dependencies: deps
    ) { event in if case .segment(let seg) = event { out.write("\(seg.seq)") } }
    try await p.start()
    rig.mic?.speak()
    #expect(await out.waitFor { worker.completed.contains("/api/v1/meetings/m1/segments") })
    rig.mic?.speak()
    rig.mic?.speak()
    #expect(await out.waitFor { out.lines.count == 3 })
    let result = await p.stop()
    #expect(result.segments == 1)
    #expect(result.finished == false)
    #expect(result.unsaved.map(\.seq) == [400, 800])  // turns 2 and 3, at 100 and 200 ms
    #expect(result.unsaved.map(\.text) == ["me turn 2", "me turn 3"])
    #expect(result.problem?.contains("couldn't be saved") == true)
  }
}

@Suite @MainActor struct TranscriptionStateTests {
  @Test func reconnectingWhileAnySpeakerIsDown() async throws {
    let rig = FakeRig()
    let out = Output()
    let s = HelperServer(environment: environment(worker: .happy(), rig: rig), write: { out.write($0) })
    await s.handle(OfflineStopTests.start)
    #expect(out.events("state").last?["transcription"] == "live")
    let me = try #require(rig.channel(.me))
    let them = try #require(rig.channel(.them))

    await me.report("The connection to OpenAI dropped")
    #expect(await out.waitFor { out.events("state").last?["transcription"] == "reconnecting" })
    let states = out.events("state").count
    await them.report("Can't reach transcription: offline")
    // Still reconnecting: no new state for the second speaker.
    #expect(await out.waitFor { out.events("error").filter { $0["code"] == "transcription" }.count == 2 })
    #expect(out.events("state").count == states)
    await me.report(nil)
    #expect(out.events("state").count == states)
    await them.report(nil)
    #expect(await out.waitFor { out.events("state").last?["transcription"] == "live" })
    #expect(out.events("state").count == states + 1)
    await s.handle(#"{"id":2,"cmd":"record.stop"}"#)
  }
}
