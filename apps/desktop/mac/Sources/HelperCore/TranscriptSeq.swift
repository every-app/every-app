import Foundation

/// A segment's `seq`: its sort key in the meeting's transcript (the Worker orders by seq and
/// keeps one row per seq). Derived from when the turn started, so segments slot into place in
/// time order whatever order they finish in: a turn replayed after a reconnect lands among the
/// live turns around it. Not a count, and not consecutive.
///
///   seq = startedMs × 4 + (them ? 2 : 0) + (replayed ? 1 : 0)
///
/// Unique because one speaker's turns never start in the same millisecond, and live and replayed
/// audio never cover the same moment. About 58 million for a four-hour meeting.
public enum TranscriptSeq {
  public static func make(startedMs: Int, speaker: Speaker?, replay: Bool = false) -> Int {
    max(0, startedMs) * 4 + (speaker == .them ? 2 : 0) + (replay ? 1 : 0)
  }
}
