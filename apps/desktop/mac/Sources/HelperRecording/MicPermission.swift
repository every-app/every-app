@preconcurrency import AVFoundation
import Foundation

/// Microphone and system-audio permission without UI. macOS charges both to the responsible
/// process: the app that launched us (Every App.app for the helper), whose Info.plist carries the
/// usage strings.
public enum CapturePermission {
  public enum Status: String, Sendable, Equatable {
    case granted, denied, undetermined, unknown
  }

  public static var microphone: Status {
    switch AVCaptureDevice.authorizationStatus(for: .audio) {
    case .authorized: .granted
    case .denied, .restricted: .denied
    case .notDetermined: .undetermined
    @unknown default: .unknown
    }
  }

  /// Asks if never asked; true when the mic may be used.
  public static func ensureMicrophone() async -> Bool {
    switch AVCaptureDevice.authorizationStatus(for: .audio) {
    case .authorized: return true
    case .notDetermined: return await AVCaptureDevice.requestAccess(for: .audio)
    default: return false
    }
  }

  /// There's no public API to ask for or read "System Audio Recording Only": macOS asks the first
  /// time a process tap starts. A one-second tap brings the prompt up at a calm moment.
  public static func primeSystemAudio() {
    let capture = SystemAudioCapture { _ in }
    guard (try? capture.start()) != nil else { return }
    DispatchQueue.main.asyncAfter(deadline: .now() + 1) { capture.stop() }
  }
}
