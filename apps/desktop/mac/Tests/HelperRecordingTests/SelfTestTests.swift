import Foundation
import Testing
import HelperCore
@testable import HelperRecording

/// The hardware self-test with fake sources: each 100 ms "tick" feeds what the test says.
@Suite @MainActor struct SelfTestTests {
  nonisolated static func tone(_ ms: Int, amplitude: Float) -> Data { PCM16.encode((0..<(ms * 24)).map { sin(Float($0) / 10) * amplitude }) }
  nonisolated static func zeros(_ ms: Int) -> Data { Data(count: ms * 48) }

  /// What each source delivers on tick n (100 ms each); nil = nothing.
  final class Script: @unchecked Sendable {
    let rig: FakeRig
    var tick = 0
    var mic: (Int) -> Data? = { _ in SelfTestTests.tone(100, amplitude: 0.1) }
    var system: (Int) -> Data? = { _ in SelfTestTests.tone(100, amplitude: 0.2) }
    init(_ rig: FakeRig) { self.rig = rig }
    func step() {
      if let d = mic(tick) { rig.mic?.onAudio(d) }
      if let d = system(tick) { rig.system?.onAudio(d) }
      tick += 1
    }
  }

  func run(_ script: Script, seconds: Int = 3, micAllowed: Bool = true, echo: Bool = false) async -> (SelfTest.Report, [SelfTest.Second], Int) {
    let (report, lines, levels, _) = await runWithProgress(script, seconds: seconds, micAllowed: micAllowed, echo: echo)
    return (report, lines, levels)
  }

  func runWithProgress(_ script: Script, seconds: Int = 3, micAllowed: Bool = true, echo: Bool = false) async
    -> (SelfTest.Report, [SelfTest.Second], Int, [SelfTest.Report])
  {
    let test = SelfTest(
      dependencies: script.rig.dependencies, echoCancellation: echo, requestMic: { micAllowed },
      tick: { await MainActor.run { script.step() } })
    var seconds_: [SelfTest.Second] = []
    var levels = 0
    var progress: [SelfTest.Report] = []
    let report = await test.run(
      seconds: seconds, onLevels: { _, _ in levels += 1 }, onSecond: { seconds_.append($0) }, onProgress: { progress.append($0) })
    return (report, seconds_, levels, progress)
  }

  @Test func bothSidesWorking() async {
    let rig = FakeRig()
    let (report, lines, levels) = await run(Script(rig))
    #expect(report.passed)
    #expect(report.mic.status == .ok && report.system.status == .ok)
    #expect(report.seconds == 3)
    #expect(lines.map(\.second) == [1, 2, 3])
    #expect(levels == 30)  // 10 Hz
    #expect(report.mic.dropouts == 0 && !report.mic.clipping)
    #expect(rig.mic?.stopped == true && rig.system?.stopped == true)
    #expect(rig.micVoiceProcessing == false)
  }

  @Test func systemDigitalSilenceIsDeniedQuietIsSilent() async {
    let rig = FakeRig()
    let script = Script(rig)
    script.system = { _ in SelfTestTests.zeros(100) }
    let (denied, _, _) = await run(script)
    #expect(denied.system.status == .denied)
    #expect(denied.system.message?.contains("System Audio Recording") == true)
    #expect(!denied.passed)

    let rig2 = FakeRig()
    let quiet = Script(rig2)
    quiet.system = { _ in SelfTestTests.tone(100, amplitude: 0.0005) }  // ~ −70 dBFS
    let (silent, _, _) = await run(quiet)
    #expect(silent.system.status == .silent)
  }

  @Test func micPermissionRefused() async {
    let rig = FakeRig()
    let (report, _, _) = await run(Script(rig), micAllowed: false)
    #expect(report.mic.status == .denied)
    #expect(rig.mic == nil)  // never started
    #expect(report.system.status == .ok)  // still checked
  }

  @Test func systemTapThatWontStart() async {
    let rig = FakeRig()
    rig.systemFails = true
    let (report, _, _) = await run(Script(rig))
    #expect(report.system.status == .error)
    #expect(report.system.message?.isEmpty == false)
  }

  @Test func clippingAndDropouts() async {
    let rig = FakeRig()
    let script = Script(rig)
    script.mic = { _ in SelfTestTests.tone(100, amplitude: 1.2) }  // overdriven: clips
    // System delivers for the first 1.5 s only, then stalls.
    script.system = { tick in tick < 15 ? SelfTestTests.tone(100, amplitude: 0.2) : nil }
    let (report, _, _) = await run(script, seconds: 4)
    #expect(report.mic.clipping)
    #expect(report.mic.clippedSamples > 0)
    #expect(report.system.dropouts == 3)  // seconds 2 (half), 3 and 4
    #expect(!report.passed)
  }

  @Test func progressAtTheStartAndEachSecond() async {
    let rig = FakeRig()
    let script = Script(rig)
    script.system = { tick in tick < 20 ? SelfTestTests.zeros(100) : SelfTestTests.tone(100, amplitude: 0.2) }
    let (report, _, _, progress) = await runWithProgress(script, seconds: 3)
    #expect(progress.map(\.seconds) == [0, 1, 2, 3])
    // Nothing heard yet at the start; the system side comes in during second 3.
    #expect(progress[0].mic.status == .silent && progress[0].system.status == .denied)
    #expect(progress[2].system.status == .denied && progress[3].system.status == .ok)
    #expect(progress.last == report)
  }

  /// Only the CLI's `--echo-cancellation` asks for it.
  @Test func echoCancellationReachesTheMic() async {
    let rig = FakeRig()
    _ = await run(Script(rig), seconds: 1, echo: true)
    #expect(rig.micVoiceProcessing == true)
  }

  @Test func reportShapes() async {
    let rig = FakeRig()
    let (report, _, _) = await run(Script(rig), seconds: 1)
    #expect(report.json["passed"] == true)
    #expect(report.json["mic"]?["status"] == "ok")
    #expect(report.json["system"]?["dropouts"] == 0)
    #expect(report.json["voiceProcessing"] == nil)
    #expect(report.text.hasSuffix("PASS"))
  }
}

@Suite @MainActor struct SelfTestProtocolTests {
  func server(_ rig: FakeRig, _ out: Output, gate: Gate? = nil) -> HelperServer {
    var env = environment(worker: .happy(), rig: rig)
    env.selfTestTick = {
      if let gate { await gate.wait() }
      await MainActor.run {
        rig.mic?.onAudio(SelfTestTests.tone(100, amplitude: 0.1))
        rig.system?.onAudio(SelfTestTests.tone(100, amplitude: 0.2))
      }
    }
    return HelperServer(environment: env, write: { out.write($0) })
  }

  @Test func runStreamsLevelsAndProgressAndAnswersTheSummary() async {
    let rig = FakeRig()
    let out = Output()
    let s = server(rig, out)
    await s.handle(#"{"id":1,"cmd":"selftest.run","params":{"seconds":2}}"#)
    let result = out.response(1)?["result"]
    #expect(result?["passed"] == true)
    #expect(result?["seconds"] == 2)
    #expect(result?["mic"]?["status"] == "ok")
    #expect(out.events("levels").count == 20)
    let progress = out.events("selftest.progress")
    #expect(progress.map { $0["seconds"]?.int } == [0, 1, 2])
    #expect(progress.last?["mic"]?["status"] == "ok" && progress.last?["system"]?["status"] == "ok")
    // Nothing went to the network.
    #expect(s.isRecording == false)
  }

  @Test func paramsAreChecked() async {
    let out = Output()
    let s = server(FakeRig(), out)
    await s.handle(#"{"id":1,"cmd":"selftest.run","params":{"seconds":0}}"#)
    await s.handle(#"{"id":2,"cmd":"selftest.run","params":{"seconds":61}}"#)
    await s.handle(#"{"id":3,"cmd":"selftest.run","params":{"seconds":"8"}}"#)
    for id in 1...3 { #expect(out.response(id)?["error"]?["code"] == "bad_params") }
  }

  @Test func stopEndsItWithTheReportSoFar() async {
    let rig = FakeRig()
    let out = Output()
    let gate = Gate()
    let s = server(rig, out, gate: gate)
    // No seconds: runs until stopped (60 s at most).
    let test = Task { await s.handle(#"{"id":1,"cmd":"selftest.run"}"#) }
    #expect(await out.waitFor { gate.arrived == 1 })
    #expect(out.events("selftest.progress").count == 1)  // the devices, at once
    let stop = Task { await s.handle(#"{"id":2,"cmd":"selftest.stop"}"#) }
    try? await Task.sleep(for: .milliseconds(50))  // the stop cancels before the next tick
    gate.release()
    await stop.value
    await test.value
    #expect(out.response(2)?["result"]?["stopped"] == true)
    #expect((out.response(1)?["result"]?["seconds"]?.int ?? 99) < 60)
    #expect(rig.mic?.stopped == true && rig.system?.stopped == true)
    // Nothing running: says so.
    await s.handle(#"{"id":3,"cmd":"selftest.stop"}"#)
    #expect(out.response(3)?["result"]?["stopped"] == false)
  }

  @Test func notWhileRecordingAndNoRecordingDuringIt() async {
    let rig = FakeRig()
    let out = Output()
    let gate = Gate()
    let s = server(rig, out, gate: gate)
    await s.handle(OfflineStopTests.start)
    await s.handle(#"{"id":2,"cmd":"selftest.run","params":{"seconds":1}}"#)
    #expect(out.response(2)?["error"]?["code"] == "busy")
    await s.handle(#"{"id":3,"cmd":"record.stop"}"#)

    let test = Task { await s.handle(#"{"id":4,"cmd":"selftest.run","params":{"seconds":1}}"#) }
    #expect(await out.waitFor { gate.arrived == 1 })
    await s.handle(OfflineStopTests.start.replacingOccurrences(of: "\"id\":1", with: "\"id\":5"))
    #expect(out.response(5)?["error"]?["code"] == "busy")
    gate.release()
    await test.value
    #expect(out.response(4)?["result"]?["seconds"] == 1)
  }

  @Test func shutdownStopsASelfTest() async {
    let rig = FakeRig()
    let out = Output()
    let gate = Gate()
    let s = server(rig, out, gate: gate)
    let test = Task { await s.handle(#"{"id":1,"cmd":"selftest.run","params":{"seconds":60}}"#) }
    #expect(await out.waitFor { gate.arrived == 1 })
    await s.shutdown()
    gate.release()
    await test.value
    #expect((out.response(1)?["result"]?["seconds"]?.int ?? 99) < 60)
    #expect(rig.mic?.stopped == true && rig.system?.stopped == true)
  }
}
