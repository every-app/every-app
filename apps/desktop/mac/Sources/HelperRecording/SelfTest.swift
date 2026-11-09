import Foundation
import HelperCore

/// A hardware check with no account and no network: captures the mic and system audio (no
/// Realtime, no Worker, nothing written anywhere) until it's stopped or `seconds` pass, and says
/// whether each one works. `everyapp-helper --selftest` prints it; `selftest.run` streams it to the
/// app (`selftest.progress` each second) and answers the final report.
@MainActor
public final class SelfTest {
  public enum Status: String, Sendable, Equatable {
    /// Signal well above the noise floor.
    case ok
    /// Some signal, but too quiet to be speech or playback.
    case silent
    /// Mic: permission refused. System audio: only digital silence, which is what a tap
    /// without permission delivers (also what you get when nothing at all is playing).
    case denied
    /// The capture couldn't start.
    case error
  }

  public struct SourceReport: Sendable, Equatable {
    public var status: Status
    /// The loudest 100 ms, 0–1 (−60…0 dBFS).
    public var peak: Double
    public var sampleRate: Double?
    public var device: String?
    /// Samples at (or within 0.2 % of) full scale.
    public var clippedSamples: Int
    public var totalSamples: Int
    /// Seconds (after the first) that delivered under 70 % of a second of audio.
    public var dropouts: Int
    public var message: String?

    public var clipping: Bool { totalSamples > 0 && Double(clippedSamples) / Double(totalSamples) > 0.001 }
  }

  public struct Report: Sendable, Equatable {
    public var seconds: Int
    /// Only the CLI's `--echo-cancellation` asks for it (not in the protocol).
    public var voiceProcessing: Bool
    public var mic: SourceReport
    public var system: SourceReport
    public var passed: Bool { mic.status == .ok && system.status == .ok && mic.dropouts == 0 && system.dropouts == 0 }
  }

  /// One second's line.
  public struct Second: Sendable, Equatable {
    public var second: Int
    public var mic: Double
    public var system: Double
  }

  public static let okLevel = 0.25  // −45 dBFS

  private let deps: RecordingPipeline.Dependencies
  private let requestMic: @Sendable () async -> Bool
  private let echoCancellation: Bool
  private let tick: @Sendable () async -> Void

  /// `tick` waits 100 ms between measurements (tests feed audio there instead).
  /// `echoCancellation` (AVAudioEngine voice processing on the mic) is reachable only from
  /// `everyapp-helper --selftest --echo-cancellation`, kept for a future hardware test.
  public init(
    dependencies: RecordingPipeline.Dependencies, echoCancellation: Bool = false,
    requestMic: @escaping @Sendable () async -> Bool,
    tick: @escaping @Sendable () async -> Void = { try? await Task.sleep(for: .milliseconds(100)) }
  ) {
    self.deps = dependencies
    self.echoCancellation = echoCancellation
    self.requestMic = requestMic
    self.tick = tick
  }

  /// Runs for `seconds` (stops early if the task is cancelled). `onLevels` gets each 100 ms
  /// peak, `onSecond` one line per second, `onProgress` the report so far: once both captures
  /// have started (`seconds` 0, so the devices show at once), then after each second.
  public func run(
    seconds: Int, onLevels: (Double, Double) -> Void = { _, _ in }, onSecond: (Second) -> Void = { _ in },
    onProgress: (Report) -> Void = { _ in }
  ) async -> Report {
    let micMeter = SelfTestMeter(), systemMeter = SelfTestMeter()
    var micProblem: (Status, String)?
    var micSource: (any AudioSource)?
    if await requestMic() {
      let source = deps.makeMic(echoCancellation, { micMeter.feed($0) }, { problem in if let problem { micMeter.note(problem) } })
      do {
        try source.start()
        micSource = source
      } catch {
        micProblem = (.error, error.localizedDescription)
      }
    } else {
      micProblem = (.denied, "Microphone access is off: System Settings → Privacy & Security → Microphone")
    }
    // Starting the tap is what makes macOS ask for system audio the first time.
    let systemSource = deps.makeSystem({ systemMeter.feed($0) }, { problem in if let problem { systemMeter.note(problem) } })
    var systemProblem: (Status, String)?
    do {
      try systemSource.start()
    } catch {
      systemProblem = (.error, error.localizedDescription)
    }
    defer {
      micSource?.stop()
      systemSource.stop()
    }

    let micInfo = micSource as? CaptureInfo, systemInfo = systemSource as? CaptureInfo
    var micPeak = 0.0, systemPeak = 0.0
    var micDropouts = 0, systemDropouts = 0
    var secondMic = 0.0, secondSystem = 0.0
    var completed = 0
    func report(_ meter: SelfTestMeter, peak: Double, info: CaptureInfo?, problem: (Status, String)?, dropouts: Int, isSystem: Bool)
      -> SourceReport
    {
      let totals = meter.totals
      var status: Status
      var message = problem?.1 ?? totals.note
      if let problem {
        status = problem.0
      } else if peak >= Self.okLevel {
        status = .ok
      } else if isSystem && !totals.anyNonZero {
        status = .denied
        message = message ?? "Only digital silence: play something, or allow System Settings → Privacy & Security → System Audio Recording"
      } else {
        status = .silent
      }
      return SourceReport(
        status: status, peak: peak, sampleRate: info?.sampleRate, device: info?.deviceName,
        clippedSamples: totals.clipped, totalSamples: totals.samples, dropouts: dropouts, message: message)
    }
    func snapshot() -> Report {
      Report(
        seconds: completed, voiceProcessing: micInfo?.voiceProcessingActive ?? false,
        mic: report(micMeter, peak: micPeak, info: micInfo, problem: micProblem, dropouts: micDropouts, isSystem: false),
        system: report(systemMeter, peak: systemPeak, info: systemInfo, problem: systemProblem, dropouts: systemDropouts, isSystem: true))
    }
    onProgress(snapshot())
    for step in 0..<(max(1, seconds) * 10) {
      await tick()
      if Task.isCancelled { break }
      let m = micMeter.takeLevel(), s = systemMeter.takeLevel()
      micPeak = max(micPeak, m)
      systemPeak = max(systemPeak, s)
      secondMic = max(secondMic, m)
      secondSystem = max(secondSystem, s)
      onLevels(m, s)
      if step % 10 == 9 {
        let second = step / 10 + 1
        let micMs = micMeter.takeDeliveredMs(), systemMs = systemMeter.takeDeliveredMs()
        // The first second warms up (devices start, the tap may wait for a prompt).
        if second > 1 {
          if micSource != nil, micMs < 700 { micDropouts += 1 }
          if systemProblem == nil, systemMs < 700 { systemDropouts += 1 }
        }
        onSecond(Second(second: second, mic: secondMic, system: secondSystem))
        secondMic = 0
        secondSystem = 0
        completed = second
        onProgress(snapshot())
      }
    }

    return snapshot()
  }
}

/// Levels, clipping and delivered audio for one source, fed from its audio thread.
public final class SelfTestMeter: @unchecked Sendable {
  public struct Totals: Sendable {
    public var samples = 0
    public var clipped = 0
    public var anyNonZero = false
    public var note: String?
  }

  private let lock = NSLock()
  private var peakRMS = 0.0
  private var deliveredSamples = 0
  private var totalsValue = Totals()

  public init() {}

  /// PCM16 24 kHz mono.
  public func feed(_ pcm: Data) {
    let samples = PCM16.decode(pcm)
    guard !samples.isEmpty else { return }
    var sum = 0.0
    var clipped = 0
    var nonZero = false
    for s in samples {
      let v = Double(s) / 32_768
      sum += v * v
      if s >= 32_700 || s <= -32_700 { clipped += 1 }
      if s != 0 { nonZero = true }
    }
    let rms = (sum / Double(samples.count)).squareRoot()
    lock.withLock {
      peakRMS = max(peakRMS, rms)
      deliveredSamples += samples.count
      totalsValue.samples += samples.count
      totalsValue.clipped += clipped
      totalsValue.anyNonZero = totalsValue.anyNonZero || nonZero
    }
  }

  /// A capture problem (the device went away), kept for the summary.
  public func note(_ problem: String) { lock.withLock { totalsValue.note = problem } }

  /// The loudest level since the last call, 0–1.
  public func takeLevel() -> Double {
    LevelMeter.scale(lock.withLock {
      defer { peakRMS = 0 }
      return peakRMS
    })
  }

  /// Audio delivered since the last call, in ms.
  public func takeDeliveredMs() -> Int {
    lock.withLock {
      defer { deliveredSamples = 0 }
      return deliveredSamples / 24
    }
  }

  public var totals: Totals { lock.withLock { totalsValue } }
}

extension SelfTest.Report {
  /// The protocol's `selftest.run` result.
  public var json: JSONValue {
    func source(_ s: SelfTest.SourceReport) -> JSONValue {
      var o: [String: JSONValue] = [
        "status": .string(s.status.rawValue), "peak": .double((s.peak * 1000).rounded() / 1000),
        "clipping": .bool(s.clipping), "clippedSamples": .int(s.clippedSamples), "dropouts": .int(s.dropouts),
      ]
      if let rate = s.sampleRate { o["sampleRate"] = .int(Int(rate)) }
      if let device = s.device { o["device"] = .string(device) }
      if let message = s.message { o["message"] = .string(message) }
      return .object(o)
    }
    return [
      "seconds": .int(seconds), "passed": .bool(passed),
      "mic": source(mic), "system": source(system),
    ]
  }

  /// What `everyapp-helper --selftest` prints at the end.
  public var text: String {
    func line(_ name: String, _ s: SelfTest.SourceReport) -> String {
      var parts = ["\(name): \(s.status.rawValue.uppercased())", String(format: "peak %.2f", s.peak)]
      if s.clipping { parts.append("CLIPPING (\(s.clippedSamples) samples)") }
      if s.dropouts > 0 { parts.append("\(s.dropouts) dropout second(s)") }
      if let m = s.message { parts.append(m) }
      return parts.joined(separator: " · ")
    }
    return [line("mic", mic), line("system audio", system), passed ? "PASS" : "CHECK THE LINES ABOVE"].joined(separator: "\n")
  }
}
