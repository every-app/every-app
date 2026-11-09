import Foundation

/// Without headphones the mic also hears the other side, so the `me` stream transcribes `them`'s
/// words a second time. This drops (or trims) a `me` segment that overlaps a `them` segment in
/// time and says mostly the same words, before it's posted.
///
/// The words are compared in order (longest common subsequence of normalized tokens), since an
/// echo repeats the other side's words in the same order. Normalization folds case, diacritics
/// and punctuation; scripts written without spaces (CJK, Thai) compare character by character.
public enum EchoDedupe {
  public struct Config: Sendable, Equatable {
    /// How far apart in time the two segments may be and still count as overlapping.
    public var toleranceMs = 1500
    /// The share of the shorter side's words that must match for an echo.
    public var minOverlap = 0.7
    /// A `me` segment this short (in tokens) is only an echo if it also matches most of the
    /// `them` words: "yeah" from me during a long `them` turn that contains "yeah" is real.
    public var shortTokens = 3
    public var shortMinOverlapOfLonger = 0.5
    /// Echo plus real words: keep the words that aren't echo when at least this many remain
    /// (and they're at least `trimMinShare` of the segment).
    public var trimMinTokens = 3
    public var trimMinShare = 0.3

    public init() {}
  }

  public enum Decision: Equatable, Sendable {
    case keep
    case drop
    /// Keep only these words (the ones that weren't echo), in order.
    case trim(String)
  }

  /// What to do with `me`, given the `them` segments known so far.
  public static func decide(me: Segment, them: [Segment], config: Config = Config()) -> Decision {
    guard me.speaker == .me else { return .keep }
    let overlapping = them.filter {
      $0.speaker == .them && $0.startedMs <= me.endedMs + config.toleranceMs && $0.endedMs >= me.startedMs - config.toleranceMs
    }.sorted { ($0.startedMs, $0.seq) < ($1.startedMs, $1.seq) }
    guard !overlapping.isEmpty else { return .keep }

    let meWords = words(me.text)
    let meTokens = meWords.map(\.tokens)
    let flatMe = meTokens.flatMap { $0 }
    let flatThem = overlapping.flatMap { words($0.text).flatMap(\.tokens) }
    guard !flatMe.isEmpty, !flatThem.isEmpty else { return .keep }

    let matched = lcsMask(flatMe, flatThem)
    let common = matched.filter { $0 }.count
    let shorter = min(flatMe.count, flatThem.count)
    let longer = max(flatMe.count, flatThem.count)
    guard Double(common) / Double(shorter) >= config.minOverlap else { return .keep }
    if shorter < config.shortTokens, Double(common) / Double(longer) < config.shortMinOverlapOfLonger { return .keep }

    // Mostly echo. Keep the words that aren't, if there are enough of them to be real speech.
    var index = 0
    var kept: [String] = []
    var keptTokens = 0
    for word in meWords {
      let range = index..<(index + word.tokens.count)
      index += word.tokens.count
      // A word survives when none of its tokens was matched as echo.
      if !range.contains(where: { matched[$0] }) {
        kept.append(word.original)
        keptTokens += word.tokens.count
      }
    }
    if keptTokens >= config.trimMinTokens, Double(keptTokens) / Double(flatMe.count) >= config.trimMinShare {
      return .trim(kept.joined(separator: " "))
    }
    return .drop
  }

  // MARK: Tokens

  struct Word {
    var original: String
    var tokens: [String]
  }

  /// Whitespace-separated words, each with its normalized tokens (none for punctuation alone).
  static func words(_ text: String) -> [Word] {
    text.split(whereSeparator: \.isWhitespace).compactMap { raw in
      let tokens = tokens(String(raw))
      return tokens.isEmpty ? nil : Word(original: String(raw), tokens: tokens)
    }
  }

  /// Case-, diacritic- and punctuation-folded; spaceless scripts split into characters.
  public static func tokens(_ text: String) -> [String] {
    let folded = text.folding(options: [.caseInsensitive, .diacriticInsensitive, .widthInsensitive], locale: nil)
    var out: [String] = []
    var current = ""
    func end() {
      if !current.isEmpty { out.append(current) }
      current = ""
    }
    for character in folded {
      if character.unicodeScalars.contains(where: isSpaceless) {
        end()
        out.append(String(character))
      } else if character.isLetter || character.isNumber {
        current.append(character)
      } else if character == "'" || character == "’" {
        continue  // "don't" == "dont"
      } else {
        end()
      }
    }
    end()
    return out
  }

  static func isSpaceless(_ s: Unicode.Scalar) -> Bool {
    switch s.value {
    case 0x3040...0x30FF, 0x3400...0x4DBF, 0x4E00...0x9FFF, 0xF900...0xFAFF, 0xAC00...0xD7AF, 0x0E00...0x0E7F: true
    default: false
    }
  }

  /// Which of `a`'s tokens are in a longest common subsequence with `b`.
  static func lcsMask(_ a: [String], _ b: [String]) -> [Bool] {
    let n = a.count, m = b.count
    var table = [[Int]](repeating: [Int](repeating: 0, count: m + 1), count: n + 1)
    for i in stride(from: n - 1, through: 0, by: -1) {
      for j in stride(from: m - 1, through: 0, by: -1) {
        table[i][j] = a[i] == b[j] ? table[i + 1][j + 1] + 1 : max(table[i + 1][j], table[i][j + 1])
      }
    }
    var mask = [Bool](repeating: false, count: n)
    var i = 0, j = 0
    while i < n, j < m {
      if a[i] == b[j] {
        mask[i] = true
        i += 1
        j += 1
      } else if table[i + 1][j] >= table[i][j + 1] {
        i += 1
      } else {
        j += 1
      }
    }
    return mask
  }
}

/// The streaming side: `me` segments wait `holdMs` for the other side's transcription to arrive
/// (it can finish later than the echo), then are judged against every `them` segment seen.
/// `them` segments pass straight through. Times are milliseconds on any monotonic clock the
/// caller picks (the pipeline uses time since recording started).
public struct EchoFilter: Sendable {
  public struct Pending: Equatable, Sendable {
    public var speaker: Speaker
    public var startedMs: Int
    public var endedMs: Int
    public var text: String

    public init(speaker: Speaker, startedMs: Int, endedMs: Int, text: String) {
      self.speaker = speaker
      self.startedMs = startedMs
      self.endedMs = endedMs
      self.text = text
    }
  }

  public static let defaultHoldMs = 4000
  /// `them` segments this far behind the newest held `me` segment can't match anything again.
  static let keepThemMs = 120_000

  public var config: EchoDedupe.Config
  public let holdMs: Int
  public private(set) var dropped = 0
  public private(set) var trimmed = 0
  private var held: [(segment: Pending, arrivedMs: Int)] = []
  private var them: [Segment] = []

  public init(holdMs: Int = EchoFilter.defaultHoldMs, config: EchoDedupe.Config = .init()) {
    self.holdMs = holdMs
    self.config = config
  }

  public var heldCount: Int { held.count }

  /// A finished segment arrives at `nowMs`. Returns what's ready to post, in order.
  public mutating func add(_ segment: Pending, nowMs: Int) -> [Pending] {
    var out: [Pending] = []
    if segment.speaker == .them {
      them.append(Segment(seq: them.count, startedMs: segment.startedMs, endedMs: segment.endedMs, speaker: .them, text: segment.text))
      out.append(segment)
    } else {
      held.append((segment, nowMs))
    }
    return out + release(nowMs: nowMs)
  }

  /// A `them` segment that's already saved (transcribed from audio replayed after a reconnect):
  /// nothing to post, but `me` segments are judged against it.
  public mutating func noteThem(_ segment: Pending) {
    guard segment.speaker == .them else { return }
    them.append(Segment(seq: them.count, startedMs: segment.startedMs, endedMs: segment.endedMs, speaker: .them, text: segment.text))
  }

  /// `me` segments that have waited long enough, judged now.
  public mutating func release(nowMs: Int) -> [Pending] {
    var out: [Pending] = []
    while let first = held.first, nowMs - first.arrivedMs >= holdMs {
      held.removeFirst()
      if let kept = judge(first.segment) { out.append(kept) }
    }
    prune()
    return out
  }

  /// Recording stopped: both sides are complete, judge everything held.
  public mutating func releaseAll() -> [Pending] {
    let pending = held.map(\.segment)
    held = []
    return pending.compactMap { judge($0) }
  }

  private mutating func judge(_ segment: Pending) -> Pending? {
    let me = Segment(seq: 0, startedMs: segment.startedMs, endedMs: segment.endedMs, speaker: .me, text: segment.text)
    switch EchoDedupe.decide(me: me, them: them, config: config) {
    case .keep:
      return segment
    case .drop:
      dropped += 1
      return nil
    case .trim(let text):
      trimmed += 1
      var kept = segment
      kept.text = text
      return kept
    }
  }

  private mutating func prune() {
    let horizon = (held.map(\.segment.startedMs).min() ?? them.last?.endedMs ?? 0) - Self.keepThemMs
    them.removeAll { $0.endedMs < horizon }
  }
}
