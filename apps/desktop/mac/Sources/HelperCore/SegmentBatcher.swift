import Foundation

/// Finished transcript segments waiting to be posted. The recorder takes a batch every ~10 s and
/// on stop; a batch that fails goes back to the front, so nothing is lost or reordered. Seq is
/// assigned here from the turn's start (`TranscriptSeq`), so the transcript reads in time order.
public struct SegmentBatcher: Sendable {
  public static let interval: TimeInterval = 10
  /// Segments per `/segments` request. The Worker inserts a request's rows in one statement,
  /// and D1 limits the variables in one (a 300-segment backlog after an outage got a 500).
  public static let maxBatch = 50

  public private(set) var pending: [Segment] = []
  private var used = Set<Int>()

  public init() {}

  /// Queues a finished segment and returns it with its seq. Blank text is dropped.
  @discardableResult
  public mutating func add(speaker: Speaker, startedMs: Int, endedMs: Int, text: String) -> Segment? {
    let clean = text.split(whereSeparator: \.isWhitespace).joined(separator: " ")
    guard !clean.isEmpty else { return nil }
    let start = max(0, startedMs)
    var seq = TranscriptSeq.make(startedMs: start, speaker: speaker)
    // Two turns of one speaker in the same millisecond can't happen, but never reuse a seq: the
    // Worker would drop the second.
    while used.contains(seq) { seq += 4 }
    used.insert(seq)
    let segment = Segment(seq: seq, startedMs: start, endedMs: max(start, endedMs), speaker: speaker, text: clean)
    pending.append(segment)
    return segment
  }

  /// Up to `max` of the oldest segments, removed from the queue. Empty when there's nothing.
  public mutating func takeBatch(max: Int = SegmentBatcher.maxBatch) -> [Segment] {
    let batch = Array(pending.prefix(max))
    pending.removeFirst(batch.count)
    return batch
  }

  /// Puts a batch that failed to post back in front of anything queued since.
  public mutating func restore(_ batch: [Segment]) {
    let known = Set(pending.map(\.seq))
    pending.insert(contentsOf: batch.filter { !known.contains($0.seq) }, at: 0)
  }

  public var isEmpty: Bool { pending.isEmpty }
}
