import Foundation
import HelperCore

/// A capture source (the mic, or the system audio tap) delivering PCM16 24 kHz mono.
public protocol AudioSource: AnyObject, Sendable {
  func start() throws
  func stop()
}

/// What a running source can say about itself (the self-test prints it).
public protocol CaptureInfo {
  /// The device's own rate, before conversion to 24 kHz.
  var sampleRate: Double? { get }
  var deviceName: String? { get }
  /// Voice processing (echo cancellation) is actually on.
  var voiceProcessingActive: Bool { get }
}

public enum RecordingMode: String, Sendable, Equatable {
  /// `custom`: the person's own transcription server (`TranscriptionServer`); audio goes only there.
  case realtime, fallback, custom
}

/// How one source sounds: `silent` means no signal at all for a while (a denied tap, a muted
/// device, nothing playing); `error` means capture stopped or never started.
public enum SourceHealth: String, Sendable, Equatable {
  case ok, silent, error
}

public enum RecordingEvent: Sendable, Equatable {
  case mode(RecordingMode)
  /// The text so far of a turn still being transcribed (Realtime only).
  case delta(speaker: Speaker, text: String, itemID: String)
  /// A finished segment with its seq (queued for posting, or already stored by the fallback).
  case segment(Segment)
  case transcriptionProblem(Speaker, String?)
  case captureProblem(Speaker, String?)
  case health(mic: SourceHealth, system: SourceHealth)
  /// 0–1 each, at most 10 Hz.
  case levels(mic: Double, system: Double)
  /// Segments couldn't be posted (they're kept and retried).
  case saveProblem(String)
  /// The fallback dropped queued audio because uploads couldn't keep up.
  case fallbackBacklog(Speaker, String)
  /// Audio from a Realtime outage is being transcribed through the fallback (true), or that's done.
  case catchingUp(Bool)
  /// A stretch of that audio couldn't be transcribed.
  case catchUpProblem(Speaker, String)
}

/// `RecordingPipeline.abort()` was called before capture started.
public struct RecordingAborted: Error, LocalizedError {
  public var errorDescription: String? { "The recording was stopped before it started." }
}

/// Per-recording choices.
public struct RecordingOptions: Sendable, Equatable {
  /// Drop `me` segments that repeat what `them` just said (EchoDedupe). On by default.
  public var dedupeEcho = true

  public init(dedupeEcho: Bool = true) {
    self.dedupeEcho = dedupeEcho
  }
}

/// One meeting's recording, minus creating the meeting: capture both sides, stream each to its
/// own transcription channel, post finished segments every ten seconds and on stop, then
/// `/finish`. Driven by `everyapp-helper`'s `HelperServer`. Audio is never stored.
@MainActor
public final class RecordingPipeline {
  public struct Dependencies: Sendable {
    public var makeMic: @Sendable (
      _ voiceProcessing: Bool, _ onAudio: @escaping @Sendable (Data) -> Void, _ onInterrupted: @escaping @Sendable (String?) -> Void
    ) -> any AudioSource
    public var makeSystem: @Sendable (_ onAudio: @escaping @Sendable (Data) -> Void, _ onInterrupted: @escaping @Sendable (String?) -> Void) -> any AudioSource
    public var makeRealtime: @Sendable (
      _ speaker: Speaker, _ language: String?, _ fetchToken: @escaping @Sendable () async throws -> TranscriptionToken,
      _ callbacks: ChannelCallbacks
    ) -> any SpeakerChannel
    /// The chunk fallback, live (offset 0) or replaying an outage (offset = its start).
    public var makeFallback: @Sendable (
      _ speaker: Speaker, _ language: String?, _ offsetMs: Int, _ seqFor: @escaping @Sendable (Int) -> Int,
      _ upload: @escaping @Sendable (Data, Int, Int, Int) async throws -> Segment?, _ callbacks: ChannelCallbacks
    ) -> any SpeakerChannel
    /// What replays a Realtime outage's audio (the chunk fallback unless a test says otherwise).
    public var makeReplay: (@Sendable (
      _ speaker: Speaker, _ language: String?, _ offsetMs: Int, _ seqFor: @escaping @Sendable (Int) -> Int,
      _ upload: @escaping @Sendable (Data, Int, Int, Int) async throws -> Segment?, _ callbacks: ChannelCallbacks
    ) -> any SpeakerChannel)?
    /// A speaker's channel to the person's own server (`OwnServerChannel` unless a test says otherwise).
    public var makeOwnServer: (@Sendable (
      _ speaker: Speaker, _ language: String?, _ transcribe: @escaping @Sendable (Data, String?) async throws -> String,
      _ callbacks: ChannelCallbacks
    ) -> any SpeakerChannel)?
    public var flushInterval: TimeInterval = SegmentBatcher.interval
    /// After the channels finish, how long to let the last segments land.
    public var settle: Duration = .milliseconds(300)
    public var finalRetryDelay: Duration = .seconds(2)
    /// No signal at all for this long makes a source `silent`.
    public var silenceAfter: TimeInterval = 5
    public var levelInterval: Duration = .milliseconds(100)
    /// How long a `me` segment waits for the other side before the echo check.
    public var echoHoldMs = EchoFilter.defaultHoldMs
    /// How long stop waits for outage replays still uploading before cutting them short. Bounds
    /// the whole stop: this + the final flush (≤ ~6 min with a token wait) + `/finish`.
    public var replayStopBudget: Duration = .seconds(300)
    /// The clock for the echo hold (tests pass a manual one).
    public var now: @Sendable () -> ContinuousClock.Instant = { .now }

    public init(
      makeMic: @escaping @Sendable (Bool, @escaping @Sendable (Data) -> Void, @escaping @Sendable (String?) -> Void) -> any AudioSource,
      makeSystem: @escaping @Sendable (_ onAudio: @escaping @Sendable (Data) -> Void, _ onInterrupted: @escaping @Sendable (String?) -> Void) -> any AudioSource,
      makeRealtime: @escaping @Sendable (Speaker, String?, @escaping @Sendable () async throws -> TranscriptionToken, ChannelCallbacks) -> any SpeakerChannel,
      makeFallback: @escaping @Sendable (
        Speaker, String?, Int, @escaping @Sendable (Int) -> Int, @escaping @Sendable (Data, Int, Int, Int) async throws -> Segment?,
        ChannelCallbacks
      ) -> any SpeakerChannel
    ) {
      self.makeMic = makeMic
      self.makeSystem = makeSystem
      self.makeRealtime = makeRealtime
      self.makeFallback = makeFallback
    }

    /// The real mic, the Core Audio tap, OpenAI Realtime and the chunk fallback.
    public static var live: Dependencies {
      Dependencies(
        makeMic: { MicCapture(voiceProcessing: $0, onAudio: $1, onInterrupted: $2) },
        makeSystem: { SystemAudioCapture(onAudio: $0, onInterrupted: $1) },
        makeRealtime: { TranscriptionChannel(speaker: $0, language: $1, fetchToken: $2, callbacks: $3) },
        makeFallback: { ChunkChannel(speaker: $0, language: $1, offsetMs: $2, seqFor: $3, upload: $4, callbacks: $5) }
      )
    }
  }

  public struct StopResult: Sendable, Equatable {
    /// Segments saved for this meeting while it recorded (posted, or stored by the fallback).
    public var segments: Int
    /// Why `/finish` or the last post failed, if it did.
    public var problem: String?
    /// `/finish` succeeded. False when it failed, or wasn't tried because segments are unsaved.
    public var finished: Bool = true
    /// Segments that never posted (offline, signed out), in seq order, already echo-checked.
    /// The caller keeps them and posts them (then `/finish`) when it can; the Worker ignores a
    /// seq it already has.
    public var unsaved: [Segment] = []

    public init(segments: Int, problem: String? = nil, finished: Bool = true, unsaved: [Segment] = []) {
      self.segments = segments
      self.problem = problem
      self.finished = finished
      self.unsaved = unsaved
    }
  }

  public let meetingID: String
  public let language: String?
  public let options: RecordingOptions
  public private(set) var mode: RecordingMode = .realtime
  public private(set) var health: (mic: SourceHealth, system: SourceHealth) = (.ok, .ok)

  private let api: APIClient
  /// The person's own transcription server, when they set one: then nothing else gets audio.
  private let ownServer: TranscriptionServerClient?
  /// Audio their server never transcribed (down too long, or it refused it): said on stop.
  private var ownServerLoss: String?
  private let deps: Dependencies
  private let onEvent: @MainActor (RecordingEvent) -> Void
  private var mic: (any AudioSource)?
  private var system: (any AudioSource)?
  private var channels: [Speaker: any SpeakerChannel] = [:]
  private var pumps: [Task<Void, Never>] = []
  private var continuations: [Speaker: AsyncStream<Data>.Continuation] = [:]
  private var batcher = SegmentBatcher()
  /// Segments the Worker refused outright (a 4xx a retry won't fix): not retried, handed back.
  private var refused: [Segment] = []
  private var echo: EchoFilter?
  /// Speakers whose transcription is failing right now (a Realtime reconnect, fallback errors).
  private var down: Set<Speaker> = []
  /// Outage replays still uploading, per speaker, and every replay task (stop waits for them).
  private var replaying: [Speaker: Int] = [:]
  private var replayTasks: [Task<Void, Never>] = []
  private var replayChannels: [any SpeakerChannel] = []
  private var replayFailures = 0
  private var isStopping = false
  private var replayCutShort = false
  private let startedAt: ContinuousClock.Instant
  private var flushTask: Task<Void, Never>?
  private var levelTask: Task<Void, Never>?
  private var activeFlush: Task<String?, Never>?
  private var aborted = false
  private var saved = 0
  private var captureProblems: [Speaker: String] = [:]
  private let meters: [Speaker: LevelMeter] = [.me: LevelMeter(), .them: LevelMeter()]
  private var running = false

  /// True once capture has started (and until stop).
  public var isRunning: Bool { running }

  public init(
    meetingID: String, api: APIClient, language: String?, options: RecordingOptions = RecordingOptions(),
    ownServer: TranscriptionServerClient? = nil,
    dependencies: Dependencies = .live, onEvent: @escaping @MainActor (RecordingEvent) -> Void
  ) {
    self.meetingID = meetingID
    self.api = api
    self.ownServer = ownServer
    self.language = language
    self.options = options
    self.deps = dependencies
    self.onEvent = onEvent
    self.startedAt = dependencies.now()
    if options.dedupeEcho { echo = EchoFilter(holdMs: dependencies.echoHoldMs) }
    if ownServer != nil { mode = .custom }
  }

  /// `me` segments waiting for the echo check.
  var heldForEcho: Int { echo?.heldCount ?? 0 }

  /// `me` segments dropped / trimmed as echo so far.
  public var echoCounts: (dropped: Int, trimmed: Int) { (echo?.dropped ?? 0, echo?.trimmed ?? 0) }

  /// Gets both keys (or falls back to chunks), then starts the mic and the system tap. Throws if
  /// transcription or the mic can't start; everything is torn down then. A system tap that
  /// won't start isn't fatal: the meeting records your side and says so.
  public func start() async throws {
    precondition(!running, "start once")
    do {
      try await startCapture()
    } catch {
      await teardown()
      throw error
    }
    running = true
    flushTask = Task { [weak self, deps] in
      while !Task.isCancelled {
        try? await Task.sleep(for: .seconds(deps.flushInterval))
        guard !Task.isCancelled else { return }
        await self?.flush()
      }
    }
    levelTask = Task { [weak self, deps] in
      while !Task.isCancelled {
        try? await Task.sleep(for: deps.levelInterval)
        guard !Task.isCancelled else { return }
        self?.tickLevels()
      }
    }
  }

  /// Stops the audio, lets each channel finish its last turn, posts what's left and finishes
  /// the meeting.
  public func stop() async -> StopResult {
    guard running else { return StopResult(segments: saved, problem: nil) }
    running = false
    isStopping = true
    defer { isStopping = false }
    flushTask?.cancel()
    flushTask = nil
    levelTask?.cancel()
    levelTask = nil
    mic?.stop()
    system?.stop()
    for continuation in continuations.values { continuation.finish() }
    for pump in pumps { await pump.value }
    let open = Array(channels.values)
    await withTaskGroup(of: Void.self) { group in
      for channel in open { group.addTask { await channel.finish() } }
    }
    // Segments reach the batcher through main-actor tasks; let the last ones land.
    try? await Task.sleep(for: deps.settle)
    // Audio from an outage still uploading: finish it first (`/audio-chunk` needs the meeting
    // still recording, and its `them` text informs the echo check).
    let budget = Task { [weak self, deps] in
      try? await Task.sleep(for: deps.replayStopBudget)
      guard !Task.isCancelled else { return }
      await self?.cutReplaysShort()
    }
    var next = 0
    while next < replayTasks.count {  // one may start while we wait (a channel handing over late)
      await replayTasks[next].value
      next += 1
    }
    budget.cancel()
    // Both sides are complete: judge every `me` segment still waiting for the echo check.
    if echo != nil { queue(echo!.releaseAll()) }
    var problem = await flush(final: true)
    if problem == nil, replayCutShort {
      problem = "The recording stopped before all the audio from a reconnect was transcribed (it took over \(deps.replayStopBudget.components.seconds / 60) minutes)."
    } else if problem == nil, replayFailures > 0 {
      problem = "Some audio from a reconnect couldn't be transcribed (\(replayFailures) stretch\(replayFailures == 1 ? "" : "es"))."
    }
    if problem == nil, let ownServerLoss { problem = ownServerLoss }
    let unsaved = (refused + batcher.pending).sorted { $0.seq < $1.seq }
    if problem == nil, !refused.isEmpty { problem = "Scribe refused \(refused.count) transcript segment(s)." }
    var finished = false
    if unsaved.isEmpty {
      do {
        try await api.finish(meetingID: meetingID)
        finished = true
      } catch {
        problem = "The recording stopped, but Scribe couldn't be told to write notes: \(error.localizedDescription)"
      }
    }
    // With segments unsaved, /finish waits: notes written now would miss them. The caller posts
    // them and then finishes.
    await teardown()
    return StopResult(segments: saved, problem: problem, finished: finished, unsaved: unsaved)
  }

  /// Stop a `start()` that's still getting keys: it throws `RecordingAborted` instead of
  /// starting capture. No effect once capture has started (use `stop()`).
  public func abort() {
    aborted = true
  }

  /// Drops everything without posting or finishing.
  public func cancel() async {
    running = false
    await teardown()
  }

  // MARK: Private

  private func callbacks() -> ChannelCallbacks {
    ChannelCallbacks(
      segment: { [weak self] speaker, t0, t1, text in
        Task { @MainActor in self?.add(speaker: speaker, t0: t0, t1: t1, text: text) }
      },
      stored: { [weak self] segment in
        Task { @MainActor in
          self?.saved += 1
          self?.onEvent(.segment(segment))
        }
      },
      delta: { [weak self] speaker, text, itemID in
        Task { @MainActor in self?.onEvent(.delta(speaker: speaker, text: text, itemID: itemID)) }
      },
      problem: { [weak self] speaker, problem in
        Task { @MainActor in
          guard let self else { return }
          if problem != nil { self.down.insert(speaker) } else { self.down.remove(speaker) }
          self.onEvent(.transcriptionProblem(speaker, problem))
        }
      },
      backlog: { [weak self] speaker, message in
        Task { @MainActor in self?.onEvent(.fallbackBacklog(speaker, message)) }
      },
      catchUp: { [weak self] speaker, pcm, startMs in
        Task { @MainActor in self?.replay(speaker: speaker, pcm: pcm, startMs: startMs) }
      })
  }

  /// Transcribes audio kept during a Realtime outage through the chunk fallback, while live
  /// audio goes on to Realtime. Its segments get replay seqs, so they slot in by time.
  private func replay(speaker: Speaker, pcm: Data, startMs: Int) {
    guard running || isStopping, ownServer == nil else { return }
    let api = self.api, meetingID = self.meetingID, language = self.language
    let callbacks = ChannelCallbacks(
      segment: { _, _, _, _ in },
      stored: { [weak self] segment in
        Task { @MainActor in
          guard let self else { return }
          self.saved += 1
          // Their words from the outage: echo of them in my held segments is still caught.
          if segment.speaker == .them {
            self.echo?.noteThem(
              EchoFilter.Pending(speaker: .them, startedMs: segment.startedMs, endedMs: segment.endedMs, text: segment.text))
          }
          self.onEvent(.segment(segment))
        }
      },
      delta: { _, _, _ in },
      problem: { [weak self] speaker, problem in
        guard let problem else { return }
        Task { @MainActor in
          self?.replayFailures += 1
          self?.onEvent(.catchUpProblem(speaker, problem))
        }
      },
      backlog: { [weak self] speaker, message in
        Task { @MainActor in self?.onEvent(.fallbackBacklog(speaker, message)) }
      })
    let make = deps.makeReplay ?? {
      ChunkChannel(speaker: $0, language: $1, offsetMs: $2, seqFor: $3, upload: $4, callbacks: $5, limits: .replay)
    }
    let channel = make(
      speaker, language, startMs, { TranscriptSeq.make(startedMs: $0, speaker: speaker, replay: true) },
      { wav, number, t0, t1 in
        try await api.appendAudioChunk(
          meetingID: meetingID, wav: wav, seq: number, startedMs: t0, endedMs: t1, speaker: speaker, language: language)
      }, callbacks)
    replayChannels.append(channel)
    let wasCatchingUp = isCatchingUp
    replaying[speaker, default: 0] += 1
    if !wasCatchingUp { onEvent(.catchingUp(true)) }
    replayTasks.append(Task { [weak self] in
      await channel.feed(pcm)
      await channel.finish()
      self?.replayDone(speaker)
    })
  }

  /// Stop's budget ran out: cancel the replays (their in-flight uploads too).
  private func cutReplaysShort() async {
    replayCutShort = true
    for channel in replayChannels { await channel.cancel() }
  }

  private func replayDone(_ speaker: Speaker) {
    replaying[speaker, default: 1] -= 1
    if !isCatchingUp { onEvent(.catchingUp(false)) }
    releaseEcho()
  }

  private var isCatchingUp: Bool { replaying.values.contains { $0 > 0 } }

  /// `me` segments wait while the other side's words for the same moments are still missing.
  private var themIncomplete: Bool { down.contains(.them) || (replaying[.them] ?? 0) > 0 }

  private var nowMs: Int {
    let elapsed = deps.now() - startedAt
    return Int(elapsed.components.seconds * 1000 + elapsed.components.attoseconds / 1_000_000_000_000_000)
  }

  /// A finished turn: through the echo filter (`me` waits there a moment), then into the batcher.
  private func add(speaker: Speaker, t0: Int, t1: Int, text: String) {
    let pending = EchoFilter.Pending(speaker: speaker, startedMs: t0, endedMs: t1, text: text)
    if echo != nil {
      queue(echo!.add(pending, nowMs: nowMs))
    } else {
      queue([pending])
    }
  }

  /// `me` segments whose echo check is due.
  private func releaseEcho() {
    guard echo != nil, echo!.heldCount > 0, !themIncomplete else { return }
    queue(echo!.release(nowMs: nowMs))
  }

  private func queue(_ ready: [EchoFilter.Pending]) {
    for p in ready {
      guard let segment = batcher.add(speaker: p.speaker, startedMs: p.startedMs, endedMs: p.endedMs, text: p.text) else { continue }
      onEvent(.segment(segment))
    }
  }

  private func startCapture() async throws {
    let api = self.api
    let meetingID = self.meetingID
    let language = self.language
    let callbacks = callbacks()
    for speaker in [Speaker.me, .them] {
      if let ownServer {
        channels[speaker] = ownServerChannel(ownServer, speaker, callbacks)
        continue
      }
      channels[speaker] = deps.makeRealtime(
        speaker, language,
        { try await api.transcriptionToken(meetingID: meetingID, source: speaker == .me ? "mic" : "system", language: language) },
        callbacks)
    }
    // Both keys first: if the Worker can't mint them, decide before touching audio.
    do {
      try await startChannels()
      onEvent(.mode(mode))
    } catch let error as APIError where error.isRealtimeUnavailable && ownServer == nil {
      // No live keys: send 30 s chunks to the Worker instead (SPEC "Fallback").
      for channel in channels.values { await channel.cancel() }
      for speaker in [Speaker.me, .them] {
        channels[speaker] = deps.makeFallback(
          speaker, language, 0, { TranscriptSeq.make(startedMs: $0, speaker: speaker) },
          { wav, number, t0, t1 in
            try await api.appendAudioChunk(
              meetingID: meetingID, wav: wav, seq: number, startedMs: t0, endedMs: t1, speaker: speaker, language: language)
          }, callbacks)
      }
      try await startChannels()
      mode = .fallback
      onEvent(.mode(.fallback))
    }
    // Stopped while the keys were being fetched: don't touch audio.
    if aborted { throw RecordingAborted() }
    for speaker in [Speaker.me, .them] {
      let channel = channels[speaker]!
      // Ordered delivery from the audio thread to the channel.
      let (stream, continuation) = AsyncStream<Data>.makeStream(bufferingPolicy: .bufferingNewest(600))
      continuations[speaker] = continuation
      pumps.append(Task.detached { for await chunk in stream { await channel.feed(chunk) } })
    }

    let micSink = continuations[.me]!
    let micMeter = meters[.me]!
    // Recordings never use voice processing (only `everyapp-helper --selftest --echo-cancellation`
    // can, for a future hardware test); text-level echo dedupe handles laptop speakers.
    let mic = deps.makeMic(false, { micMeter.measure($0); micSink.yield($0) }, { [weak self] problem in
      Task { @MainActor in self?.setCaptureProblem(.me, problem) }
    })
    try mic.start()
    self.mic = mic

    let systemSink = continuations[.them]!
    let systemMeter = meters[.them]!
    let system = deps.makeSystem({ systemMeter.measure($0); systemSink.yield($0) }, { [weak self] problem in
      Task { @MainActor in self?.setCaptureProblem(.them, problem) }
    })
    do {
      try system.start()
      self.system = system
    } catch {
      // The meeting still records your side.
      setCaptureProblem(.them, "Not hearing the other side: \(error.localizedDescription)")
    }
  }

  /// A speaker's channel to the person's own server. Its audio goes nowhere else: no Realtime
  /// key is fetched, and nothing is replayed through the Worker's fallback.
  private func ownServerChannel(_ client: TranscriptionServerClient, _ speaker: Speaker, _ callbacks: ChannelCallbacks) -> any SpeakerChannel {
    var callbacks = callbacks
    callbacks.backlog = { [weak self] speaker, message in
      Task { @MainActor in
        self?.ownServerLoss = message
        self?.onEvent(.fallbackBacklog(speaker, message))
      }
    }
    let transcribe: @Sendable (Data, String?) async throws -> String = { wav, language in
      try await client.transcribe(wav: wav, language: language)
    }
    if let make = deps.makeOwnServer { return make(speaker, language, transcribe, callbacks) }
    return OwnServerChannel(speaker: speaker, language: language, transcribe: transcribe, callbacks: callbacks)
  }

  private func startChannels() async throws {
    let open = Array(channels.values)
    try await withThrowingTaskGroup(of: Void.self) { group in
      for channel in open { group.addTask { try await channel.start() } }
      try await group.waitForAll()
    }
  }

  /// Posts queued segments. A periodic flush skips if one is running; the final flush first
  /// waits for a running one (whose post may still be in flight), then drains the rest, so
  /// `/finish` never overtakes a post. Mid-meeting a failure waits for the next tick; on stop, a
  /// few quick retries. Returns a sentence when segments were left unsaved.
  @discardableResult
  private func flush(final: Bool = false) async -> String? {
    if !final { releaseEcho() }
    if let running = activeFlush {
      guard final else { return nil }
      _ = await running.value
    }
    // Unstructured, so cancelling the periodic flush loop doesn't cancel a post mid-flight.
    let task = Task { await self.drain(final: final) }
    activeFlush = task
    let problem = await task.value
    if activeFlush == task { activeFlush = nil }
    return problem
  }

  private func drain(final: Bool) async -> String? {
    var attempts = 0
    // Oldest first, ≤ 50 per request; a failure stops the drain so seqs post in order.
    while !batcher.isEmpty {
      let batch = batcher.takeBatch()
      do {
        try await api.appendSegments(meetingID: meetingID, batch)
        saved += batch.count
      } catch let error as APIError where error.isPermanentRefusal {
        // Retrying won't change the answer: set them aside (handed back on stop) and go on.
        refused.append(contentsOf: batch)
        onEvent(.saveProblem("Scribe refused \(batch.count) transcript segment(s): \(error.localizedDescription)"))
      } catch {
        batcher.restore(batch)
        attempts += 1
        let message = "Some of the transcript couldn't be saved: \(error.localizedDescription)"
        guard final, attempts < 3 else {
          onEvent(.saveProblem(message))
          return message
        }
        try? await Task.sleep(for: deps.finalRetryDelay)
      }
    }
    return nil
  }

  private func setCaptureProblem(_ speaker: Speaker, _ problem: String?) {
    captureProblems[speaker] = problem
    onEvent(.captureProblem(speaker, problem))
    updateHealth()
  }

  private func tickLevels() {
    guard running else { return }
    releaseEcho()
    let me = meters[.me]!.take()
    let them = meters[.them]!.take()
    onEvent(.levels(mic: me, system: them))
    updateHealth()
  }

  private func updateHealth() {
    func current(_ speaker: Speaker) -> SourceHealth {
      if captureProblems[speaker] != nil { return .error }
      if running, meters[speaker]!.silentFor >= deps.silenceAfter { return .silent }
      return .ok
    }
    let now = (mic: current(.me), system: current(.them))
    guard now != self.health else { return }
    self.health = now
    onEvent(.health(mic: now.mic, system: now.system))
  }

  private func teardown() async {
    for channel in replayChannels { await channel.cancel() }
    replayChannels = []
    replayTasks = []
    flushTask?.cancel()
    flushTask = nil
    levelTask?.cancel()
    levelTask = nil
    mic?.stop()
    system?.stop()
    mic = nil
    system = nil
    for continuation in continuations.values { continuation.finish() }
    continuations = [:]
    for channel in channels.values { await channel.cancel() }
    channels = [:]
    pumps = []
  }
}

/// Peak level and "last heard anything" for one source, written from the audio thread.
public final class LevelMeter: @unchecked Sendable {
  private let lock = NSLock()
  private var peakRMS: Double = 0
  private var lastSignal = Date()

  public init() {}

  /// PCM16 mono. Anything above digital silence counts as signal.
  public func measure(_ pcm: Data) {
    let samples = PCM16.decode(pcm)
    guard !samples.isEmpty else { return }
    var sum: Double = 0
    var loud = false
    for s in samples {
      let v = Double(s) / 32768
      sum += v * v
      if s > 1 || s < -1 { loud = true }
    }
    let rms = (sum / Double(samples.count)).squareRoot()
    lock.withLock {
      peakRMS = max(peakRMS, rms)
      if loud { lastSignal = Date() }
    }
  }

  /// The loudest level since the last call, 0–1 on a −60…0 dBFS scale.
  public func take() -> Double {
    let rms = lock.withLock {
      defer { peakRMS = 0 }
      return peakRMS
    }
    return Self.scale(rms)
  }

  public var silentFor: TimeInterval { lock.withLock { Date().timeIntervalSince(lastSignal) } }

  public static func scale(_ rms: Double) -> Double {
    guard rms > 0 else { return 0 }
    let db = 20 * log10(rms)
    return min(1, max(0, (db + 60) / 60))
  }
}
