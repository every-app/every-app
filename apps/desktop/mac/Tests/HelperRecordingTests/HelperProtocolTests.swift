import Foundation
import Testing
import HelperCore
@testable import HelperRecording

@Suite struct HelperCodecTests {
  @Test func decodesARequest() throws {
    let request = try HelperCodec.decode(#"{"id":1,"cmd":"hello","params":{"protocol":1}}"#).get()
    #expect(request.id == .int(1))
    #expect(request.cmd == "hello")
    #expect(request.params["protocol"]?.int == 1)
  }

  @Test func stringIDsAndMissingParams() throws {
    let request = try HelperCodec.decode(#"{"id":"a-1","cmd":"record.stop"}"#).get()
    #expect(request.id == .string("a-1"))
    #expect(request.params == .object([:]))
  }

  @Test func rejectsWhatIsntARequest() {
    #expect(HelperCodec.decode("hello") == .failure(.notJSON))
    #expect(HelperCodec.decode("[1,2]") == .failure(.notJSON))
    #expect(HelperCodec.decode(#"{"id":7}"#) == .failure(.badRequest(id: .int(7), message: "Missing cmd")))
    guard case .failure(.badRequest(let id, _)) = HelperCodec.decode(#"{"id":{"x":1},"cmd":"hello"}"#) else {
      Issue.record("an object id should be refused")
      return
    }
    #expect(id == .object(["x": 1]))
  }

  @Test func encodesResponsesAndEventsOnOneLine() {
    #expect(HelperCodec.success(id: 3, result: ["segments": 2]) == #"{"id":3,"ok":true,"result":{"segments":2}}"#)
    #expect(
      HelperCodec.failure(id: "x", HelperError("busy", "Already recording"))
        == #"{"error":{"code":"busy","message":"Already recording"},"id":"x","ok":false}"#)
    #expect(HelperCodec.event("token.needed") == #"{"event":"token.needed"}"#)
    let line = HelperCodec.event("transcript.delta", ["text": "a\nb / c"])
    #expect(!line.contains("\n"))
    #expect(line == #"{"event":"transcript.delta","text":"a\nb / c"}"#)
  }

  @Test func jsonValueRoundTrips() throws {
    let text = #"{"a":[1,2.5,true,null,"s"],"b":{"c":-3}}"#
    let value = try JSONDecoder().decode(JSONValue.self, from: Data(text.utf8))
    #expect(HelperCodec.encode(value) == text)
  }
}

@Suite @MainActor struct HelperServerTests {
  let rig = FakeRig()
  let out = Output()

  func server(_ worker: FakeWorker, processes: FakeProcesses = FakeProcesses(), mic: MicGate = MicGate()) -> HelperServer {
    let out = self.out
    return HelperServer(environment: environment(worker: worker, rig: rig, processes: processes, mic: mic), write: { out.write($0) })
  }

  static let start = #"{"id":10,"cmd":"record.start","params":{"meetingId":"m1","apiBase":"https://talk.example.com","accessToken":"old"}}"#

  @Test func helloAndPermissions() async {
    let s = server(.happy())
    await s.handle(#"{"id":1,"cmd":"hello","params":{"protocol":1}}"#)
    await s.handle(#"{"id":2,"cmd":"hello","params":{"protocol":2}}"#)
    await s.handle(#"{"id":3,"cmd":"permissions.status"}"#)
    await s.handle(#"{"id":4,"cmd":"permissions.request","params":{"kind":"camera"}}"#)
    await s.handle(#"{"id":5,"cmd":"permissions.request","params":{"kind":"mic"}}"#)
    #expect(out.response(1)?["result"] == ["protocol": 1, "version": "9.9.9", "macos": "15.0.0"])
    #expect(out.response(2)?["error"]?["code"] == "unsupported_protocol")
    #expect(out.response(3)?["result"] == ["mic": "granted", "systemAudio": "unknown"])
    #expect(out.response(4)?["error"]?["code"] == "bad_params")
    #expect(out.response(5)?["result"]?["mic"] == "granted")
  }

  @Test func unknownCommandsAndBadLinesGetOneAnswerEach() async {
    let s = server(.happy())
    await s.handle("garbage")
    await s.handle(#"{"id":1,"cmd":"fly"}"#)
    await s.handle("")
    #expect(out.lines.count == 2)
    #expect(out.objects[0]["id"] == .null)
    #expect(out.response(1)?["error"]?["code"] == "unknown_command")
  }

  @Test func startValidatesParams() async {
    let s = server(.happy())
    await s.handle(#"{"id":1,"cmd":"record.start","params":{"apiBase":"https://t.example.com","accessToken":"a"}}"#)
    await s.handle(#"{"id":2,"cmd":"record.start","params":{"meetingId":"m1","apiBase":"http://evil.example.com","accessToken":"a"}}"#)
    await s.handle(#"{"id":3,"cmd":"record.start","params":{"meetingId":"m1","apiBase":"https://t.example.com"}}"#)
    for id in 1...3 { #expect(out.response(id)?["error"]?["code"] == "bad_params") }
    #expect(!s.isRecording)
  }

  @Test func startNeedsTheMic() async {
    let gate = MicGate()
    gate.allowed = false
    let s = server(.happy(), mic: gate)
    await s.handle(Self.start)
    #expect(out.response(10)?["error"]?["code"] == "mic_denied")
    #expect(rig.mic == nil)
  }

  @Test func recordsPostsAndFinishes() async throws {
    let worker = FakeWorker.happy()
    let s = server(worker)
    await s.handle(Self.start)
    #expect(out.response(10)?["ok"] == true)
    #expect(out.response(10)?["result"]?["startedAt"]?.string != nil)
    #expect(s.isRecording)
    let state = try #require(out.events("state").last)
    #expect(state == ["event": "state", "recording": true, "meetingId": "m1", "mode": "realtime", "mic": "ok", "system": "ok", "transcription": "live"])
    // Both keys were minted with the token the app gave.
    #expect(worker.tokens(for: "/api/v1/meetings/m1/transcription-token") == ["old", "old"])

    await s.handle(#"{"id":11,"cmd":"record.start","params":{"meetingId":"m2","apiBase":"https://talk.example.com","accessToken":"x"}}"#)
    #expect(out.response(11)?["error"]?["code"] == "busy")

    rig.mic?.speak()
    rig.system?.speak()
    #expect(await out.waitFor { out.events("transcript.segment").count == 2 })
    let deltas = out.events("transcript.delta")
    #expect(deltas.contains { $0["speaker"] == "me" && $0["itemId"] == "item-me-1" && $0["text"] == "turn 1" })
    let segments = out.events("transcript.segment")
    #expect(Set(segments.compactMap { $0["seq"]?.int }) == [0, 2])  // TranscriptSeq: both at 0 ms, them + 2
    #expect(segments.contains { $0["speaker"] == "them" && $0["text"] == "them turn 1" && $0["startedMs"] == 0 && $0["endedMs"] == 100 })

    await s.handle(#"{"id":12,"cmd":"record.stop"}"#)
    #expect(out.response(12)?["result"] == ["segments": 2, "finished": true])
    #expect(rig.mic?.stopped == true && rig.system?.stopped == true)
    let paths = worker.paths()
    #expect(paths.filter { $0 == "/api/v1/meetings/m1/segments" }.count == 1)
    #expect(paths.last == "/api/v1/meetings/m1/finish")
    let posted = try JSONDecoder().decode([Segment].self, from: worker.requests.first { $0.url!.path.hasSuffix("/segments") }!.httpBody!)
    #expect(posted.map(\.seq) == [0, 2])
    #expect(out.events("state").last?["recording"] == false)
    #expect(!s.isRecording)
  }

  @Test func a401AsksTheAppForATokenAndRetries() async throws {
    let worker = FakeWorker.happy(segments: { $0 == "new" ? 204 : 401 })
    let s = server(worker)
    await s.handle(Self.start)
    rig.mic?.speak()
    #expect(await out.waitFor { out.events("transcript.segment").count == 1 })

    let stop = Task { await s.handle(#"{"id":2,"cmd":"record.stop"}"#) }
    #expect(await out.waitFor { out.events("token.needed").count == 1 })
    #expect(out.response(2) == nil)
    await s.handle(#"{"id":3,"cmd":"token.update","params":{"accessToken":"new"}}"#)
    await stop.value
    #expect(out.response(3)?["ok"] == true)
    #expect(out.response(2)?["result"] == ["segments": 1, "finished": true])
    #expect(worker.tokens(for: "/api/v1/meetings/m1/segments") == ["old", "new"])
    #expect(worker.tokens(for: "/api/v1/meetings/m1/finish") == ["new"])
    #expect(out.events("error").isEmpty)
  }

  @Test func noLiveKeysMeansFallback() async {
    let worker = FakeWorker { path, _ in
      switch path {
      case "/api/v1/meetings/m1/transcription-token": (503, #"{"error":"ai_route_not_allowed"}"#)
      case "/api/v1/meetings/m1/finish": (202, "{}")
      default: (404, "")
      }
    }
    let s = server(worker)
    await s.handle(Self.start)
    #expect(out.response(10)?["ok"] == true)
    #expect(rig.fallbackUsed)
    #expect(out.events("state").last?["mode"] == "fallback")
    await s.handle(#"{"id":2,"cmd":"record.stop"}"#)
    #expect(out.response(2)?["ok"] == true)
  }

  @Test func startFailsCleanlyWhenTheWorkerRefuses() async {
    let worker = FakeWorker { _, _ in (503, #"{"error":"ai_provider_not_configured","message":"Set up OpenAI"}"#) }
    let s = server(worker)
    await s.handle(Self.start)
    #expect(out.response(10)?["error"] == ["code": "ai_provider_not_configured", "message": "Set up OpenAI"])
    #expect(!s.isRecording)
    #expect(rig.mic == nil)
  }

  @Test func systemAudioFailingStillRecordsYourSide() async {
    rig.systemFails = true
    let s = server(.happy())
    await s.handle(Self.start)
    #expect(out.response(10)?["ok"] == true)
    #expect(await out.waitFor { out.events("state").last?["system"] == "error" })
    #expect(out.events("error").contains { $0["code"] == "capture" && $0["fatal"] == false })
    await s.handle(#"{"id":2,"cmd":"record.stop"}"#)
  }

  @Test func shutdownStopsARecordingProperly() async {
    let worker = FakeWorker.happy()
    let s = server(worker)
    await s.handle(Self.start)
    rig.mic?.speak()
    #expect(await out.waitFor { out.events("transcript.segment").count == 1 })
    await s.shutdown()
    #expect(!s.isRecording)
    #expect(worker.paths().last == "/api/v1/meetings/m1/finish")
    await s.handle(Self.start.replacingOccurrences(of: "\"id\":10", with: "\"id\":20"))
    #expect(out.response(20)?["error"]?["code"] == "shutting_down")
  }

  @Test func detectionReportsCallApps() async {
    let processes = FakeProcesses()
    let s = server(.happy(), processes: processes)
    await s.handle(#"{"id":1,"cmd":"detect.set","params":{"enabled":true}}"#)
    #expect(s.isDetecting)
    processes.now = [InputProcess(pid: 500, bundleID: "us.zoom.xos"), InputProcess(pid: 501, bundleID: "com.example.recorder")]
    #expect(await out.waitFor { out.events("call.started").count == 1 })
    #expect(out.events("call.started")[0] == ["event": "call.started", "bundleId": "us.zoom.xos", "appName": "Zoom"])
    processes.now = []
    #expect(await out.waitFor { out.events("call.ended").count == 1 })
    await s.handle(#"{"id":2,"cmd":"detect.set","params":{"enabled":false}}"#)
    #expect(!s.isDetecting)
    await s.handle(#"{"id":3,"cmd":"detect.set","params":{}}"#)
    #expect(out.response(3)?["error"]?["code"] == "bad_params")
  }

  @Test func deviceChanges() {
    let s = server(.happy())
    s.deviceChanged(input: "AirPods", output: nil)
    #expect(out.events("device.changed") == [["event": "device.changed", "input": "AirPods"]])
  }
}

@Suite struct HelperAuthTests {
  @Test func waitsForTheAppAndTimesOut() async throws {
    let asked = Output()
    let auth = HelperAuth(appURL: URL(string: "https://t.example.com")!, token: "a", timeout: .milliseconds(30)) { asked.write("needed") }
    await #expect(throws: AuthError.signedOut) { try await auth.tokenRejected("a") }
    #expect(asked.lines == ["needed"])
    // A newer token already arrived: no need to ask.
    await auth.update("b")
    #expect(try await auth.tokenRejected("a") == "b")
    await auth.close()
    await #expect(throws: AuthError.signedOut) { try await auth.tokenRejected("b") }
    #expect(try await auth.accessToken() == "b")
  }

  @Test func oneAskForManyWaiters() async throws {
    let asked = Output()
    let auth = HelperAuth(appURL: URL(string: "https://t.example.com")!, token: "a") { asked.write("needed") }
    async let one = auth.tokenRejected("a")
    async let two = auth.tokenRejected("a")
    #expect(await asked.waitFor { !asked.lines.isEmpty })
    try await Task.sleep(for: .milliseconds(20))
    await auth.update("b")
    #expect(try await [one, two] == ["b", "b"])
    #expect(asked.lines == ["needed"])
  }
}

@Suite struct LevelMeterTests {
  @Test func scalesAndDetectsSilence() {
    #expect(LevelMeter.scale(0) == 0)
    #expect(LevelMeter.scale(1) == 1)
    #expect(abs(LevelMeter.scale(0.001) - 0) < 0.001)  // −60 dBFS
    let meter = LevelMeter()
    meter.measure(PCM16.encode([Float](repeating: 0.5, count: 240)))
    #expect(abs(meter.take() - 0.9) < 0.01)  // −6 dBFS
    #expect(meter.take() == 0)
    #expect(meter.silentFor < 1)
  }
}
