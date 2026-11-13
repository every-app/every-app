import Foundation
import Testing

@testable import HelperCore

/// Nothing listening.
struct DeadTransport: HTTPTransport {
  func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) { throw URLError(.cannotConnectToHost) }
}

@Suite struct TranscriptionServerTests {
  static func server(_ base: String = "http://localhost:50060/v1", key: String? = nil) -> TranscriptionServer {
    TranscriptionServer(baseURL: TranscriptionServer.typedBaseURL(base)!, model: "large-v3", apiKey: key)
  }

  @Test func addressesAPersonTypes() {
    let typed = { (s: String) in TranscriptionServer.typedBaseURL(s)?.absoluteString }
    #expect(typed("http://localhost:50060/v1") == "http://localhost:50060/v1")
    #expect(typed("  localhost:8000/v1 ") == "http://localhost:8000/v1")
    #expect(typed("127.0.0.1:8080") == "http://127.0.0.1:8080")
    #expect(typed("http://192.168.1.20:8000/v1") == "http://192.168.1.20:8000/v1")
    #expect(typed("http://studio.local:9000/v1") == "http://studio.local:9000/v1")
    #expect(typed("http://100.101.102.103:8000/v1") == "http://100.101.102.103:8000/v1")
    #expect(typed("whisper.example.com/v1") == "https://whisper.example.com/v1")
    #expect(typed("https://whisper.example.com/v1?x=1#y") == "https://whisper.example.com/v1")
    // Plain http across the internet, other schemes, credentials in the URL, nothing at all.
    #expect(typed("http://whisper.example.com/v1") == nil)
    #expect(typed("http://8.8.8.8/v1") == nil)
    #expect(typed("http://nas:8000/v1") == nil)  // a bare name can resolve anywhere: https only
    #expect(typed("nas:8000/v1") == "https://nas:8000/v1")
    #expect(typed("http://172.32.0.1/v1") == nil)
    #expect(typed("ftp://localhost/v1") == nil)
    #expect(typed("https://user:pw@whisper.example.com/v1") == nil)
    #expect(typed("   ") == nil)
  }

  @Test func theEndpointIsTheBasePlusOpenAIsPath() {
    #expect(Self.server("http://localhost:50060/v1").endpoint.absoluteString == "http://localhost:50060/v1/audio/transcriptions")
    #expect(Self.server("http://localhost:50060/v1/").endpoint.absoluteString == "http://localhost:50060/v1/audio/transcriptions")
    #expect(Self.server("http://localhost:8080").endpoint.absoluteString == "http://localhost:8080/audio/transcriptions")
    #expect(
      Self.server("http://localhost:8080/v1/audio/transcriptions").endpoint.absoluteString == "http://localhost:8080/v1/audio/transcriptions")
    #expect(Self.server().hostLabel == "localhost:50060")
  }

  @Test func theRequestHasOpenAIsShapeAndNoKeyUnlessSet() async throws {
    let stub = StubTransport { _ in (200, #"{"text":" Hello there. "}"#, [:]) }
    let text = try await TranscriptionServerClient(server: Self.server(), transport: stub).transcribe(wav: Data("RIFFwav".utf8), language: "en")
    #expect(text == "Hello there.")
    let request = try #require(stub.requests.first)
    #expect(request.url?.absoluteString == "http://localhost:50060/v1/audio/transcriptions")
    #expect(request.httpMethod == "POST")
    #expect(request.value(forHTTPHeaderField: "Authorization") == nil)
    #expect(request.value(forHTTPHeaderField: "Content-Type")?.hasPrefix("multipart/form-data; boundary=everyapp-") == true)
    let body = String(decoding: request.httpBody ?? Data(), as: UTF8.self)
    #expect(body.contains("name=\"model\"\r\n\r\nlarge-v3\r\n"))
    #expect(body.contains("name=\"response_format\"\r\n\r\njson\r\n"))
    #expect(body.contains("name=\"language\"\r\n\r\nen\r\n"))
    #expect(body.contains("name=\"file\"; filename=\"audio.wav\"\r\nContent-Type: audio/wav\r\n\r\nRIFFwav\r\n"))

    let keyed = StubTransport { _ in (200, #"{"text":""}"#, [:]) }
    _ = try await TranscriptionServerClient(server: Self.server(key: "sk-local"), transport: keyed).transcribe(wav: Data(), language: nil)
    #expect(keyed.requests.first?.value(forHTTPHeaderField: "Authorization") == "Bearer sk-local")
    let keyedBody = String(decoding: keyed.requests.first?.httpBody ?? Data(), as: UTF8.self)
    #expect(!keyedBody.contains("name=\"language\""))
  }

  @Test func theCheckSendsOneSecondOfSilence() async throws {
    let stub = StubTransport { _ in (200, #"{"text":"[BLANK_AUDIO]"}"#, [:]) }
    let text = try await TranscriptionServerClient(server: Self.server(), transport: stub).check()
    #expect(text.isEmpty)
    #expect(stub.requests.first?.httpBody?.count ?? 0 > 32_000)
  }

  @Test func audioIsSentAsA16kHzWAV() {
    // One second at 24 kHz in, one second at 16 kHz out.
    let tone = PCM16.encode((0..<24_000).map { sin(Float($0) / 10) * 0.2 })
    let wav = TranscriptionServerClient.wav(pcm24k: tone)
    #expect(String(decoding: wav.prefix(4), as: UTF8.self) == "RIFF")
    let rate = wav.subdata(in: 24..<28).withUnsafeBytes { $0.loadUnaligned(as: UInt32.self) }
    #expect(UInt32(littleEndian: rate) == 16_000)
    let samples = (wav.count - 44) / 2
    #expect((15_990...16_060).contains(samples))
    // Still the tone, not silence.
    #expect(PCM16.decode(wav.subdata(in: 44..<wav.count)).contains { abs(Int($0)) > 3_000 })
  }

  @Test func errorsSayWhatTheServerSaid() async {
    func failure(_ status: Int, _ body: String, _ headers: [String: String] = [:]) async -> TranscriptionServerError? {
      let stub = StubTransport { _ in (status, body, headers) }
      do {
        _ = try await TranscriptionServerClient(server: Self.server(), transport: stub).transcribe(wav: Data(), language: nil)
        return nil
      } catch {
        return error as? TranscriptionServerError
      }
    }
    let refused = await failure(401, #"{"error":{"message":"Incorrect API key provided"}}"#)
    #expect(refused == .status(401, message: "Incorrect API key provided"))
    #expect(refused?.isPermanent == true)
    #expect(refused?.localizedDescription == "Your transcription server refused the API key (HTTP 401): Incorrect API key provided.")

    let missing = await failure(404, #"{"detail":"Not Found"}"#)
    #expect(missing?.isPermanent == true)
    #expect(missing?.localizedDescription.contains("no /audio/transcriptions at that address") == true)

    let busy = await failure(503, "loading")
    #expect(busy == .status(503, message: nil))
    #expect(busy?.isPermanent == false)
    #expect(await failure(429, "{}")?.isPermanent == false)

    // A web page, or JSON without `text`: not a transcription server. A redirect isn't followed.
    #expect(await failure(200, "<html></html>", ["Content-Type": "text/html"]) == .notATranscript)
    #expect(await failure(200, #"{"ok":true}"#) == .notATranscript)
    #expect(await failure(307, "", ["Location": "https://elsewhere.example.com/v1"])?.isPermanent == true)
  }

  @Test func nothingListeningIsUnreachableAndWorthRetrying() async {
    do {
      _ = try await TranscriptionServerClient(server: Self.server(), transport: DeadTransport()).check()
      Issue.record("expected a failure")
    } catch let error as TranscriptionServerError {
      #expect(error == .unreachable(host: "localhost:50060"))
      #expect(!error.isPermanent)
      #expect(error.localizedDescription == "Your transcription server at localhost:50060 isn't answering.")
    } catch {
      Issue.record("unexpected \(error)")
    }
  }
}
