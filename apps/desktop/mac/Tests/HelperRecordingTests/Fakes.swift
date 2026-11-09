import Foundation
import HelperCore
import HelperRecording

/// Records requests and answers them from a handler (status, body).
final class FakeWorker: HTTPTransport, @unchecked Sendable {
  typealias Handler = @Sendable (_ path: String, _ token: String) -> (Int, String)
  private let lock = NSLock()
  private var handler: Handler
  private var _requests: [URLRequest] = []
  private var _completed: [String] = []
  /// Runs before a request is answered (after it's recorded), to hold it in flight.
  var hold: (@Sendable (_ path: String, _ index: Int) async -> Void)?
  /// Answers `/audio-chunk` from the multipart fields (seq, speaker, startedMs, endedMs), when set.
  var audioChunk: (@Sendable (_ fields: [String: String]) -> (Int, String))?

  static func multipartFields(_ body: Data?) -> [String: String] {
    let text = String(decoding: body ?? Data(), as: UTF8.self)
    var out: [String: String] = [:]
    let pattern = try! NSRegularExpression(pattern: #"name="([^"]+)"\r\n\r\n([^\r]*)\r\n"#)
    for m in pattern.matches(in: text, range: NSRange(text.startIndex..., in: text)) {
      out[String(text[Range(m.range(at: 1), in: text)!])] = String(text[Range(m.range(at: 2), in: text)!])
    }
    return out
  }

  init(_ handler: @escaping Handler) { self.handler = handler }

  /// Paths in the order their answers came back.
  var completed: [String] { lock.withLock { _completed } }

  var requests: [URLRequest] { lock.withLock { _requests } }
  func paths() -> [String] { requests.map { $0.url!.path } }
  func tokens(for path: String) -> [String] {
    requests.filter { $0.url!.path == path }.map { ($0.value(forHTTPHeaderField: "Authorization") ?? "").replacingOccurrences(of: "Bearer ", with: "") }
  }

  func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
    let token = (request.value(forHTTPHeaderField: "Authorization") ?? "").replacingOccurrences(of: "Bearer ", with: "")
    let path = request.url!.path
    let index = lock.withLock {
      _requests.append(request)
      return _requests.filter { $0.url!.path == path }.count - 1
    }
    await hold?(path, index)
    let chunkAnswer = path.hasSuffix("/audio-chunk") ? audioChunk?(Self.multipartFields(request.httpBody)) : nil
    let (status, body) = lock.withLock {
      _completed.append(path)
      return chunkAnswer ?? handler(path, token)
    }
    let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": "application/json"])!
    return (Data(body.utf8), response)
  }

  /// A Worker that mints keys, stores segments and finishes meeting m1.
  static func happy(segments: @escaping @Sendable (String) -> Int = { _ in 204 }) -> FakeWorker {
    FakeWorker { path, token in
      switch path {
      case "/api/v1/meetings/m1/transcription-token":
        (200, #"{"value":"ek_abc","expiresAt":4102444800,"model":"gpt-live-transcribe"}"#)
      case "/api/v1/meetings/m1/segments": (segments(token), "")
      case "/api/v1/meetings/m1/finish": (202, #"{"ok":true}"#)
      default: (404, "")
      }
    }
  }
}

/// A capture source the test drives by hand.
final class FakeSource: AudioSource, @unchecked Sendable {
  let onAudio: @Sendable (Data) -> Void
  let onInterrupted: @Sendable (String?) -> Void
  let failStart: Bool
  private(set) var started = false
  private(set) var stopped = false

  init(onAudio: @escaping @Sendable (Data) -> Void, onInterrupted: @escaping @Sendable (String?) -> Void, failStart: Bool = false) {
    self.onAudio = onAudio
    self.onInterrupted = onInterrupted
    self.failStart = failStart
  }

  func start() throws {
    if failStart { throw CaptureError("no device") }
    started = true
  }

  func stop() { stopped = true }

  /// 100 ms of a quiet tone.
  func speak() { onAudio(PCM16.encode((0..<2400).map { sin(Float($0) / 10) * 0.1 })) }
}

/// A channel that fetches its key like the real one, then turns every chunk fed into a delta and
/// a finished segment.
actor FakeChannel: SpeakerChannel {
  let speaker: Speaker
  let fetchToken: (@Sendable () async throws -> TranscriptionToken)?
  let callbacks: ChannelCallbacks
  /// The text of turn n (1-based); nil for the default "<speaker> turn n".
  let script: @Sendable (Speaker, Int) -> String?
  private var clock = 0
  private var turns = 0

  init(
    speaker: Speaker, fetchToken: (@Sendable () async throws -> TranscriptionToken)?, callbacks: ChannelCallbacks,
    script: @escaping @Sendable (Speaker, Int) -> String? = { _, _ in nil }
  ) {
    self.speaker = speaker
    self.fetchToken = fetchToken
    self.callbacks = callbacks
    self.script = script
  }

  func start() async throws { _ = try await fetchToken?() }

  func feed(_ pcm: Data) async {
    let ms = pcm.count / 48
    turns += 1
    callbacks.delta(speaker, "turn \(turns)", "item-\(speaker.rawValue)-\(turns)")
    callbacks.segment(speaker, clock, clock + ms, script(speaker, turns) ?? "\(speaker.rawValue) turn \(turns)")
    clock += ms
  }

  func finish() async {}
  func cancel() async {}

  /// What a real channel says when its connection drops (a sentence) or comes back (nil).
  func report(_ problem: String?) { callbacks.problem(speaker, problem) }

  /// What a real channel does when it's back: the audio kept during the outage, then all clear.
  func backlog(_ message: String) { callbacks.backlog(speaker, message) }

  func reconnect(outage pcm: Data, startedAt startMs: Int) {
    callbacks.catchUp(speaker, pcm, startMs)
    callbacks.problem(speaker, nil)
  }
}

/// Hands out fake sources and channels and remembers them.
final class FakeRig: @unchecked Sendable {
  private let lock = NSLock()
  private var _mic: FakeSource?
  private var _system: FakeSource?
  var systemFails = false
  var fallbackUsed = false
  /// Scripted turn texts per speaker (turn 1 first); past the end, the default text.
  var script: [Speaker: [String]] = [:]

  private var _micVoiceProcessing: Bool?
  private var _channels: [Speaker: FakeChannel] = [:]
  func channel(_ speaker: Speaker) -> FakeChannel? { lock.withLock { _channels[speaker] } }
  var mic: FakeSource? { lock.withLock { _mic } }

  var scripted: @Sendable (Speaker, Int) -> String? {
    { [self] speaker, turn in
      lock.withLock {
        guard let texts = script[speaker], turn - 1 < texts.count else { return nil }
        return texts[turn - 1]
      }
    }
  }
  var micVoiceProcessing: Bool? { lock.withLock { _micVoiceProcessing } }
  var system: FakeSource? { lock.withLock { _system } }

  var dependencies: RecordingPipeline.Dependencies {
    var deps = RecordingPipeline.Dependencies(
      makeMic: { [self] voiceProcessing, onAudio, onInterrupted in
        let source = FakeSource(onAudio: onAudio, onInterrupted: onInterrupted)
        lock.withLock {
          _mic = source
          _micVoiceProcessing = voiceProcessing
        }
        return source
      },
      makeSystem: { [self] onAudio, onInterrupted in
        let source = FakeSource(onAudio: onAudio, onInterrupted: onInterrupted, failStart: systemFails)
        lock.withLock { _system = source }
        return source
      },
      makeRealtime: { [self] speaker, _, fetchToken, callbacks in
        let channel = FakeChannel(speaker: speaker, fetchToken: fetchToken, callbacks: callbacks, script: scripted)
        lock.withLock { _channels[speaker] = channel }
        return channel
      },
      makeFallback: { [self] speaker, _, _, _, _, callbacks in
        lock.withLock { fallbackUsed = true }
        return FakeChannel(speaker: speaker, fetchToken: nil, callbacks: callbacks)
      })
    deps.flushInterval = 3600
    deps.settle = .milliseconds(20)
    deps.finalRetryDelay = .milliseconds(10)
    deps.levelInterval = .seconds(3600)
    // No echo hold unless a test sets one (with a manual clock).
    deps.echoHoldMs = 0
    return deps
  }
}

/// Lines the server wrote, decoded.
final class Output: @unchecked Sendable {
  private let lock = NSLock()
  private var _lines: [String] = []

  func write(_ line: String) { lock.withLock { _lines.append(line) } }

  var lines: [String] { lock.withLock { _lines } }
  var objects: [JSONValue] { lines.map { try! JSONDecoder().decode(JSONValue.self, from: Data($0.utf8)) } }
  func events(_ name: String) -> [JSONValue] { objects.filter { $0["event"]?.string == name } }
  func response(_ id: Int) -> JSONValue? { objects.first { $0["id"] == .int(id) } }

  /// Polls until `condition` holds (or 10 s pass: generous for slow CI runners; a passing
  /// test returns as soon as the condition holds).
  func waitFor(_ condition: () -> Bool) async -> Bool {
    for _ in 0..<2000 {
      if condition() { return true }
      try? await Task.sleep(for: .milliseconds(5))
    }
    return condition()
  }
}

final class FakeProcesses: InputProcessSource, @unchecked Sendable {
  private let lock = NSLock()
  private var _now: [InputProcess] = []
  var now: [InputProcess] {
    get { lock.withLock { _now } }
    set { lock.withLock { _now = newValue } }
  }
  func processesUsingInput() -> [InputProcess] { now }
}

final class MicGate: @unchecked Sendable {
  private let lock = NSLock()
  private var _allowed = true
  private var _asked = 0
  var allowed: Bool {
    get { lock.withLock { _allowed } }
    set { lock.withLock { _allowed = newValue } }
  }
  var asked: Int { lock.withLock { _asked } }
  func ask() -> Bool { lock.withLock { _asked += 1; return _allowed } }
}

func environment(worker: FakeWorker, rig: FakeRig, processes: FakeProcesses = FakeProcesses(), mic: MicGate = MicGate()) -> HelperEnvironment {
  var env = HelperEnvironment(
    version: "9.9.9", macos: "15.0.0",
    micStatus: { mic.allowed ? .granted : .denied },
    requestMic: { mic.ask() },
    primeSystemAudio: {},
    pipeline: rig.dependencies, transport: worker, processSource: processes)
  env.defaultLanguage = "en"
  env.detectInterval = .milliseconds(5)
  env.callDebounce = 0.05
  env.tokenTimeout = .seconds(5)
  return env
}

/// Holds callers until opened.
final class Gate: @unchecked Sendable {
  private let lock = NSLock()
  private var open = false
  private var waiters: [CheckedContinuation<Void, Never>] = []
  private var _arrived = 0

  var arrived: Int { lock.withLock { _arrived } }

  func wait() async {
    await withCheckedContinuation { (c: CheckedContinuation<Void, Never>) in
      let resumeNow: Bool = lock.withLock {
        _arrived += 1
        if open { return true }
        waiters.append(c)
        return false
      }
      if resumeNow { c.resume() }
    }
  }

  func release() {
    let pending: [CheckedContinuation<Void, Never>] = lock.withLock {
      open = true
      defer { waiters = [] }
      return waiters
    }
    for c in pending { c.resume() }
  }
}

/// A clock that only moves when told to.
final class ManualClock: @unchecked Sendable {
  private let lock = NSLock()
  private var current = ContinuousClock.now

  var now: ContinuousClock.Instant { lock.withLock { current } }
  func advance(by duration: Duration) { lock.withLock { current += duration } }
}
