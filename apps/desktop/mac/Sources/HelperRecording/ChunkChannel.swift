import Foundation
import HelperCore

/// The fallback when the Worker can't mint Realtime keys (`APIError.isRealtimeUnavailable`):
/// chunks of up to 30 s, cut at turn ends, go to `POST …/audio-chunk` as in-memory WAVs; the
/// Worker passes each to OpenAI's transcription endpoint, stores the segment and drops the audio.
public actor ChunkChannel: SpeakerChannel {
  static let maxAttempts = 3

  /// How much audio may wait behind a slow or failing upload. A 30 s chunk is about 1.4 MB of
  /// WAV, so this is roughly three minutes; past it (or past `maxQueuedAge`) the oldest waiting
  /// chunks are dropped and `callbacks.backlog` says so.
  public struct Limits: Sendable {
    public var maxQueuedBytes: Int = 8 << 20
    public var maxQueuedAge: Duration = .seconds(180)
    /// One upload attempt; a timeout counts as a transient failure.
    public var uploadTimeout: Duration = .seconds(60)
    /// Before retry n (1-based): n × this.
    public var retryBase: Duration = .seconds(2)
    /// The clock for `maxQueuedAge` (tests pass a manual one).
    public var now: @Sendable () -> ContinuousClock.Instant = { .now }

    public init() {}

    /// Replaying a Realtime outage: the whole outage (≤ 5 min, `OutageBuffer`) is queued at once
    /// and uploaded one chunk at a time, so neither limit may drop any of it. Memory is already
    /// bounded by the outage buffer; time is bounded by the pipeline's stop budget.
    public static var replay: Limits {
      var limits = Limits()
      limits.maxQueuedBytes = OutageBuffer.defaultMaxBytes + (1 << 20)  // + WAV headers
      limits.maxQueuedAge = .seconds(3_600)
      return limits
    }
  }

  struct Pending {
    var wav: Data
    var seq: Int
    var startedMs: Int
    var endedMs: Int
    var queuedAt: ContinuousClock.Instant
  }

  let speaker: Speaker
  let language: String?
  let upload: @Sendable (_ wav: Data, _ seq: Int, _ t0: Int, _ t1: Int) async throws -> Segment?
  /// A chunk's seq from its start (meeting time): `TranscriptSeq`.
  let seqFor: @Sendable (Int) -> Int
  /// Meeting time of the first audio fed (a replay starts mid-meeting).
  let offsetMs: Int
  let callbacks: ChannelCallbacks
  let limits: Limits

  private var cutter = ChunkCutter()
  private var pending: [Pending] = []
  private var worker: Task<Void, Never>?
  private var stopped = false
  private var cancelled = false

  public init(
    speaker: Speaker, language: String?, offsetMs: Int = 0, seqFor: @escaping @Sendable (Int) -> Int,
    upload: @escaping @Sendable (_ wav: Data, _ seq: Int, _ t0: Int, _ t1: Int) async throws -> Segment?,
    callbacks: ChannelCallbacks, limits: Limits = Limits()
  ) {
    self.speaker = speaker
    self.language = language
    self.offsetMs = offsetMs
    self.seqFor = seqFor
    self.upload = upload
    self.callbacks = callbacks
    self.limits = limits
  }

  /// WAV bytes waiting to upload (not counting the one uploading now).
  public var queuedBytes: Int { pending.reduce(0) { $0 + $1.wav.count } }
  public var queuedCount: Int { pending.count }

  public func start() async throws {}

  public func feed(_ pcm: Data) async {
    guard !stopped else { return }
    for chunk in cutter.feed(pcm) { enqueue(chunk) }
  }

  /// Sends the last chunk and waits for the queue (bounded by `limits`) to drain.
  public func finish() async {
    guard !stopped else { return }
    stopped = true
    if let chunk = cutter.finish() { enqueue(chunk) }
    await worker?.value
  }

  public func cancel() async {
    stopped = true
    cancelled = true
    pending = []
    worker?.cancel()
    cutter = ChunkCutter()
  }

  // MARK: Private

  private func enqueue(_ chunk: ChunkCutter.Chunk) {
    pending.append(
      Pending(
        wav: WAV.encode(pcm16: chunk.pcm), seq: seqFor(chunk.startedMs + offsetMs), startedMs: chunk.startedMs + offsetMs,
        endedMs: chunk.endedMs + offsetMs,
        queuedAt: limits.now()))
    trim()
    if worker == nil {
      worker = Task { await self.drain() }
    }
  }

  /// Drop-oldest: keeps the newest chunk, drops waiting chunks past the byte or age limit.
  private func trim() {
    let now = limits.now()
    var dropped: [Pending] = []
    while let oldest = pending.first,
      (pending.count > 1 && queuedBytes > limits.maxQueuedBytes) || now - oldest.queuedAt > limits.maxQueuedAge
    {
      dropped.append(pending.removeFirst())
    }
    guard !dropped.isEmpty else { return }
    let ms = dropped.reduce(0) { $0 + ($1.endedMs - $1.startedMs) }
    callbacks.backlog(
      speaker,
      "Transcription is falling behind: \(Int((Double(ms) / 1000).rounded())) s of audio was dropped while uploads were slow")
  }

  /// One upload at a time, in order, so the Worker sees seqs ascending.
  private func drain() async {
    while !cancelled {
      trim()
      guard !pending.isEmpty else { break }
      let next = pending.removeFirst()
      await send(next)
    }
    worker = nil
  }

  private func send(_ chunk: Pending) async {
    for attempt in 1...Self.maxAttempts {
      guard !cancelled, !Task.isCancelled else { return }
      do {
        let segment = try await Self.withTimeout(limits.uploadTimeout) { [upload] in
          try await upload(chunk.wav, chunk.seq, chunk.startedMs, chunk.endedMs)
        }
        if let segment { callbacks.stored(segment) }
        callbacks.problem(speaker, nil)
        return
      } catch {
        // A bad, oversized or refused chunk (4xx) fails the same way every time.
        let permanent: Bool = {
          if case APIError.server(let status, _, _) = error { return (400..<500).contains(status) && status != 429 }
          return error is APIError
        }()
        if permanent || attempt == Self.maxAttempts {
          callbacks.problem(speaker, "A stretch of audio couldn't be transcribed: \(error.localizedDescription)")
          return
        }
        try? await Task.sleep(for: limits.retryBase * attempt)
      }
    }
  }

  struct UploadTimedOut: Error, LocalizedError {
    var errorDescription: String? { "The upload took too long." }
  }

  static func withTimeout<T: Sendable>(_ limit: Duration, _ operation: @escaping @Sendable () async throws -> T) async throws -> T {
    try await withThrowingTaskGroup(of: T.self) { group in
      group.addTask { try await operation() }
      group.addTask {
        try await Task.sleep(for: limit)
        throw UploadTimedOut()
      }
      defer { group.cancelAll() }
      return try await group.next()!
    }
  }
}
