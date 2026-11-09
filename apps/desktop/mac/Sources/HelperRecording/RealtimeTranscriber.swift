import Foundation
import HelperCore

/// The WebSocket under a `RealtimeSession`, behind a protocol so the session's protocol handling
/// is tested without the network.
public protocol RealtimeSocket: AnyObject, Sendable {
  /// Sends in call order; `completion` gets an error if the connection failed.
  func send(_ text: String, completion: @escaping @Sendable (Error?) -> Void)
  func receive() async throws -> String
  func close()
  /// The handshake's HTTP status, when it failed with one.
  var httpStatus: Int? { get }
}

public final class URLSessionRealtimeSocket: RealtimeSocket, @unchecked Sendable {
  private let task: URLSessionWebSocketTask

  public init(_ request: URLRequest) {
    task = URLSession.shared.webSocketTask(with: request)
    task.maximumMessageSize = 4 << 20
    task.resume()
  }

  public func send(_ text: String, completion: @escaping @Sendable (Error?) -> Void) { task.send(.string(text), completionHandler: completion) }

  public func receive() async throws -> String {
    switch try await task.receive() {
    case .string(let text): return text
    case .data(let data): return String(decoding: data, as: UTF8.self)
    @unknown default: return ""
    }
  }

  public func close() { task.cancel(with: .normalClosure, reason: nil) }
  public var httpStatus: Int? { (task.response as? HTTPURLResponse)?.statusCode }
}

/// One OpenAI Realtime transcription WebSocket, opened with an ephemeral key the Worker minted
/// (docs/scribe.md "Live transcription"). Adapted from Scrawl's `openai-stream`: audio is queued
/// until `session.updated`, every commit's time range is remembered in order, the `committed`
/// acknowledgement gives an item its range and `completed` its text.
actor RealtimeSession {
  static let endpoint = URL(string: "wss://api.openai.com/v1/realtime?intent=transcription")!
  static let model = "gpt-live-transcribe"
  static let connectTimeout: TimeInterval = 15
  /// On stop, how long to wait for the last turn's `completed` before saving its text so far.
  static let finalWait: TimeInterval = 3
  /// About a minute of 24 kHz PCM16 waits for the session; past that the session has failed.
  static let maxQueuedBytes = 3 << 20

  struct Item {
    var range: (Int, Int)?
    var text = ""
    var done = false
    var emitted = false
    var order = 0
  }

  enum Event: Sendable {
    case ready
    case delta(String, itemID: String)
    case segment(t0: Int, t1: Int, text: String)
    case failed(String)
  }

  let key: String
  let model: String
  let language: String?
  let onEvent: @Sendable (Event) -> Void
  private var socket: (any RealtimeSocket)?
  private let makeSocket: @Sendable (URLRequest) -> any RealtimeSocket
  private let finalWait: TimeInterval
  private var nextOrder = 0
  private var ready = false
  private var closed = false
  private var queued: [[String: Any]] = []
  private var queuedBytes = 0
  private var pendingCommits: [(Int, Int)] = []
  private var items: [String: Item] = [:]
  private var finishing: CheckedContinuation<Void, Never>?
  private var watchdog: Task<Void, Never>?

  init(
    key: String, model: String?, language: String?, finalWait: TimeInterval = RealtimeSession.finalWait,
    makeSocket: @escaping @Sendable (URLRequest) -> any RealtimeSocket = { URLSessionRealtimeSocket($0) },
    onEvent: @escaping @Sendable (Event) -> Void
  ) {
    self.makeSocket = makeSocket
    self.finalWait = finalWait
    self.key = key
    self.model = model ?? Self.model
    self.language = language
    self.onEvent = onEvent
  }

  func connect() {
    var request = URLRequest(url: Self.endpoint)
    request.setValue("Bearer \(key)", forHTTPHeaderField: "Authorization")
    let socket = makeSocket(request)
    self.socket = socket
    arm(Self.connectTimeout, "OpenAI didn't answer in time")
    // Scrawl's session shape, known to work with gpt-live-transcribe. The Worker configured the
    // session when it minted the key; this restates it, and its answer is the ready signal.
    var transcription: [String: Any] = ["model": model, "delay": "medium"]
    if let language { transcription["languages"] = [language] }
    write([
      "type": "session.update",
      "session": [
        "type": "transcription",
        "audio": [
          "input": [
            "format": ["type": "audio/pcm", "rate": 24_000],
            "transcription": transcription,
            "turn_detection": NSNull(),
          ]
        ],
      ],
    ])
    Task { await self.receiveLoop(socket) }
  }

  func append(_ pcm: Data) {
    guard !closed, !pcm.isEmpty else { return }
    send(["type": "input_audio_buffer.append", "audio": pcm.base64EncodedString()], bytes: pcm.count)
  }

  func commit(t0: Int, t1: Int) {
    guard !closed else { return }
    // The API wants at least 100 ms in a commit.
    if t1 - t0 < 100 { append(Data(count: (100 - (t1 - t0)) * 48)) }
    pendingCommits.append((t0, t1))
    send(["type": "input_audio_buffer.commit"], bytes: 0)
  }

  func clear() {
    guard !closed else { return }
    send(["type": "input_audio_buffer.clear"], bytes: 0)
  }

  /// Waits for every committed turn's `completed` (at most `finalWait`), then closes. A turn
  /// still unfinished then is saved with its text so far, never dropped.
  func finish() async {
    guard !closed else { return }
    if isDrained { return close() }
    await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
      finishing = continuation
      arm(finalWait, nil)
    }
  }

  /// The final wait ran out: emit each unfinished turn's text so far, in order, then close.
  private func finishWithPartials() {
    var commits = pendingCommits
    for (id, item) in items.sorted(by: { $0.value.order < $1.value.order }) where !item.emitted {
      // A turn whose `committed` hasn't come back yet takes the next commit's range.
      let range = item.range ?? (commits.isEmpty ? nil : commits.removeFirst())
      let text = item.text.split(whereSeparator: \.isWhitespace).joined(separator: " ")
      if let range, !text.isEmpty { onEvent(.segment(t0: range.0, t1: range.1, text: text)) }
      items[id]?.emitted = true
    }
    close()
  }

  func cancel() { close() }

  // MARK: Private

  private func newItem() -> Item {
    nextOrder += 1
    return Item(order: nextOrder)
  }

  private var isDrained: Bool { pendingCommits.isEmpty && items.values.allSatisfy(\.done) }

  private func send(_ object: [String: Any], bytes: Int) {
    if ready {
      write(object)
      return
    }
    queued.append(object)
    queuedBytes += bytes
    if queuedBytes > Self.maxQueuedBytes { fail("OpenAI took too long to accept the session") }
  }

  private func write(_ object: [String: Any]) {
    guard let socket, let data = try? JSONSerialization.data(withJSONObject: object),
      let text = String(data: data, encoding: .utf8)
    else { return }
    socket.send(text) { [weak self] error in
      guard error != nil, let self else { return }
      Task { await self.fail("The connection to OpenAI dropped") }
    }
  }

  private func receiveLoop(_ socket: any RealtimeSocket) async {
    while !closed {
      do {
        handle(Data(try await socket.receive().utf8))
      } catch {
        fail(Self.describe(code: nil, status: socket.httpStatus))
        return
      }
    }
  }

  private func handle(_ data: Data) {
    guard let event = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
      let type = event["type"] as? String
    else { return }
    switch type {
    case "session.updated":
      guard !ready else { return }
      ready = true
      watchdog?.cancel()
      onEvent(.ready)
      for object in queued { write(object) }
      queued.removeAll()
      queuedBytes = 0
    case "input_audio_buffer.committed":
      guard let id = event["item_id"] as? String, !pendingCommits.isEmpty else { return }
      let range = pendingCommits.removeFirst()
      var item = items[id] ?? newItem()
      item.range = range
      items[id] = item
      emitIfReady(id)
    case "conversation.item.input_audio_transcription.delta":
      guard let id = event["item_id"] as? String, let delta = event["delta"] as? String else { return }
      var item = items[id] ?? newItem()
      guard !item.done else { return }
      item.text += delta
      items[id] = item
      onEvent(.delta(item.text, itemID: id))
    case "conversation.item.input_audio_transcription.completed":
      guard let id = event["item_id"] as? String else { return }
      var item = items[id] ?? newItem()
      item.text = event["transcript"] as? String ?? item.text
      item.done = true
      items[id] = item
      emitIfReady(id)
    case "conversation.item.input_audio_transcription.failed":
      // One turn failed; the session goes on.
      guard let id = event["item_id"] as? String else { return }
      var item = items[id] ?? newItem()
      item.done = true
      item.emitted = true
      items[id] = item
      checkDrained()
    case "error":
      let error = event["error"] as? [String: Any]
      let code = error?["code"] as? String
      if code == "input_audio_buffer_commit_empty" {
        if !pendingCommits.isEmpty { pendingCommits.removeFirst() }
        checkDrained()
        return
      }
      fail(Self.describe(code: code, status: nil))
    default:
      break
    }
  }

  private func emitIfReady(_ id: String) {
    guard var item = items[id], item.done, !item.emitted, let range = item.range else {
      checkDrained()
      return
    }
    item.emitted = true
    items[id] = item
    let text = item.text.split(whereSeparator: \.isWhitespace).joined(separator: " ")
    if !text.isEmpty { onEvent(.segment(t0: range.0, t1: range.1, text: text)) }
    // Done items are only kept to answer "drained?"; drop the text.
    items[id] = Item(range: range, text: "", done: true, emitted: true)
    checkDrained()
  }

  private func checkDrained() {
    guard finishing != nil, isDrained else { return }
    close()
  }

  private func fail(_ reason: String) {
    guard !closed else { return }
    let wasFinishing = finishing != nil
    close()
    if !wasFinishing { onEvent(.failed(reason)) }
  }

  private func close() {
    guard !closed else { return }
    closed = true
    watchdog?.cancel()
    socket?.close()
    queued.removeAll()
    finishing?.resume()
    finishing = nil
  }

  private func arm(_ seconds: TimeInterval, _ reason: String?) {
    watchdog?.cancel()
    watchdog = Task { [weak self] in
      try? await Task.sleep(for: .seconds(seconds))
      guard !Task.isCancelled, let self else { return }
      if let reason { await self.fail(reason) } else { await self.finishWithPartials() }
    }
  }

  /// What a provider error means, without quoting it (it can echo the key).
  static func describe(code: String?, status: Int?) -> String {
    if status == 401 || code == "invalid_api_key" || code == "invalid_authentication" {
      return "OpenAI didn't accept the transcription key"
    }
    if status == 403 || code == "model_not_found" || code == "permission_denied" {
      return "The transcription key can't use \(model)"
    }
    if status == 429 || code == "rate_limit_exceeded" || code == "insufficient_quota" {
      return "OpenAI's usage limit was reached"
    }
    return "OpenAI transcription stopped"
  }
}

/// What a speaker channel reports. Called from the channel's actor; hop to your own.
public struct ChannelCallbacks: Sendable {
  /// A finished turn the recorder still has to post: speaker, startedMs, endedMs, text.
  public var segment: @Sendable (Speaker, Int, Int, String) -> Void
  /// A segment the Worker already stored (the fallback's chunks).
  public var stored: @Sendable (Segment) -> Void
  /// The text so far of a turn still being transcribed: speaker, text, item id.
  public var delta: @Sendable (Speaker, String, String) -> Void
  /// A sentence when transcription is in trouble, nil when it's fine again.
  public var problem: @Sendable (Speaker, String?) -> Void
  /// Audio was dropped because it piled up: fallback uploads couldn't keep up, or a reconnect
  /// outlasted the outage buffer.
  public var backlog: @Sendable (Speaker, String) -> Void
  /// The connection is back (or the channel is finishing): the audio captured while it was down,
  /// PCM16 24 kHz mono, starting at this meeting time (ms), to transcribe another way.
  public var catchUp: @Sendable (Speaker, Data, Int) -> Void

  public init(
    segment: @escaping @Sendable (Speaker, Int, Int, String) -> Void,
    stored: @escaping @Sendable (Segment) -> Void,
    delta: @escaping @Sendable (Speaker, String, String) -> Void,
    problem: @escaping @Sendable (Speaker, String?) -> Void,
    backlog: @escaping @Sendable (Speaker, String) -> Void = { _, _ in },
    catchUp: @escaping @Sendable (Speaker, Data, Int) -> Void = { _, _, _ in }
  ) {
    self.segment = segment
    self.stored = stored
    self.delta = delta
    self.problem = problem
    self.backlog = backlog
    self.catchUp = catchUp
  }
}

/// One speaker's way to text for a whole meeting.
public protocol SpeakerChannel: Actor {
  func start() async throws
  /// PCM16 24 kHz mono, in capture order.
  func feed(_ pcm: Data) async
  /// Sends the last turn and waits for its text.
  func finish() async
  func cancel() async
}

/// One speaker's transcription for a whole meeting: audio in, turns detected on the Mac, text
/// out. Renews the ephemeral key before it expires (2 h at most) and reconnects after a drop.
public actor TranscriptionChannel: SpeakerChannel {
  static let renewLead: TimeInterval = 90
  static let retryDelays: [Double] = [1, 3, 10, 30]

  let speaker: Speaker
  let fetchToken: @Sendable () async throws -> TranscriptionToken
  let callbacks: ChannelCallbacks
  let finalWait: TimeInterval
  let makeSocket: @Sendable (URLRequest) -> any RealtimeSocket
  let language: String?

  private var detector = TurnDetector()
  private var session: RealtimeSession?
  private var generation = 0
  private var stopped = false
  private var failures = 0
  private var renewTask: Task<Void, Never>?
  private var retiring: [Task<Void, Never>] = []
  /// Audio captured while the session is down (after it first opened), replayed when it's back.
  private var outage = OutageBuffer()
  private var opened = false

  public init(
    speaker: Speaker, language: String?, fetchToken: @escaping @Sendable () async throws -> TranscriptionToken,
    callbacks: ChannelCallbacks, finalWait: TimeInterval = 3,
    makeSocket: @escaping @Sendable (URLRequest) -> any RealtimeSocket = { URLSessionRealtimeSocket($0) }
  ) {
    self.finalWait = finalWait
    self.makeSocket = makeSocket
    self.speaker = speaker
    self.language = language
    self.fetchToken = fetchToken
    self.callbacks = callbacks
  }

  public func start() async throws {
    let token = try await fetchToken()
    open(with: token)
  }

  /// PCM16 24 kHz mono, in capture order.
  public func feed(_ pcm: Data) async {
    guard !stopped else { return }
    let capturedAt = detector.elapsedMs
    let actions = detector.feed(PCM16.decode(pcm))
    guard let session else {
      // Reconnecting: keep the audio (the clock goes on) to transcribe once we're back.
      if opened, outage.append(pcm, atMs: capturedAt) {
        callbacks.backlog(speaker, "The connection was down for over 5 minutes: the oldest audio from the outage was dropped")
      }
      return
    }
    await session.append(pcm)
    for action in actions {
      switch action {
      case .commit(let t0, let t1): await session.commit(t0: t0, t1: t1)
      case .skipSilence: await session.clear()
      }
    }
  }

  /// Commits the last turn and waits for its text.
  public func finish() async {
    guard !stopped else { return }
    stopped = true
    renewTask?.cancel()
    if let session, case .commit(let t0, let t1)? = detector.flush() {
      await session.commit(t0: t0, t1: t1)
    }
    let last = session
    session = nil
    await last?.finish()
    for task in retiring { await task.value }
    // Stopped while still reconnecting: what was kept goes to the fallback now.
    handOverOutage()
  }

  public func cancel() async {
    stopped = true
    renewTask?.cancel()
    await session?.cancel()
    session = nil
  }

  // MARK: Private

  private func handOverOutage() {
    guard let kept = outage.take() else { return }
    callbacks.catchUp(speaker, kept.pcm, kept.startMs)
  }

  private func open(with token: TranscriptionToken) {
    opened = true
    generation += 1
    let current = generation
    let speaker = self.speaker
    let session = RealtimeSession(
      key: token.value, model: token.model, language: language, finalWait: finalWait, makeSocket: makeSocket
    ) { [weak self] event in
      Task { await self?.handle(event, generation: current, speaker: speaker) }
    }
    self.session = session
    Task { await session.connect() }
    renewTask?.cancel()
    let wait = max(30, token.expiresAt.timeIntervalSinceNow - Self.renewLead)
    renewTask = Task { [weak self] in
      try? await Task.sleep(for: .seconds(wait))
      guard !Task.isCancelled else { return }
      await self?.renew()
    }
  }

  private func handle(_ event: RealtimeSession.Event, generation: Int, speaker: Speaker) async {
    switch event {
    case .ready:
      guard generation == self.generation else { return }
      failures = 0
      // The outage's audio first, so the state goes reconnecting → catching up → live.
      handOverOutage()
      callbacks.problem(speaker, nil)
    case .delta(let text, let itemID):
      callbacks.delta(speaker, text, itemID)
    case .segment(let t0, let t1, let text):
      callbacks.segment(speaker, t0, t1, text)
    case .failed(let reason):
      guard generation == self.generation, !stopped else { return }
      session = nil
      callbacks.problem(speaker, reason)
      await reconnect()
    }
  }

  /// Key about to expire: start a new session and let the old one finish its last turns.
  private func renew() async {
    guard !stopped else { return }
    do {
      let token = try await fetchToken()
      guard !stopped else { return }
      if let old = session, case .commit(let t0, let t1)? = detector.flush() {
        await old.commit(t0: t0, t1: t1)
      }
      if let old = session { retiring.append(Task { await old.finish() }) }
      open(with: token)
    } catch {
      // The old key still has a little life; try again shortly.
      renewTask = Task { [weak self] in
        try? await Task.sleep(for: .seconds(15))
        await self?.renew()
      }
    }
  }

  private func reconnect() async {
    while !stopped {
      let delay = Self.retryDelays[min(failures, Self.retryDelays.count - 1)]
      failures += 1
      try? await Task.sleep(for: .seconds(delay))
      guard !stopped else { return }
      do {
        let token = try await fetchToken()
        guard !stopped else { return }
        open(with: token)
        return
      } catch {
        callbacks.problem(speaker, "Can't reach transcription: \(error.localizedDescription)")
      }
    }
  }
}
