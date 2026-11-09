import Foundation
import Testing
import HelperCore
@testable import HelperRecording

/// stdin closing must exit fast when idle, never wait on a permission prompt, and still finish
/// a recording properly.
@Suite @MainActor struct ShutdownTests {
  @Test func idleShutdownDoesNothingToWaitFor() async {
    let tracker = RequestTracker(sleep: { _ in Issue.record("nothing pending: no grace wait") })
    #expect(await tracker.drain())
  }

  @Test func drainEndsWhenTheLastRequestAnswers() async {
    let never = Gate()
    let tracker = RequestTracker(sleep: { _ in await never.wait() })
    tracker.begin()
    tracker.begin()
    let drain = Task { await tracker.drain() }
    tracker.end()
    tracker.end()
    #expect(await drain.value)
    never.release()
  }

  @Test func aRequestStuckOnAPromptDoesntHoldTheExit() async {
    let tracker = RequestTracker(sleep: { _ in })  // the grace passes at once
    tracker.begin()
    #expect(await tracker.drain() == false)
    #expect(tracker.pending == 1)
  }

  @Test func shutdownDoesntWaitForAMicPrompt() async {
    let rig = FakeRig()
    let prompt = Gate()
    var env = environment(worker: .happy(), rig: rig)
    env.requestMic = {
      await prompt.wait()
      return true
    }
    let out = Output()
    let s = HelperServer(environment: env, write: { out.write($0) })
    let tracker = RequestTracker(sleep: { _ in })
    tracker.begin()
    let request = Task {
      await s.handle(#"{"id":1,"cmd":"permissions.request","params":{"kind":"mic"}}"#)
      tracker.end()
    }
    tracker.begin()
    let start = Task {
      await s.handle(#"{"id":2,"cmd":"record.start","params":{"meetingId":"m1","apiBase":"https://t.example.com","accessToken":"t"}}"#)
      tracker.end()
    }
    #expect(await out.waitFor { prompt.arrived == 2 })
    // Both are on the prompt. Shutdown returns at once and the drain gives up after its grace.
    await s.shutdown()
    #expect(await tracker.drain() == false)
    #expect(!s.isRecording)
    // If the prompt is answered later, the start must not capture.
    prompt.release()
    await request.value
    await start.value
    #expect(out.response(2)?["error"]?["code"] == "cancelled")
    #expect(rig.mic == nil)
  }

  @Test func shutdownWaitsForARecordStopInProgress() async {
    let rig = FakeRig()
    let finish = Gate()
    let worker = FakeWorker.happy()
    worker.hold = { path, _ in if path.hasSuffix("/finish") { await finish.wait() } }
    let out = Output()
    let s = HelperServer(environment: environment(worker: worker, rig: rig), write: { out.write($0) })
    await s.handle(#"{"id":1,"cmd":"record.start","params":{"meetingId":"m1","apiBase":"https://t.example.com","accessToken":"t"}}"#)
    rig.mic?.speak()
    #expect(await out.waitFor { out.events("transcript.segment").count == 1 })
    let stop = Task { await s.handle(#"{"id":2,"cmd":"record.stop"}"#) }
    #expect(await out.waitFor { finish.arrived == 1 })  // the app's stop is at /finish
    let done = Output()
    let shutdown = Task {
      await s.shutdown()
      done.write("done")
    }
    // Nothing ends shutdown but /finish answering; give it every chance to return early.
    for _ in 0..<20 { await Task.yield() }
    #expect(done.lines.isEmpty)
    finish.release()
    await shutdown.value
    await stop.value
    #expect(out.response(2)?["result"] == ["segments": 1, "finished": true])
    #expect(worker.completed.last == "/api/v1/meetings/m1/finish")
    #expect(worker.paths().filter { $0.hasSuffix("/finish") }.count == 1)
  }
}
