import Foundation
import Testing
import HelperCore
@testable import HelperRecording

/// On stop the turn in progress is committed, its `completed` awaited (≤ 3 s), and, if that
/// doesn't come, its text so far is saved. Fallback: the last partial chunk is cut and sent.
final class FakeSocket: RealtimeSocket, @unchecked Sendable {
  private let lock = NSLock()
  private var _sent: [String] = []
  private let stream: AsyncThrowingStream<String, Error>
  private let input: AsyncThrowingStream<String, Error>.Continuation
  nonisolated(unsafe) private var iterator: AsyncThrowingStream<String, Error>.AsyncIterator

  init() {
    (stream, input) = AsyncThrowingStream<String, Error>.makeStream()
    iterator = stream.makeAsyncIterator()
  }

  /// The `type` of each message sent, in order.
  var sentTypes: [String] {
    lock.withLock { _sent }.compactMap {
      (try? JSONSerialization.jsonObject(with: Data($0.utf8)) as? [String: Any])?["type"] as? String
    }
  }

  func send(_ text: String, completion: @escaping @Sendable (Error?) -> Void) {
    lock.withLock { _sent.append(text) }
    completion(nil)
  }

  func receive() async throws -> String {
    guard let next = try await iterator.next() else { throw URLError(.networkConnectionLost) }
    return next
  }

  func push(_ json: String) { input.yield(json) }
  func close() { input.finish() }
  var httpStatus: Int? { nil }
}

@Suite struct StopFinalTurnTests {
  final class Heard: @unchecked Sendable {
    let lock = NSLock()
    var segments: [(Int, Int, String)] = []
    var ready = false
  }

  static func speech(_ ms: Int) -> Data { PCM16.encode((0..<(ms * 24)).map { sin(Float($0) / 10) * 0.2 }) }

  func channel(_ socket: FakeSocket, _ heard: Heard, finalWait: TimeInterval = 3) -> TranscriptionChannel {
    TranscriptionChannel(
      speaker: .me, language: "en",
      fetchToken: { TranscriptionToken(value: "ek", expiresAt: Date().addingTimeInterval(3_600)) },
      callbacks: ChannelCallbacks(
        segment: { _, t0, t1, text in heard.lock.withLock { heard.segments.append((t0, t1, text)) } },
        stored: { _ in }, delta: { _, _, _ in },
        problem: { _, problem in if problem == nil { heard.lock.withLock { heard.ready = true } } }),
      finalWait: finalWait, makeSocket: { _ in socket })
  }

  /// Opens the session and speaks 1.5 s with no pause: a turn in progress, not yet committed.
  func midTurn(_ socket: FakeSocket, _ heard: Heard, _ ch: TranscriptionChannel) async throws {
    try await ch.start()
    socket.push(#"{"type":"session.updated"}"#)
    #expect(await Output().waitFor { heard.lock.withLock { heard.ready } })
    await ch.feed(Self.speech(1_500))
    #expect(!socket.sentTypes.contains("input_audio_buffer.commit"))
  }

  @Test func stopCommitsTheOpenTurnAndSavesItsCompletedText() async throws {
    let socket = FakeSocket(), heard = Heard()
    let ch = channel(socket, heard)
    try await midTurn(socket, heard, ch)
    let finish = Task { await ch.finish() }
    #expect(await Output().waitFor { socket.sentTypes.contains("input_audio_buffer.commit") })
    socket.push(#"{"type":"input_audio_buffer.committed","item_id":"i1"}"#)
    socket.push(#"{"type":"conversation.item.input_audio_transcription.delta","item_id":"i1","delta":"and that's"}"#)
    socket.push(#"{"type":"conversation.item.input_audio_transcription.completed","item_id":"i1","transcript":"and that's the plan"}"#)
    await finish.value
    let segments = heard.lock.withLock { heard.segments }
    #expect(segments.count == 1)
    #expect(segments.first?.2 == "and that's the plan")
    #expect(segments.first.map { $0.1 - $0.0 } ?? 0 >= 1_000)  // the whole turn's range
  }

  @Test func noCompletedInTimeSavesTheTextSoFar() async throws {
    let socket = FakeSocket(), heard = Heard()
    let ch = channel(socket, heard, finalWait: 0.05)
    try await midTurn(socket, heard, ch)
    let finish = Task { await ch.finish() }
    #expect(await Output().waitFor { socket.sentTypes.contains("input_audio_buffer.commit") })
    socket.push(#"{"type":"input_audio_buffer.committed","item_id":"i1"}"#)
    socket.push(#"{"type":"conversation.item.input_audio_transcription.delta","item_id":"i1","delta":"so the last  thing"}"#)
    await finish.value  // returns after the final wait, not 25 s
    #expect(heard.lock.withLock { heard.segments.map(\.2) } == ["so the last thing"])
  }

  @Test func evenWithoutTheCommitAcknowledgement() async throws {
    let socket = FakeSocket(), heard = Heard()
    let ch = channel(socket, heard, finalWait: 0.05)
    try await midTurn(socket, heard, ch)
    let finish = Task { await ch.finish() }
    #expect(await Output().waitFor { socket.sentTypes.contains("input_audio_buffer.commit") })
    // Deltas arrive, but `committed` never does: the turn still gets the commit's range.
    socket.push(#"{"type":"conversation.item.input_audio_transcription.delta","item_id":"i1","delta":"wait one more"}"#)
    await finish.value
    let segments = heard.lock.withLock { heard.segments }
    #expect(segments.map(\.2) == ["wait one more"])
    #expect(segments.first?.0 == 0)
  }

  @Test func nothingInProgressMeansNoCommitAndNoWait() async throws {
    let socket = FakeSocket(), heard = Heard()
    let ch = channel(socket, heard, finalWait: 30)  // would hang the test if it waited
    try await ch.start()
    socket.push(#"{"type":"session.updated"}"#)
    #expect(await Output().waitFor { heard.lock.withLock { heard.ready } })
    await ch.feed(Data(count: 48 * 1_000))  // a second of silence
    await ch.finish()
    #expect(!socket.sentTypes.contains("input_audio_buffer.commit"))
    #expect(heard.lock.withLock { heard.segments.isEmpty })
  }

  @Test func fallbackSendsTheLastPartialChunk() async {
    final class Uploads: @unchecked Sendable {
      let lock = NSLock()
      var ranges: [(Int, Int)] = []
    }
    let uploads = Uploads()
    let ch = ChunkChannel(
      speaker: .me, language: "en", seqFor: { $0 },
      upload: { _, _, t0, t1 in
        uploads.lock.withLock { uploads.ranges.append((t0, t1)) }
        return nil
      },
      callbacks: ChannelCallbacks(segment: { _, _, _, _ in }, stored: { _ in }, delta: { _, _, _ in }, problem: { _, _ in }))
    await ch.feed(Self.speech(5_000))  // 5 s: under the 20 s a chunk waits for
    #expect(uploads.lock.withLock { uploads.ranges.isEmpty })
    await ch.finish()
    let ranges = uploads.lock.withLock { uploads.ranges }
    #expect(ranges.count == 1)
    #expect(ranges.first.map { $0.1 - $0.0 } ?? 0 >= 4_900)
  }
}
