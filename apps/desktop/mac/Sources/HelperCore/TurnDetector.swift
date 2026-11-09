import Foundation

/// Client-side turn detection for a transcription session that has none on the server
/// (`turn_detection: null`). Scrawl's rule: commit a stretch with speech after 600 ms of quiet,
/// or at 30 s in the middle of speech. A long stretch of pure silence is skipped, not sent to
/// the model as a turn. Times are ms from the first sample this detector saw.
public struct TurnDetector: Sendable {
  public static let commitSilenceMs = 600
  public static let maxStretchMs = 30_000
  public static let minSpeechMs = 300
  public static let windowMs = 50
  public static let speechRMS = 0.008

  public enum Action: Equatable, Sendable {
    /// Commit the buffer: the turn covers t0…t1 ms.
    case commit(t0: Int, t1: Int)
    /// Thirty seconds of quiet: clear the server's buffer and start the next stretch here.
    case skipSilence
  }

  public let rate: Int
  public private(set) var total = 0
  var stretchStart = 0
  var stretchSpeech = false
  var trailingSilenceMs = 0
  /// Samples of the current analysis window not yet measured.
  var windowEnergy = 0.0
  var windowCount = 0

  public init(rate: Int = 24_000) { self.rate = rate }

  public var elapsedMs: Int { total * 1000 / rate }

  /// Whether the stretch not yet committed holds speech.
  public var inSpeech: Bool { stretchSpeech }

  /// Feeds samples; returns what to do after they're appended to the server's buffer.
  public mutating func feed(_ samples: [Int16]) -> [Action] {
    var actions: [Action] = []
    let window = rate * Self.windowMs / 1000
    for s in samples {
      let x = Double(s) / 32_768
      windowEnergy += x * x
      windowCount += 1
      total += 1
      guard windowCount == window else { continue }
      let rms = (windowEnergy / Double(windowCount)).squareRoot()
      windowEnergy = 0
      windowCount = 0
      if rms > Self.speechRMS {
        stretchSpeech = true
        trailingSilenceMs = 0
      } else {
        trailingSilenceMs += Self.windowMs
      }
      let stretchMs = (total - stretchStart) * 1000 / rate
      if stretchSpeech && trailingSilenceMs >= Self.commitSilenceMs && stretchMs - trailingSilenceMs >= Self.minSpeechMs {
        actions.append(commit())
      } else if stretchMs >= Self.maxStretchMs && stretchSpeech {
        actions.append(commit())
      } else if stretchMs >= Self.maxStretchMs {
        stretchStart = total
        trailingSilenceMs = 0
        actions.append(.skipSilence)
      }
    }
    return actions
  }

  /// At the end: commit what's waiting if it holds speech. Nil when there's nothing worth sending.
  public mutating func flush() -> Action? {
    guard total > stretchStart, stretchSpeech else { return nil }
    return commit()
  }

  private mutating func commit() -> Action {
    let action = Action.commit(t0: stretchStart * 1000 / rate, t1: total * 1000 / rate)
    stretchStart = total
    stretchSpeech = false
    trailingSilenceMs = 0
    return action
  }
}
