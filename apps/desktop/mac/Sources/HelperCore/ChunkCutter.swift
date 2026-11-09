import Foundation

/// Cuts a speaker's PCM16 24 kHz stream into the fallback's WAV-sized chunks (docs/scribe.md
/// "Fallback"): about 30 s each, cut where a turn ends so no word is split, never longer than
/// 30 s, and stretches without speech are dropped instead of sent.
public struct ChunkCutter: Sendable {
  public static let maxMs = 30_000
  /// Once a chunk holds this much, it's sent at the next turn's end.
  public static let targetMs = 20_000
  static let bytesPerMs = 48  // 24 kHz × 2 bytes

  public struct Chunk: Equatable, Sendable {
    public var startedMs: Int
    public var endedMs: Int
    public var pcm: Data
  }

  var detector = TurnDetector()
  /// Audio from `chunkStart` on.
  var pending = Data()
  var chunkStart = 0
  /// End of the last committed turn inside the pending chunk; nil when it holds no speech yet.
  var lastTurnEnd: Int?

  public init() {}

  public var elapsedMs: Int { detector.elapsedMs }

  /// Feeds audio; returns the chunks it completes, oldest first.
  public mutating func feed(_ pcm: Data) -> [Chunk] {
    pending.append(pcm)
    var out: [Chunk] = []
    for action in detector.feed(PCM16.decode(pcm)) {
      switch action {
      case .commit(_, let t1):
        lastTurnEnd = t1
        if t1 - chunkStart >= Self.targetMs, let chunk = cut(at: t1) { out.append(chunk) }
      case .skipSilence:
        // Thirty quiet seconds: send the speech before them, drop the quiet.
        if let end = lastTurnEnd, let chunk = cut(at: end) { out.append(chunk) }
        drop(to: elapsedMs)
      }
    }
    // The hard cap: cut at the last turn's end if there is one, else mid-speech.
    while elapsedMs - chunkStart >= Self.maxMs {
      if let end = lastTurnEnd, end > chunkStart, let chunk = cut(at: end) {
        out.append(chunk)
      } else if detector.inSpeech, let chunk = cut(at: chunkStart + Self.maxMs) {
        out.append(chunk)
      } else {
        drop(to: chunkStart + Self.maxMs)
      }
    }
    return out
  }

  /// What's left at the end, if it holds speech.
  public mutating func finish() -> Chunk? {
    let end = elapsedMs
    let speech = lastTurnEnd != nil || detector.flush() != nil
    guard speech, end > chunkStart else { return nil }
    return cut(at: end)
  }

  private mutating func cut(at end: Int) -> Chunk? {
    guard end > chunkStart else { return nil }
    let bytes = min(pending.count, (end - chunkStart) * Self.bytesPerMs) & ~1
    let chunk = Chunk(startedMs: chunkStart, endedMs: end, pcm: Data(pending.prefix(bytes)))
    pending.removeFirst(bytes)
    chunkStart = end
    lastTurnEnd = nil
    return bytes > 0 ? chunk : nil
  }

  private mutating func drop(to end: Int) {
    guard end > chunkStart else { return }
    let bytes = min(pending.count, (end - chunkStart) * Self.bytesPerMs) & ~1
    pending.removeFirst(bytes)
    chunkStart = end
    lastTurnEnd = nil
  }
}
