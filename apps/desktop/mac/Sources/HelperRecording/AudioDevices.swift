import CoreAudio
import Foundation

/// The default input and output devices by name, and a watcher for when either changes.
public enum AudioDevices {
  public static var defaultInputName: String? { name(of: defaultDevice(kAudioHardwarePropertyDefaultInputDevice)) }
  public static var defaultOutputName: String? { name(of: defaultDevice(kAudioHardwarePropertyDefaultOutputDevice)) }

  static func defaultDevice(_ selector: AudioObjectPropertySelector) -> AudioObjectID? {
    var address = AudioObjectPropertyAddress(
      mSelector: selector, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
    var device = AudioObjectID(kAudioObjectUnknown)
    var size = UInt32(MemoryLayout<AudioObjectID>.size)
    guard AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, &device) == noErr,
      device != kAudioObjectUnknown
    else { return nil }
    return device
  }

  static func name(of device: AudioObjectID?) -> String? {
    guard let device else { return nil }
    var address = AudioObjectPropertyAddress(
      mSelector: kAudioObjectPropertyName, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
    var name: Unmanaged<CFString>?
    var size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
    guard AudioObjectGetPropertyData(device, &address, 0, nil, &size, &name) == noErr, let name else { return nil }
    return name.takeRetainedValue() as String
  }
}

/// Calls back (on the main queue) with the new device's name when the default input or output
/// changes: `(input, output)`, the one that didn't change is nil.
public final class DeviceWatcher: @unchecked Sendable {
  private var listeners: [(AudioObjectPropertyAddress, AudioObjectPropertyListenerBlock)] = []

  public init(onChange: @escaping @Sendable (_ input: String?, _ output: String?) -> Void) {
    for selector in [kAudioHardwarePropertyDefaultInputDevice, kAudioHardwarePropertyDefaultOutputDevice] {
      var address = AudioObjectPropertyAddress(
        mSelector: selector, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
      let isInput = selector == kAudioHardwarePropertyDefaultInputDevice
      let block: AudioObjectPropertyListenerBlock = { _, _ in
        if isInput {
          onChange(AudioDevices.defaultInputName ?? "", nil)
        } else {
          onChange(nil, AudioDevices.defaultOutputName ?? "")
        }
      }
      if AudioObjectAddPropertyListenerBlock(AudioObjectID(kAudioObjectSystemObject), &address, .main, block) == noErr {
        listeners.append((address, block))
      }
    }
  }

  deinit {
    for (address, block) in listeners {
      var address = address
      AudioObjectRemovePropertyListenerBlock(AudioObjectID(kAudioObjectSystemObject), &address, .main, block)
    }
  }
}
