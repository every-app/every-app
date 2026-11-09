import CoreAudio
import Foundation

/// A process using audio input, as Core Audio reports it.
public struct InputProcess: Sendable, Equatable {
  public var pid: pid_t
  public var bundleID: String

  public init(pid: pid_t, bundleID: String) {
    self.pid = pid
    self.bundleID = bundleID
  }
}

/// Which processes are using the mic right now.
public protocol InputProcessSource: Sendable {
  func processesUsingInput() -> [InputProcess]
}

/// A call app Every App knows. Browsers are listed too: whether a tab is in Meet isn't knowable from
/// here, so the app decides what a browser using the mic means.
public struct CallApp: Sendable, Equatable, Hashable {
  public var bundleID: String
  public var name: String

  public init(bundleID: String, name: String) {
    self.bundleID = bundleID
    self.name = name
  }
}

public enum CallApps {
  /// (bundle id prefixes, reported app). A process matches a prefix when its bundle id equals it
  /// or continues it with "." (helpers: `com.google.Chrome.helper`, `us.zoom.CptHost`). Compared
  /// case-insensitively.
  static let known: [([String], CallApp)] = [
    (["us.zoom"], CallApp(bundleID: "us.zoom.xos", name: "Zoom")),
    (["com.microsoft.teams2", "com.microsoft.teams"], CallApp(bundleID: "com.microsoft.teams2", name: "Microsoft Teams")),
    (["com.tinyspeck.slackmacgap"], CallApp(bundleID: "com.tinyspeck.slackmacgap", name: "Slack")),
    // FaceTime's audio runs in avconferenced.
    (["com.apple.FaceTime", "com.apple.avconferenced"], CallApp(bundleID: "com.apple.FaceTime", name: "FaceTime")),
    (["com.cisco.webexmeetingsapp", "com.webex.meetingmanager", "Cisco-Systems.Spark"], CallApp(bundleID: "Cisco-Systems.Spark", name: "Webex")),
    (["com.hnc.Discord"], CallApp(bundleID: "com.hnc.Discord", name: "Discord")),
    (["com.google.Chrome"], CallApp(bundleID: "com.google.Chrome", name: "Google Chrome")),
    (["company.thebrowser.Browser"], CallApp(bundleID: "company.thebrowser.Browser", name: "Arc")),
    // Safari's WebRTC capture runs in WebKit's GPU process.
    (["com.apple.Safari", "com.apple.WebKit.GPU"], CallApp(bundleID: "com.apple.Safari", name: "Safari")),
    (["com.microsoft.edgemac"], CallApp(bundleID: "com.microsoft.edgemac", name: "Microsoft Edge")),
    (["org.mozilla.firefox", "org.mozilla.plugincontainer"], CallApp(bundleID: "org.mozilla.firefox", name: "Firefox")),
    (["com.brave.Browser"], CallApp(bundleID: "com.brave.Browser", name: "Brave")),
  ]

  /// Every App's own processes (the helper captures the mic while recording).
  static let ownPrefix = "com.everyapp.desktop"

  public static func match(_ bundleID: String) -> CallApp? {
    let id = bundleID.lowercased()
    guard !id.isEmpty, !matches(id, ownPrefix.lowercased()) else { return nil }
    for (prefixes, app) in known where prefixes.contains(where: { matches(id, $0.lowercased()) }) {
      return app
    }
    return nil
  }

  private static func matches(_ id: String, _ prefix: String) -> Bool {
    id == prefix || id.hasPrefix(prefix + ".")
  }
}

public enum CallEvent: Sendable, Equatable {
  case started(CallApp)
  case ended(CallApp)
}

/// Debounces "a known call app is using the mic" into started/ended: an app must use the mic
/// for `debounce` seconds before it counts, and stop for `debounce` seconds before it's over,
/// so a mic check or a brief device switch doesn't prompt.
public struct CallDetector: Sendable {
  public static let defaultDebounce: TimeInterval = 3

  public let debounce: TimeInterval
  private var pending: [CallApp: Date] = [:]  // seen since, not reported yet
  private var active: [CallApp: Date] = [:]  // reported; last seen

  public init(debounce: TimeInterval = CallDetector.defaultDebounce) { self.debounce = debounce }

  public var activeApps: Set<CallApp> { Set(active.keys) }

  /// Feed the apps seen using the mic right now.
  public mutating func update(seen: Set<CallApp>, now: Date) -> [CallEvent] {
    var events: [CallEvent] = []
    for app in seen.sorted(by: { $0.bundleID < $1.bundleID }) {
      if active[app] != nil {
        active[app] = now
      } else if let since = pending[app] {
        if now.timeIntervalSince(since) >= debounce {
          pending[app] = nil
          active[app] = now
          events.append(.started(app))
        }
      } else {
        pending[app] = now
      }
    }
    for app in pending.keys where !seen.contains(app) { pending[app] = nil }
    for (app, lastSeen) in active.sorted(by: { $0.key.bundleID < $1.key.bundleID }) where !seen.contains(app) {
      if now.timeIntervalSince(lastSeen) >= debounce {
        active[app] = nil
        events.append(.ended(app))
      }
    }
    return events
  }

  public mutating func reset() {
    pending = [:]
    active = [:]
  }
}

/// Polls an `InputProcessSource` and runs the detector. `ownPID` is skipped.
public struct CallWatcher: Sendable {
  public let source: any InputProcessSource
  public let ownPID: pid_t
  public var detector: CallDetector

  public init(source: any InputProcessSource, ownPID: pid_t = getpid(), debounce: TimeInterval = CallDetector.defaultDebounce) {
    self.source = source
    self.ownPID = ownPID
    self.detector = CallDetector(debounce: debounce)
  }

  public mutating func poll(now: Date = Date()) -> [CallEvent] {
    let seen = Set(source.processesUsingInput().filter { $0.pid != ownPID }.compactMap { CallApps.match($0.bundleID) })
    return detector.update(seen: seen, now: now)
  }
}

/// Core Audio's process objects (macOS 14.2+): every process with audio I/O, whether it is
/// running input, and its bundle id.
public struct CoreAudioProcessSource: InputProcessSource {
  public init() {}

  public func processesUsingInput() -> [InputProcess] {
    let system = AudioObjectID(kAudioObjectSystemObject)
    var address = AudioObjectPropertyAddress(
      mSelector: kAudioHardwarePropertyProcessObjectList, mScope: kAudioObjectPropertyScopeGlobal,
      mElement: kAudioObjectPropertyElementMain)
    var size: UInt32 = 0
    guard AudioObjectGetPropertyDataSize(system, &address, 0, nil, &size) == noErr, size > 0 else { return [] }
    var objects = [AudioObjectID](repeating: 0, count: Int(size) / MemoryLayout<AudioObjectID>.size)
    guard AudioObjectGetPropertyData(system, &address, 0, nil, &size, &objects) == noErr else { return [] }
    return objects.prefix(Int(size) / MemoryLayout<AudioObjectID>.size).compactMap { object in
      guard Self.uint32(object, kAudioProcessPropertyIsRunningInput) == 1 else { return nil }
      let pid = Self.pid(object) ?? -1
      return InputProcess(pid: pid, bundleID: Self.bundleID(object) ?? "")
    }
  }

  static func uint32(_ object: AudioObjectID, _ selector: AudioObjectPropertySelector) -> UInt32? {
    var address = AudioObjectPropertyAddress(
      mSelector: selector, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
    var value: UInt32 = 0
    var size = UInt32(MemoryLayout<UInt32>.size)
    return AudioObjectGetPropertyData(object, &address, 0, nil, &size, &value) == noErr ? value : nil
  }

  static func pid(_ object: AudioObjectID) -> pid_t? {
    var address = AudioObjectPropertyAddress(
      mSelector: kAudioProcessPropertyPID, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
    var value: pid_t = 0
    var size = UInt32(MemoryLayout<pid_t>.size)
    return AudioObjectGetPropertyData(object, &address, 0, nil, &size, &value) == noErr ? value : nil
  }

  static func bundleID(_ object: AudioObjectID) -> String? {
    var address = AudioObjectPropertyAddress(
      mSelector: kAudioProcessPropertyBundleID, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
    var value: Unmanaged<CFString>?
    var size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
    guard AudioObjectGetPropertyData(object, &address, 0, nil, &size, &value) == noErr, let value else { return nil }
    return value.takeRetainedValue() as String
  }
}
