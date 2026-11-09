import Foundation
import Testing
@testable import HelperCore

@Suite struct EchoDedupeTests {
  func me(_ text: String, _ t0: Int = 1000, _ t1: Int = 4000) -> Segment {
    Segment(seq: 0, startedMs: t0, endedMs: t1, speaker: .me, text: text)
  }

  func them(_ text: String, _ t0: Int = 900, _ t1: Int = 3900, seq: Int = 0) -> Segment {
    Segment(seq: seq, startedMs: t0, endedMs: t1, speaker: .them, text: text)
  }

  @Test func exactEchoIsDropped() {
    let said = "We should ship the new onboarding flow on Thursday"
    #expect(EchoDedupe.decide(me: me(said), them: [them(said)]) == .drop)
  }

  @Test func casingPunctuationAndSmallMisheardsStillMatch() {
    // The mic's copy is quieter and noisier: different casing, punctuation, a word lost and one misheard.
    let them = them("So, the budget for Q3 is approved — let's hire two engineers.")
    #expect(EchoDedupe.decide(me: me("so the budget for q3 is approved lets hire to engineers"), them: [them]) == .drop)
  }

  @Test func anEchoedFragmentOfALongTurnIsDropped() {
    let long = "Thanks everyone for joining today I want to walk through the roadmap and then talk about hiring for the platform team"
    #expect(EchoDedupe.decide(me: me("walk through the roadmap and then talk", 2000, 3500), them: [them(long, 0, 9000)]) == .drop)
  }

  @Test func echoPlusRealWordsKeepsTheRealWords() {
    let them = them("the launch is moving to next Tuesday")
    let decision = EchoDedupe.decide(me: me("the launch is moving to next Tuesday wait does that work for marketing", 1000, 6000), them: [them])
    #expect(decision == .trim("wait does that work for marketing"))
  }

  @Test func echoWithOnlyAWordOrTwoExtraIsDropped() {
    let them = them("the launch is moving to next Tuesday")
    #expect(EchoDedupe.decide(me: me("the launch is moving to next Tuesday okay"), them: [them]) == .drop)
  }

  @Test func genuineCrosstalkIsKept() {
    let them = them("I think the numbers for last month look pretty good overall")
    #expect(EchoDedupe.decide(me: me("sorry can you share your screen again"), them: [them]) == .keep)
    // Talking over each other about the same thing shares a few words, not most.
    #expect(EchoDedupe.decide(me: me("the numbers from finance were different though"), them: [them]) == .keep)
  }

  @Test func shortBackchannels() {
    let long = them("yeah so the plan is to migrate the database next week and then switch traffic over", 0, 8000)
    // "yeah" from me during their long turn (which happens to contain "yeah") is real.
    #expect(EchoDedupe.decide(me: me("Yeah.", 3000, 3400), them: [long]) == .keep)
    #expect(EchoDedupe.decide(me: me("mm-hmm", 3000, 3400), them: [long]) == .keep)
    // Their own short "yeah", heard by the mic, is an echo.
    #expect(EchoDedupe.decide(me: me("yeah", 3000, 3400), them: [them("Yeah!", 2950, 3350)]) == .drop)
    #expect(EchoDedupe.decide(me: me("right", 3000, 3400), them: [them("Yeah!", 2950, 3350)]) == .keep)
  }

  @Test func timeTolerance() {
    let said = "the contract renewal is due at the end of the month"
    #expect(EchoDedupe.decide(me: me(said, 5400, 8000), them: [them(said, 1000, 4000)]) == .drop)  // 1.4 s apart
    #expect(EchoDedupe.decide(me: me(said, 5600, 8000), them: [them(said, 1000, 4000)]) == .keep)  // 1.6 s apart
    #expect(EchoDedupe.decide(me: me(said, 1000, 4000), them: []) == .keep)
  }

  @Test func echoAcrossTwoOfTheirSegments() {
    let parts = [them("we need the design review done", 1000, 2500, seq: 1), them("before the board meeting on Friday", 2600, 4000, seq: 2)]
    #expect(EchoDedupe.decide(me: me("we need the design review done before the board meeting on Friday", 1100, 4100), them: parts) == .drop)
  }

  @Test func otherLanguages() {
    // Diacritics and casing folded.
    #expect(EchoDedupe.decide(me: me("das buro ist am freitag geschlossen oder"), them: [them("Das Büro ist am Freitag geschlossen, oder?")]) == .drop)
    #expect(EchoDedupe.decide(me: me("¿Podemos mover la reunión al jueves?"), them: [them("podemos mover la reunion al jueves")]) == .drop)
    // Same meaning, different language: not an echo.
    #expect(EchoDedupe.decide(me: me("podemos mover la reunión al jueves"), them: [them("can we move the meeting to Thursday")]) == .keep)
    // Scripts without spaces compare by character.
    #expect(EchoDedupe.decide(me: me("今日は会議があります。"), them: [them("今日は会議があります")]) == .drop)
    #expect(EchoDedupe.decide(me: me("明日は休みです"), them: [them("今日は会議があります")]) == .keep)
  }

  @Test func onlyMeSegmentsAreJudged() {
    let said = "the same words"
    #expect(EchoDedupe.decide(me: them(said), them: [them(said)]) == .keep)
  }

  @Test func tokens() {
    #expect(EchoDedupe.tokens("Don't stop — Café, OK?") == ["dont", "stop", "cafe", "ok"])
    #expect(EchoDedupe.tokens("会議 at 3pm") == ["会", "議", "at", "3pm"])
    #expect(EchoDedupe.tokens("...") == [])
  }
}

@Suite struct EchoFilterTests {
  func p(_ speaker: Speaker, _ text: String, _ t0: Int = 0, _ t1: Int = 3000) -> EchoFilter.Pending {
    EchoFilter.Pending(speaker: speaker, startedMs: t0, endedMs: t1, text: text)
  }

  let said = "let's review the quarterly numbers before the call"

  @Test func theirSegmentsPassStraightThrough() {
    var f = EchoFilter(holdMs: 4000)
    #expect(f.add(p(.them, said), nowMs: 0) == [p(.them, said)])
  }

  @Test func myEchoWaitsForTheirTranscriptAndIsDropped() {
    var f = EchoFilter(holdMs: 4000)
    // The echo's transcript can arrive first.
    #expect(f.add(p(.me, said, 100, 3100), nowMs: 3200) == [])
    #expect(f.heldCount == 1)
    #expect(f.add(p(.them, said), nowMs: 4500) == [p(.them, said)])
    #expect(f.release(nowMs: 7199) == [])
    #expect(f.release(nowMs: 7200) == [])
    #expect(f.heldCount == 0)
    #expect(f.dropped == 1)
  }

  @Test func realSpeechIsReleasedAfterTheHold() {
    var f = EchoFilter(holdMs: 4000)
    let mine = p(.me, "I can take that one", 5000, 6000)
    #expect(f.add(p(.them, said), nowMs: 3100) == [p(.them, said)])
    #expect(f.add(mine, nowMs: 6100) == [])
    #expect(f.release(nowMs: 10_099) == [])
    #expect(f.release(nowMs: 10_100) == [mine])
  }

  @Test func heldInOrderAndTrimmed() {
    var f = EchoFilter(holdMs: 1000)
    _ = f.add(p(.them, "the launch is moving to next Tuesday", 0, 3000), nowMs: 3000)
    let a = p(.me, "the launch is moving to next Tuesday does that work for marketing", 0, 5000)
    let b = p(.me, "also I'm out Friday", 6000, 7000)
    #expect(f.add(a, nowMs: 5100) == [])
    #expect(f.add(b, nowMs: 7100) == [EchoFilter.Pending(speaker: .me, startedMs: 0, endedMs: 5000, text: "does that work for marketing")])
    #expect(f.trimmed == 1)
    #expect(f.releaseAll() == [b])
  }

  @Test func releaseAllJudgesWithEverythingKnown() {
    var f = EchoFilter(holdMs: 60_000)
    _ = f.add(p(.me, said, 100, 3100), nowMs: 3200)
    _ = f.add(p(.them, said), nowMs: 3300)
    #expect(f.releaseAll() == [])
    #expect(f.dropped == 1)
  }

  @Test func zeroHoldJudgesAtOnce() {
    var f = EchoFilter(holdMs: 0)
    _ = f.add(p(.them, said), nowMs: 0)
    #expect(f.add(p(.me, said), nowMs: 0) == [])
    #expect(f.add(p(.me, "something else entirely here"), nowMs: 0) == [p(.me, "something else entirely here")])
  }
}
