import Foundation
import Testing

@testable import HelperCore

@Suite struct AccessLoginTests {
  func api(_ handler: @escaping StubTransport.Handler) -> APIClient {
    APIClient(auth: AccessTokenAuthProvider(appURL: URL(string: "https://talk.example.com")!, token: "epat_1"), transport: StubTransport(handler))
  }

  @Test func redirectToAccessIsReported() async {
    let client = api { _ in
      (302, "", ["Location": "https://team.cloudflareaccess.com/cdn-cgi/access/login/talk.example.com?redirect_url=%2F", "Content-Type": "text/html"])
    }
    await #expect(throws: APIError.accessLogin) { try await client.me() }
    #expect(APIError.accessLogin.localizedDescription.hasPrefix("Gateway requires Sign in with Every App"))
  }

  @Test func accessPageOn401IsNotASignOut() async {
    // Access can answer 401/403 with its page; that mustn't sign the person out.
    let client = api { _ in
      (401, #"<html><script src="https://team.cloudflareaccess.com/cdn-cgi/access/x.js"></script></html>"#, ["Content-Type": "text/html"])
    }
    await #expect(throws: APIError.accessLogin) { try await client.upcoming() }
  }

  @Test func followedRedirectIsReported() {
    let response = HTTPURLResponse(
      url: URL(string: "https://team.cloudflareaccess.com/cdn-cgi/access/login/x")!, statusCode: 200, httpVersion: nil,
      headerFields: ["Content-Type": "text/html"])!
    #expect(APIClient.isAccessLogin(Data(), response))
  }

  @Test func ordinaryResponsesAreNot() {
    let ok = HTTPURLResponse(url: URL(string: "https://talk.example.com/api/v1/me")!, statusCode: 200, httpVersion: nil, headerFields: ["Content-Type": "application/json"])!
    #expect(!APIClient.isAccessLogin(Data(#"{"note":"cloudflareaccess.com"}"#.utf8), ok))
    let moved = HTTPURLResponse(url: URL(string: "https://talk.example.com/x")!, statusCode: 301, httpVersion: nil, headerFields: ["Location": "https://talk.example.com/y"])!
    #expect(!APIClient.isAccessLogin(Data(), moved))
    #expect(!APIClient.isAccessLogin(Data(), HTTPURLResponse(url: URL(string: "https://evilcloudflareaccess.com/")!, statusCode: 200, httpVersion: nil, headerFields: nil)!))
  }

  @Test func realtimeUnavailable() {
    #expect(APIError.server(status: 503, code: "ai_route_not_allowed", message: nil).isRealtimeUnavailable)
    #expect(APIError.server(status: 400, code: "ai_route_not_allowed", message: nil).isRealtimeUnavailable)
    #expect(APIError.server(status: 502, code: "openai_error", message: nil).isRealtimeUnavailable)
    #expect(!APIError.server(status: 503, code: "ai_provider_not_configured", message: nil).isRealtimeUnavailable)
    #expect(!APIError.server(status: 404, code: "not_found", message: nil).isRealtimeUnavailable)
    #expect(!APIError.signedOut.isRealtimeUnavailable)
    #expect(!APIError.accessLogin.isRealtimeUnavailable)
  }
}

@Suite struct ChunkResponseTests {
  @Test func unreadableSegmentIsNotAnError() async throws {
    let stub = StubTransport { _ in (201, #"{"segment":{"seq":1,"startedMs":0,"endedMs":5,"speaker":null,"text":"hi"}}"#, [:]) }
    let api = APIClient(auth: AccessTokenAuthProvider(appURL: URL(string: "https://talk.example.com")!, token: "t"), transport: stub)
    let segment = try await api.appendAudioChunk(meetingID: "m", wav: Data(), seq: 1, startedMs: 0, endedMs: 5, speaker: .me, language: nil)
    #expect(segment == nil)
  }

  @Test func providerNotConfiguredIsNotAFallback() async {
    let stub = StubTransport { _ in (503, #"{"error":"ai_provider_not_configured","message":"Set up OpenAI"}"#, [:]) }
    let api = APIClient(auth: AccessTokenAuthProvider(appURL: URL(string: "https://talk.example.com")!, token: "t"), transport: stub)
    do {
      _ = try await api.transcriptionToken(meetingID: "m", source: "mic", language: nil)
      Issue.record("expected 503")
    } catch let error as APIError {
      #expect(!error.isRealtimeUnavailable)
      #expect(error.localizedDescription == "Set up OpenAI")
    } catch {
      Issue.record("unexpected \(error)")
    }
  }
}

@Suite struct FinishTests {
  @Test func finishingTwiceIsDone() async throws {
    let stub = StubTransport { _ in (404, #"{"error":"not_found"}"#, [:]) }
    let api = APIClient(auth: AccessTokenAuthProvider(appURL: URL(string: "https://talk.example.com")!, token: "t"), transport: stub)
    try await api.finish(meetingID: "m1")
  }
}

@Suite struct ChunkCutterTests {
  func tone(ms: Int) -> Data { PCM16.encode((0..<(24 * ms)).map { Float(0.25 * sin(Double($0) * 0.1)) }) }
  func silence(ms: Int) -> Data { Data(count: 48 * ms) }

  func feed(_ cutter: inout ChunkCutter, _ data: Data, step: Int = 4_800) -> [ChunkCutter.Chunk] {
    var out: [ChunkCutter.Chunk] = []
    var i = 0
    while i < data.count {
      let n = min(step, data.count - i)
      out += cutter.feed(data.subdata(in: i..<i + n))
      i += n
    }
    return out
  }

  @Test func turnsGatherIntoAChunkCutAtATurnEnd() {
    var c = ChunkCutter()
    var audio = Data()
    for _ in 0..<5 { audio += tone(ms: 4_000) + silence(ms: 1_000) }  // 25 s, turns every 5 s
    let chunks = feed(&c, audio)
    #expect(chunks.count == 1)
    // Turns end at 4.6, 9.6, 14.6, 19.6 and 24.6 s; the first at or past 20 s closes the chunk.
    #expect(chunks[0].startedMs == 0)
    #expect(chunks[0].endedMs == 24_600)
    #expect(chunks[0].pcm.count == 24_600 * 48)
    // The 400 ms left over is quiet: nothing to send.
    #expect(c.finish() == nil)
  }

  @Test func neverLongerThanThirtySeconds() {
    var c = ChunkCutter()
    let chunks = feed(&c, tone(ms: 65_000))
    #expect(chunks.allSatisfy { $0.endedMs - $0.startedMs <= ChunkCutter.maxMs })
    #expect(chunks.map(\.startedMs) == [0, 30_000])
    #expect(c.finish()?.endedMs == 65_000)
  }

  @Test func silenceIsDropped() {
    var c = ChunkCutter()
    #expect(feed(&c, silence(ms: 70_000)).isEmpty)
    #expect(c.finish() == nil)
  }

  @Test func speechBeforeALongSilenceIsSent() {
    var c = ChunkCutter()
    let chunks = feed(&c, tone(ms: 3_000) + silence(ms: 40_000) + tone(ms: 2_000))
    #expect(chunks.count == 1)
    #expect(chunks[0].startedMs == 0)
    #expect(chunks[0].endedMs == 3_600)
    let last = c.finish()!
    #expect(last.endedMs == 45_000)
    #expect(last.endedMs - last.startedMs <= ChunkCutter.maxMs)
  }

  @Test func chunksTileTheStreamWithoutOverlap() {
    var c = ChunkCutter()
    var audio = Data()
    for i in 0..<12 { audio += tone(ms: 2_000 + i * 700) + silence(ms: 800) }
    var chunks = feed(&c, audio, step: 2_222)
    if let last = c.finish() { chunks.append(last) }
    for (a, b) in zip(chunks, chunks.dropFirst()) { #expect(a.endedMs <= b.startedMs) }
    for chunk in chunks {
      #expect(chunk.endedMs - chunk.startedMs <= ChunkCutter.maxMs)
      #expect(chunk.pcm.count <= (chunk.endedMs - chunk.startedMs) * 48)
    }
  }
}
