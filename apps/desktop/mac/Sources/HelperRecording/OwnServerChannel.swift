import Foundation
import HelperCore

/// One speaker's transcription on the person's own server (`TranscriptionServer`). The audio is
/// cut exactly as the chunk fallback cuts it (`ChunkCutter`: up to 30 s, at a turn's end), each
/// chunk goes to the server as an in-memory 16 kHz WAV, and the text comes back as a finished
/// turn the recorder posts to Scribe like any other.
///
/// The audio goes nowhere else. While the server doesn't answer, chunks wait in memory (about
/// five minutes of speech, `OutageBuffer`'s size) and the same chunk is tried again until it
/// does; past that the oldest go and `callbacks.backlog` says so. On stop, what still can't be
/// sent after `Limits.stopAttempts` more tries is given up, and said.
public actor OwnServerChannel: SpeakerChannel {
  public struct Limits: Sendable {
    /// PCM waiting behind a server that isn't answering (not counting the chunk being sent).
    public var maxQueuedBytes = OutageBuffer.defaultMaxBytes
    /// One request; a slow machine with a large model needs a while for 30 s of audio.
    public var requestTimeout: Duration = .seconds(120)
    /// Before retry n (1-based): n × this, at most `retryMax`.
    public var retryBase: Duration = .seconds(2)
    public var retryMax: Duration = .seconds(15)
    /// Tries a chunk gets once the recording is stopping, so a dead server can't hold the stop.
    public var stopAttempts = 2

    public init() {}
  }

  struct Pending {
    var pcm: Data
    var startedMs: Int
    var endedMs: Int
  }

  let speaker: Speaker
  let language: String?
  let transcribe: @Sendable (_ wav: Data, _ language: String?) async throws -> String
  let callbacks: ChannelCallbacks
  let limits: Limits

  private var cutter = ChunkCutter()
  private var pending: [Pending] = []
  private var worker: Task<Void, Never>?
  /// The wait before a retry, so stop can cut it short.
  private var retryWait: Task<Void, Never>?
  private var stopped = false
  private var cancelled = false
  /// The pipeline has been told the server isn't answering.
  private var down = false
  /// Said once per outage.
  private var warnedOverflow = false

  public init(
    speaker: Speaker, language: String?,
    transcribe: @escaping @Sendable (_ wav: Data, _ language: String?) async throws -> String,
    callbacks: ChannelCallbacks, limits: Limits = Limits()
  ) {
    self.speaker = speaker
    self.language = language
    self.transcribe = transcribe
    self.callbacks = callbacks
    self.limits = limits
  }

  /// PCM bytes waiting (not counting the chunk being sent).
  public var queuedBytes: Int { pending.reduce(0) { $0 + $1.pcm.count } }
  public var queuedCount: Int { pending.count }

  public func start() async throws {}

  public func feed(_ pcm: Data) async {
    guard !stopped else { return }
    for chunk in cutter.feed(pcm) { enqueue(chunk) }
  }

  /// Sends the last chunk and waits for the queue to drain (or be given up, if the server is down).
  public func finish() async {
    guard !stopped else { return }
    stopped = true
    if let chunk = cutter.finish() { enqueue(chunk) }
    retryWait?.cancel()
    await worker?.value
  }

  public func cancel() async {
    stopped = true
    cancelled = true
    pending = []
    retryWait?.cancel()
    worker?.cancel()
    cutter = ChunkCutter()
  }

  // MARK: Private

  private func enqueue(_ chunk: ChunkCutter.Chunk) {
    pending.append(Pending(pcm: chunk.pcm, startedMs: chunk.startedMs, endedMs: chunk.endedMs))
    var droppedMs = 0
    while pending.count > 1, queuedBytes > limits.maxQueuedBytes {
      let oldest = pending.removeFirst()
      droppedMs += oldest.endedMs - oldest.startedMs
    }
    if droppedMs > 0, !warnedOverflow {
      warnedOverflow = true
      callbacks.backlog(
        speaker, "Your transcription server didn't answer for over 5 minutes, so the oldest audio from the wait was dropped.")
    }
    if worker == nil {
      worker = Task { await self.drain() }
    }
  }

  /// One request at a time, in order.
  private func drain() async {
    while !cancelled, !pending.isEmpty {
      let next = pending.removeFirst()
      await send(next)
    }
    worker = nil
  }

  private func send(_ chunk: Pending) async {
    let wav = TranscriptionServerClient.wav(pcm24k: chunk.pcm)
    var attempt = 0
    var attemptsWhileStopping = 0
    while !cancelled, !Task.isCancelled {
      attempt += 1
      if stopped { attemptsWhileStopping += 1 }
      do {
        let text = try await ChunkChannel.withTimeout(limits.requestTimeout) { [transcribe, language] in
          try await transcribe(wav, language)
        }
        guard !cancelled else { return }
        down = false
        warnedOverflow = false
        callbacks.problem(speaker, nil)
        if !text.isEmpty { callbacks.segment(speaker, chunk.startedMs, chunk.endedMs, text) }
        return
      } catch {
        guard !cancelled else { return }
        let reason =
          error is ChunkChannel.UploadTimedOut ? "Your transcription server is taking too long to answer." : error.localizedDescription
        // A refused key, a wrong address or model: this chunk fails the same way every time.
        if let refused = error as? TranscriptionServerError, refused.isPermanent {
          down = true
          callbacks.problem(speaker, reason)
          lost([chunk], reason)
          return
        }
        if stopped, attemptsWhileStopping >= limits.stopAttempts {
          let rest = pending
          pending = []
          lost([chunk] + rest, reason)
          return
        }
        if !down {
          down = true
          callbacks.problem(speaker, "\(reason) Your audio is kept for up to 5 minutes and sent when it answers.")
        }
        guard !stopped else { continue }
        let wait = min(limits.retryBase * attempt, limits.retryMax)
        let pause = Task<Void, Never> {
          do { try await Task.sleep(for: wait) } catch {}
        }
        retryWait = pause
        await pause.value
        retryWait = nil
      }
    }
  }

  private func lost(_ chunks: [Pending], _ reason: String) {
    let ms = chunks.reduce(0) { $0 + ($1.endedMs - $1.startedMs) }
    let seconds = max(1, Int((Double(ms) / 1000).rounded()))
    callbacks.backlog(speaker, "\(seconds) s of audio couldn't be transcribed. \(reason)")
  }
}
