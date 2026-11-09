import Foundation
import Testing
import HelperCore
@testable import HelperRecording

@Suite @MainActor struct PipelineEchoTests {
  let said = "we should move the launch to next Tuesday"

  func pipeline(rig: FakeRig, worker: FakeWorker, clock: ManualClock, events: Output) -> RecordingPipeline {
    var deps = rig.dependencies
    deps.echoHoldMs = 4000
    deps.now = { clock.now }
    deps.levelInterval = .milliseconds(5)  // releases due segments; the clock decides when
    return RecordingPipeline(
      meetingID: "m1",
      api: APIClient(auth: AccessTokenAuthProvider(appURL: URL(string: "https://t.example.com")!, token: "t"), transport: worker),
      language: "en", dependencies: deps
    ) { event in if case .segment(let s) = event { events.write("\(s.seq) \(s.speaker.rawValue): \(s.text)") } }
  }

  func posted(_ worker: FakeWorker) throws -> [Segment] {
    try worker.requests.filter { $0.url!.path.hasSuffix("/segments") }.flatMap { try JSONDecoder().decode([Segment].self, from: $0.httpBody!) }
  }

  @Test func theMicsEchoIsNeitherEmittedNorPosted() async throws {
    let rig = FakeRig()
    rig.script = [.me: [said, "I can take that"], .them: [said]]
    let worker = FakeWorker.happy()
    let clock = ManualClock()
    let events = Output()
    let p = pipeline(rig: rig, worker: worker, clock: clock, events: events)
    try await p.start()
    rig.mic?.speak()  // the echo, transcribed first
    rig.system?.speak()
    #expect(await events.waitFor { events.lines == ["2 them: \(said)"] && p.heldForEcho == 1 })
    clock.advance(by: .seconds(5))
    #expect(await events.waitFor { p.heldForEcho == 0 })  // judged: an echo
    rig.mic?.speak()  // real words
    #expect(await events.waitFor { p.heldForEcho == 1 })
    #expect(events.lines.count == 1)
    clock.advance(by: .seconds(5))
    #expect(await events.waitFor { events.lines.count == 2 })
    #expect(events.lines == ["2 them: \(said)", "400 me: I can take that"])
    let result = await p.stop()
    #expect(result.segments == 2)
    #expect(try posted(worker).map(\.text) == [said, "I can take that"])
    #expect(p.echoCounts.dropped == 1)
  }

  @Test func theFinalFlushJudgesWhatsStillHeld() async throws {
    let rig = FakeRig()
    rig.script = [.me: [said, "sounds good to me"], .them: [said]]
    let worker = FakeWorker.happy()
    let events = Output()
    let p = pipeline(rig: rig, worker: worker, clock: ManualClock(), events: events)
    try await p.start()
    rig.mic?.speak()
    rig.mic?.speak()
    rig.system?.speak()
    #expect(await events.waitFor { events.lines.count == 1 && p.heldForEcho == 2 })
    // The clock never moves: both `me` segments are still held when stop comes.
    let result = await p.stop()
    #expect(result.segments == 2)
    #expect(try posted(worker).map(\.text) == [said, "sounds good to me"])
    #expect(events.lines.last == "400 me: sounds good to me")  // started at 100 ms
  }

  @Test func dedupeCanBeTurnedOff() async throws {
    let rig = FakeRig()
    rig.script = [.me: [said], .them: [said]]
    let worker = FakeWorker.happy()
    let events = Output()
    var deps = rig.dependencies
    deps.echoHoldMs = 0
    let p = RecordingPipeline(
      meetingID: "m1",
      api: APIClient(auth: AccessTokenAuthProvider(appURL: URL(string: "https://t.example.com")!, token: "t"), transport: worker),
      language: "en", options: RecordingOptions(dedupeEcho: false), dependencies: deps
    ) { event in if case .segment = event { events.write("s") } }
    try await p.start()
    rig.system?.speak()
    rig.mic?.speak()
    #expect(await events.waitFor { events.lines.count == 2 })
    #expect(await p.stop().segments == 2)
  }
}

/// Recordings never turn on voice processing; `record.start` ignores an old app's
/// `echoCancellation` (only `everyapp-helper --selftest --echo-cancellation` reaches it).
@Suite @MainActor struct NoVoiceProcessingInRecordingsTests {
  static func start(_ extra: String) -> String {
    #"{"id":1,"cmd":"record.start","params":{"meetingId":"m1","apiBase":"https://talk.example.com","accessToken":"t"\#(extra)}}"#
  }

  func run(_ line: String) async -> (FakeRig, Output) {
    let rig = FakeRig()
    let out = Output()
    let s = HelperServer(environment: environment(worker: .happy(), rig: rig), write: { out.write($0) })
    await s.handle(line)
    if s.isRecording { await s.handle(#"{"id":2,"cmd":"record.stop"}"#) }
    return (rig, out)
  }

  @Test func offAndTheOldParamIsIgnored() async {
    for extra in ["", #","echoCancellation":true"#, #","echoCancellation":"yes""#] {
      let (rig, out) = await run(Self.start(extra))
      #expect(out.response(1)?["ok"] == true)
      #expect(rig.micVoiceProcessing == false)
    }
  }
}

@Suite struct MicDownmixTests {
  @Test func voiceProcessingTakesOnlyTheFirstInterleavedChannel() {
    // 3 channels per frame: voice, then two others.
    let samples: [Float] = [0.5, 9, 9, -0.5, 9, 9]
    let one = samples.withUnsafeBufferPointer { MicCapture.mono(interleaved: $0, channels: 3, using: 1) }
    #expect(one == [0.5, -0.5])
    let all = samples.withUnsafeBufferPointer { MicCapture.mono(interleaved: $0, channels: 2, using: 2) }
    #expect(all == [4.75, 4.25, 9])
  }

  @Test func planarAverages() {
    let a: [Float] = [1, 0], b: [Float] = [0, 1]
    let out = a.withUnsafeBufferPointer { pa in b.withUnsafeBufferPointer { pb in MicCapture.mono(planar: [pa, pb]) } }
    #expect(out == [0.5, 0.5])
    let single = a.withUnsafeBufferPointer { MicCapture.mono(planar: [$0]) }
    #expect(single == [1, 0])
  }
}
