import Foundation
import Testing
@testable import HelperCore

@Suite struct OutageBufferTests {
  func ms(_ n: Int) -> Data { Data(repeating: 1, count: n * OutageBuffer.bytesPerMs) }

  @Test func keepsAudioWithItsStartTime() throws {
    var b = OutageBuffer()
    #expect(b.isEmpty)
    #expect(b.append(ms(100), atMs: 5_000) == false)
    b.append(ms(100), atMs: 5_100)
    let taken = b.take()
    let kept = try #require(taken)
    #expect(kept.startMs == 5_000)
    #expect(kept.pcm.count == ms(200).count)
    #expect(kept.droppedMs == 0)
    let again = b.take()
    #expect(b.isEmpty && again == nil)
  }

  @Test func overflowDropsTheOldestAndWarnsOnce() throws {
    var b = OutageBuffer(maxBytes: ms(300).count)
    b.append(ms(100), atMs: 0)
    b.append(ms(100), atMs: 100)
    b.append(ms(100), atMs: 200)
    #expect(b.append(ms(100), atMs: 300) == true)  // first drop: warn
    #expect(b.append(ms(100), atMs: 400) == false)  // still dropping: no second warning
    #expect(b.count <= ms(300).count)
    let taken = b.take()
    let kept = try #require(taken)
    #expect(kept.startMs == 200)  // the two oldest 100 ms went
    #expect(kept.droppedMs == 200)
    // After a take, a new outage warns again.
    b.append(ms(300), atMs: 10_000)
    #expect(b.append(ms(100), atMs: 10_300) == true)
  }

  @Test func fiveMinutesIsTheDefault() {
    #expect(OutageBuffer.defaultMaxBytes == 300 * 24_000 * 2)
  }
}

@Suite struct TranscriptSeqTests {
  @Test func ordersByStartAndNeverCollides() {
    let me = TranscriptSeq.make(startedMs: 1_000, speaker: .me)
    let them = TranscriptSeq.make(startedMs: 1_000, speaker: .them)
    let replayed = TranscriptSeq.make(startedMs: 1_000, speaker: .me, replay: true)
    #expect(Set([me, them, replayed]).count == 3)
    #expect(TranscriptSeq.make(startedMs: 999, speaker: .them, replay: true) < me)
    #expect(TranscriptSeq.make(startedMs: 1_001, speaker: .me) > them)
    #expect(TranscriptSeq.make(startedMs: -5, speaker: .me) == 0)
    #expect(TranscriptSeq.make(startedMs: 4 * 3_600_000, speaker: .them, replay: true) < Int(Int32.max))
  }
}
