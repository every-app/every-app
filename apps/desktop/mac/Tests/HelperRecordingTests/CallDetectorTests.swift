import Foundation
import Testing
@testable import HelperRecording

@Suite struct CallAppsTests {
  @Test func matchesAppsAndTheirHelpers() {
    #expect(CallApps.match("us.zoom.xos")?.name == "Zoom")
    #expect(CallApps.match("us.zoom.CptHost")?.bundleID == "us.zoom.xos")
    #expect(CallApps.match("com.google.Chrome.helper")?.bundleID == "com.google.Chrome")
    #expect(CallApps.match("company.thebrowser.browser.helper")?.name == "Arc")
    #expect(CallApps.match("com.microsoft.teams2")?.name == "Microsoft Teams")
    #expect(CallApps.match("com.tinyspeck.slackmacgap.helper")?.name == "Slack")
    #expect(CallApps.match("com.apple.avconferenced")?.name == "FaceTime")
    #expect(CallApps.match("com.apple.WebKit.GPU")?.bundleID == "com.apple.Safari")
    #expect(CallApps.match("Cisco-Systems.Spark")?.name == "Webex")
    #expect(CallApps.match("com.hnc.Discord.helper")?.name == "Discord")
    #expect(CallApps.match("org.mozilla.firefox")?.name == "Firefox")
    #expect(CallApps.match("com.microsoft.edgemac.helper")?.name == "Microsoft Edge")
  }

  @Test func ignoresOthersAndItself() {
    #expect(CallApps.match("") == nil)
    #expect(CallApps.match("com.apple.VoiceMemos") == nil)
    #expect(CallApps.match("us.zoomer.app") == nil)
    #expect(CallApps.match("com.google.Chromeish") == nil)
    #expect(CallApps.match("com.everyapp.desktop.helper") == nil)
    #expect(CallApps.match("com.everyapp.desktop.dev") == nil)
  }
}

@Suite struct CallDetectorTests {
  let zoom = CallApp(bundleID: "us.zoom.xos", name: "Zoom")
  let chrome = CallApp(bundleID: "com.google.Chrome", name: "Google Chrome")
  let t0 = Date(timeIntervalSince1970: 1000)

  func at(_ s: TimeInterval) -> Date { t0.addingTimeInterval(s) }

  @Test func startsAfterThreeSecondsOfMicUse() {
    var d = CallDetector()
    #expect(d.update(seen: [zoom], now: at(0)) == [])
    #expect(d.update(seen: [zoom], now: at(2.9)) == [])
    #expect(d.update(seen: [zoom], now: at(3)) == [.started(zoom)])
    #expect(d.update(seen: [zoom], now: at(4)) == [])
    #expect(d.activeApps == [zoom])
  }

  @Test func aBriefMicCheckIsIgnored() {
    var d = CallDetector()
    _ = d.update(seen: [zoom], now: at(0))
    _ = d.update(seen: [zoom], now: at(2))
    #expect(d.update(seen: [], now: at(2.5)) == [])
    // Seen again: the clock starts over.
    #expect(d.update(seen: [zoom], now: at(3)) == [])
    #expect(d.update(seen: [zoom], now: at(5.9)) == [])
    #expect(d.update(seen: [zoom], now: at(6)) == [.started(zoom)])
  }

  @Test func endsAfterThreeSecondsWithoutTheMic() {
    var d = CallDetector()
    _ = d.update(seen: [zoom], now: at(0))
    _ = d.update(seen: [zoom], now: at(3))
    #expect(d.update(seen: [], now: at(4)) == [])
    #expect(d.update(seen: [], now: at(5.9)) == [])
    #expect(d.update(seen: [], now: at(6)) == [.ended(zoom)])
    #expect(d.update(seen: [], now: at(10)) == [])
    #expect(d.activeApps.isEmpty)
  }

  @Test func aShortGapDoesntEndTheCall() {
    var d = CallDetector()
    _ = d.update(seen: [zoom], now: at(0))
    _ = d.update(seen: [zoom], now: at(3))
    #expect(d.update(seen: [], now: at(4)) == [])
    #expect(d.update(seen: [zoom], now: at(5)) == [])
    // Three seconds from the last sighting (5 s), not the first gap.
    #expect(d.update(seen: [], now: at(7)) == [])
    #expect(d.update(seen: [], now: at(7.9)) == [])
    #expect(d.update(seen: [], now: at(8)) == [.ended(zoom)])
  }

  @Test func appsAreTrackedSeparately() {
    var d = CallDetector()
    _ = d.update(seen: [zoom], now: at(0))
    _ = d.update(seen: [zoom, chrome], now: at(2))
    #expect(d.update(seen: [zoom, chrome], now: at(3)) == [.started(zoom)])
    #expect(d.update(seen: [chrome], now: at(5)) == [.started(chrome)])
    #expect(d.update(seen: [chrome], now: at(6)) == [.ended(zoom)])
  }

  @Test func watcherMapsProcessesAndSkipsItself() {
    let source = FakeProcesses()
    var w = CallWatcher(source: source, ownPID: 42)
    source.now = [
      InputProcess(pid: 42, bundleID: "us.zoom.xos"),  // "ourselves", whatever it claims
      InputProcess(pid: 7, bundleID: "com.everyapp.desktop.helper"),
      InputProcess(pid: 8, bundleID: ""),
    ]
    #expect(w.poll(now: at(0)) == [])
    #expect(w.poll(now: at(5)) == [])
    source.now = [InputProcess(pid: 9, bundleID: "com.google.Chrome.helper"), InputProcess(pid: 10, bundleID: "com.google.Chrome")]
    #expect(w.poll(now: at(6)) == [])
    #expect(w.poll(now: at(9)) == [.started(chrome)])
  }
}
