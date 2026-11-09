import Foundation

/// One speaker's audio while their Realtime connection is down, so it can be transcribed through
/// the fallback once it's back: a ring of PCM16 24 kHz mono, in memory only, at most `maxBytes`
/// (5 minutes, ~14 MB). Past that the oldest audio goes.
public struct OutageBuffer: Sendable {
  public static let bytesPerMs = 48
  public static let defaultMaxBytes = 300_000 * bytesPerMs  // 5 minutes

  public let maxBytes: Int
  private var chunks: [Data] = []
  private var bytes = 0
  /// Meeting time (the channel's clock) of the first byte kept.
  public private(set) var startMs: Int?
  /// Audio dropped since the last `take()`, in ms.
  public private(set) var droppedMs = 0

  public init(maxBytes: Int = OutageBuffer.defaultMaxBytes) { self.maxBytes = maxBytes }

  public var isEmpty: Bool { chunks.isEmpty }
  public var count: Int { bytes }

  /// Keeps `pcm`, captured at meeting time `atMs`. True the first time audio is dropped (since
  /// the last `take()`), so the caller warns once.
  @discardableResult
  public mutating func append(_ pcm: Data, atMs: Int) -> Bool {
    guard !pcm.isEmpty else { return false }
    if chunks.isEmpty { startMs = atMs }
    chunks.append(pcm)
    bytes += pcm.count
    let wasDropping = droppedMs > 0
    while bytes > maxBytes, chunks.count > 1 {
      let first = chunks.removeFirst()
      bytes -= first.count
      let ms = first.count / Self.bytesPerMs
      droppedMs += ms
      startMs = (startMs ?? atMs) + ms
    }
    return !wasDropping && droppedMs > 0
  }

  /// Everything kept, with its start time; empties the buffer.
  public mutating func take() -> (pcm: Data, startMs: Int, droppedMs: Int)? {
    guard let startMs, !chunks.isEmpty else { return nil }
    var pcm = Data(capacity: bytes)
    for chunk in chunks { pcm.append(chunk) }
    let dropped = droppedMs
    self = OutageBuffer(maxBytes: maxBytes)
    return (pcm, startMs, dropped)
  }
}
