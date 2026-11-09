import Foundation
import HelperCore

// everyapp-smoke: drives the API client through a meeting against a running Scribe backend (the Scribe repo's web/), with a
// bearer token. No audio, no Keychain, no sign-in UI.
//
//   swift run everyapp-smoke <app-url> <token>
//   EVERYAPP_DESKTOP_TOKEN=… swift run everyapp-smoke <app-url>          (keeps the token out of shell history)
//   swift run everyapp-smoke <app-url> --token-file <file>
//
// Against `everyapp dev` any bearer is the dev user; against a deployed Scribe use a personal
// access token (Manage workspace → Tokens).

let usage = """
  usage: everyapp-smoke <app-url> <token>
         EVERYAPP_DESKTOP_TOKEN=<token> everyapp-smoke <app-url>
         everyapp-smoke <app-url> --token-file <file>
  """

func say(_ line: String) { FileHandle.standardOutput.write(Data((line + "\n").utf8)) }
func fail(_ line: String) -> Never {
  FileHandle.standardError.write(Data((line + "\n").utf8))
  exit(2)
}

let args = Array(CommandLine.arguments.dropFirst())
guard let first = args.first, let appURL = URL.typed(first)?.origin else { fail(usage) }
let token: String
switch args.count {
case 1:
  guard let env = ProcessInfo.processInfo.environment["EVERYAPP_DESKTOP_TOKEN"], !env.isEmpty else { fail(usage) }
  token = env
case 2 where !args[1].hasPrefix("--"):
  token = args[1]
case 3 where args[1] == "--token-file":
  guard let text = try? String(contentsOfFile: args[2], encoding: .utf8) else { fail("FAIL can't read \(args[2])") }
  token = text.trimmingCharacters(in: .whitespacesAndNewlines)
default:
  fail(usage)
}

func step(_ name: String, _ body: () async throws -> String) async -> Bool {
  do {
    say("ok   \(name): \(try await body())")
    return true
  } catch {
    say("FAIL \(name): \(error.localizedDescription)")
    return false
  }
}

let api = APIClient(auth: AccessTokenAuthProvider(appURL: appURL, token: token))
var failed = false
failed = !(await step("me") { let me = try await api.me(); return "\(me.email ?? "?") google=\(me.googleConnected)" }) || failed
failed = !(await step("upcoming") {
  let u = try await api.upcoming()
  return "connected=\(u.connected) events=\(u.events.count) connectURL=\(u.connectURL?.absoluteString ?? "nil")"
}) || failed
var meetingID = ""
failed = !(await step("create") {
  meetingID = try await api.createMeeting(title: "Smoke test", startsAt: Date(), calendarEventId: nil).id
  return meetingID
}) || failed
guard !meetingID.isEmpty else { exit(1) }
_ = await step("transcription-token (needs OpenAI set up)") {
  let t = try await api.transcriptionToken(meetingID: meetingID, source: "mic", language: "en")
  return "model=\(t.model ?? "?") expires=\(t.expiresAt)"
}
_ = await step("audio-chunk (needs OpenAI set up)") {
  let wav = WAV.encode(pcm16: Data(count: 48 * 1_000))
  let segment = try await api.appendAudioChunk(
    meetingID: meetingID, wav: wav, seq: 100, startedMs: 0, endedMs: 1_000, speaker: .me, language: "en")
  return "segment=\(segment?.text ?? "none")"
}
var batcher = SegmentBatcher()
batcher.add(speaker: .me, startedMs: 0, endedMs: 1_200, text: "Let's start with the roadmap.")
batcher.add(speaker: .them, startedMs: 1_400, endedMs: 3_000, text: "Sounds good, I have two updates.")
let batch = batcher.takeBatch()
failed = !(await step("segments") { try await api.appendSegments(meetingID: meetingID, batch); return "\(batch.count) posted" }) || failed
failed = !(await step("segments again (dedupe)") { try await api.appendSegments(meetingID: meetingID, batch); return "accepted" }) || failed
failed = !(await step("finish") { try await api.finish(meetingID: meetingID); return "accepted" }) || failed
failed = !(await step("meetings") {
  let list = try await api.meetings()
  guard let m = list.first(where: { $0.id == meetingID }) else { throw APIError.decoding("new meeting missing from list") }
  return "\(list.count) total; this one \(m.status ?? "?") → \(m.pageURL(appURL: appURL))"
}) || failed
exit(failed ? 1 : 0)
