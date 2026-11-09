import Foundation
import HelperRecording
import os

// everyapp-helper: Every App's audio capture and transcription, driven by the desktop app over stdin and
// stdout with newline-delimited JSON (docs/desktop-plan.md "Helper protocol (v1)"). stdout
// carries protocol lines only; logs go to stderr and os_log. Never logs a token.

let logger = Logger(subsystem: "com.everyapp.desktop", category: "helper")

@Sendable func log(_ message: String) {
  logger.info("\(message, privacy: .public)")
  FileHandle.standardError.write(Data("everyapp-helper: \(message)\n".utf8))
}

/// Whole lines to fd 1, one writer at a time. POSIX write: a closed pipe is an error to ignore,
/// not an exception.
let stdoutLock = NSLock()
@Sendable func writeLine(_ line: String) {
  let data = Array((line + "\n").utf8)
  stdoutLock.withLock {
    var offset = 0
    while offset < data.count {
      let n = data[offset...].withUnsafeBytes { write(STDOUT_FILENO, $0.baseAddress, $0.count) }
      if n <= 0 {
        if n < 0, errno == EINTR { continue }
        return
      }
      offset += n
    }
  }
}

signal(SIGPIPE, SIG_IGN)

/// `everyapp-helper --selftest [--seconds N] [--echo-cancellation]`: mic + system audio, locally.
/// `--echo-cancellation` (voice processing on the mic) is the only way to reach it now: kept for
/// a future hardware test, not used by recordings.
@MainActor
func runSelfTest(_ args: [String]) async -> Int32 {
  var seconds = 8
  if let i = args.firstIndex(of: "--seconds") {
    guard i + 1 < args.count, let n = Int(args[i + 1]), (1...60).contains(n) else {
      FileHandle.standardError.write(Data("usage: everyapp-helper --selftest [--seconds 1-60] [--echo-cancellation]\n".utf8))
      return 2
    }
    seconds = n
  }
  let echo = args.contains("--echo-cancellation")
  print("Every App self-test: \(seconds) s. Speak, and play something (a YouTube video) through the speakers.")
  print("Nothing is recorded, uploaded or saved.\n")
  var headerShown = false
  func bar(_ level: Double) -> String {
    let n = Int((level * 20).rounded())
    return String(repeating: "█", count: n) + String(repeating: "·", count: 20 - n)
  }
  let test = SelfTest(dependencies: .live, echoCancellation: echo, requestMic: { await CapturePermission.ensureMicrophone() })
  let report = await test.run(seconds: seconds, onSecond: { second in
    if !headerShown {
      headerShown = true
      print("mic:    \(AudioDevices.defaultInputName ?? "?")\(echo ? " (voice processing requested)" : "")")
      print("system: \(AudioDevices.defaultOutputName ?? "?") (process tap)\n")
    }
    print(String(format: "%3ds  mic %@ %.2f   system %@ %.2f", second.second, bar(second.mic), second.mic, bar(second.system), second.system))
  })
  func rate(_ r: Double?) -> String { r.map { "\(Int($0)) Hz" } ?? "?" }
  print("")
  print("mic:    \(report.mic.device ?? "?"), \(rate(report.mic.sampleRate)), voice processing \(report.voiceProcessing ? "on" : "off")")
  print("system: \(report.system.device ?? "?"), \(rate(report.system.sampleRate))")
  print(report.text)
  return report.passed ? 0 : 1
}

if CommandLine.arguments.contains("--selftest") {
  exit(await runSelfTest(Array(CommandLine.arguments.dropFirst())))
}

@MainActor
func run() async {
  let server = HelperServer(environment: .live, write: writeLine, log: log)
  let devices = DeviceWatcher { input, output in
    Task { @MainActor in server.deviceChanged(input: input, output: output) }
  }
  let requests = RequestTracker()

  // SIGTERM/SIGINT: the same clean exit as stdin closing.
  var exiting = false
  func exitCleanly(_ why: String) async {
    guard !exiting else { return }
    exiting = true
    log("\(why); exiting")
    // Don't hang forever on a stop that can't finish.
    DispatchQueue.global().asyncAfter(deadline: .now() + 45) {
      log("shutdown took too long")
      exit(1)
    }
    let started = ContinuousClock.now
    // A recording (or a record.stop in progress) is finished properly first: flush + /finish.
    await server.shutdown()
    // Then give requests already read a moment to answer, but don't wait on one that's only
    // waiting (a permission prompt): that used to hold the exit until the watchdog.
    let answered = await requests.drain()
    if !answered { log("exiting with \(requests.pending) request(s) unanswered") }
    log("exit after \(ContinuousClock.now - started)")
    withExtendedLifetime(devices) {}
    exit(0)
  }
  var signalSources: [DispatchSourceSignal] = []
  for sig in [SIGTERM, SIGINT] {
    signal(sig, SIG_IGN)
    let source = DispatchSource.makeSignalSource(signal: sig, queue: .main)
    source.setEventHandler { Task { @MainActor in await exitCleanly(sig == SIGTERM ? "SIGTERM" : "SIGINT") } }
    source.resume()
    signalSources.append(source)
  }

  log("started (pid \(getpid()))")
  do {
    for try await line in FileHandle.standardInput.bytes.lines {
      requests.begin()
      Task { @MainActor in
        await server.handle(line)
        requests.end()
      }
    }
  } catch {
    log("stdin failed: \(error.localizedDescription)")
  }
  _ = signalSources
  await exitCleanly("stdin closed")
}

await run()
