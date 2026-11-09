import AudioToolbox
import CoreAudio
import Foundation
import HelperCore

/// Everything the Mac plays (the other side of the call) through a Core Audio process tap
/// (`CATapDescription`, macOS 14.2+) on a private aggregate device, delivered as PCM16 24 kHz
/// mono. This needs "System Audio Recording Only", not Screen Recording. macOS asks the first
/// time a tap starts; there's no API to ask or check beforehand, and a denied tap delivers
/// silence rather than failing.
public final class SystemAudioCapture: AudioSource, @unchecked Sendable {
  private var tapID = AudioObjectID(kAudioObjectUnknown)
  private var aggregateID = AudioObjectID(kAudioObjectUnknown)
  private var procID: AudioDeviceIOProcID?
  private var converter: AudioConverter24k?
  private var format = AudioStreamBasicDescription()
  /// The tap's rate, once it's running.
  var tapSampleRate: Double? { format.mSampleRate > 0 ? format.mSampleRate : nil }
  private let queue = DispatchQueue(label: "com.everyapp.desktop.systemaudio", qos: .userInitiated)
  /// Device-change handling, apart from the IO queue (stopping a device from its own IO queue can hang).
  private let control = DispatchQueue(label: "com.everyapp.desktop.systemaudio.control")
  private var outputListener: AudioObjectPropertyListenerBlock?
  private let onAudio: @Sendable (Data) -> Void
  private let onInterrupted: @Sendable (String?) -> Void

  public init(onAudio: @escaping @Sendable (Data) -> Void, onInterrupted: @escaping @Sendable (String?) -> Void = { _ in }) {
    self.onAudio = onAudio
    self.onInterrupted = onInterrupted
  }

  deinit { stop() }

  public func start() throws {
    control.setSpecific(key: Self.controlKey, value: true)
    try startTap()
    // The aggregate device hangs off the output device of the moment; when the output changes
    // (headphones in, AirPods gone), build it again on the new one.
    var address = Self.defaultOutputAddress
    let listener: AudioObjectPropertyListenerBlock = { [weak self] _, _ in self?.outputChanged() }
    if AudioObjectAddPropertyListenerBlock(AudioObjectID(kAudioObjectSystemObject), &address, control, listener) == noErr {
      outputListener = listener
    }
  }

  /// Runs on `control`, so a device-change restart can't race it and bring the tap back.
  public func stop() {
    if DispatchQueue.getSpecific(key: Self.controlKey) != nil {
      stopOnControl()
    } else {
      control.sync { stopOnControl() }
    }
  }

  private func stopOnControl() {
    if let outputListener {
      var address = Self.defaultOutputAddress
      AudioObjectRemovePropertyListenerBlock(AudioObjectID(kAudioObjectSystemObject), &address, control, outputListener)
    }
    outputListener = nil
    stopTap()
  }

  private static let controlKey = DispatchSpecificKey<Bool>()

  static var defaultOutputAddress: AudioObjectPropertyAddress {
    AudioObjectPropertyAddress(
      mSelector: kAudioHardwarePropertyDefaultSystemOutputDevice, mScope: kAudioObjectPropertyScopeGlobal,
      mElement: kAudioObjectPropertyElementMain)
  }

  private func outputChanged() {
    guard outputListener != nil else { return }
    stopTap()
    do {
      try startTap()
      onInterrupted(nil)
    } catch {
      onInterrupted("Lost the other side after the output device changed: \(error.localizedDescription)")
    }
  }

  private func startTap() throws {
    // All processes but this one (it plays nothing, but excluding it is free).
    let own = Self.processObject(pid: getpid())
    let description = CATapDescription(stereoGlobalTapButExcludeProcesses: own.map { [$0] } ?? [])
    description.uuid = UUID()
    description.name = "Every App"
    description.isPrivate = true
    description.muteBehavior = .unmuted

    try check(AudioHardwareCreateProcessTap(description, &tapID), "create the system audio tap")

    var size = UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
    var address = AudioObjectPropertyAddress(
      mSelector: kAudioTapPropertyFormat, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
    try check(AudioObjectGetPropertyData(tapID, &address, 0, nil, &size, &format), "read the tap's format")
    guard format.mFormatID == kAudioFormatLinearPCM, format.mFormatFlags & kAudioFormatFlagIsFloat != 0,
      format.mBitsPerChannel == 32, format.mSampleRate > 0
    else { throw CaptureError("System audio came in a format Every App can't read.") }
    converter = AudioConverter24k(inputRate: format.mSampleRate)

    let outputUID = try Self.defaultOutputUID()
    let aggregate: [String: Any] = [
      kAudioAggregateDeviceNameKey: "Every App System Audio",
      kAudioAggregateDeviceUIDKey: "com.everyapp.desktop.tap.\(UUID().uuidString)",
      kAudioAggregateDeviceMainSubDeviceKey: outputUID,
      kAudioAggregateDeviceIsPrivateKey: true,
      kAudioAggregateDeviceIsStackedKey: false,
      kAudioAggregateDeviceTapAutoStartKey: true,
      kAudioAggregateDeviceSubDeviceListKey: [[kAudioSubDeviceUIDKey: outputUID]],
      kAudioAggregateDeviceTapListKey: [
        [kAudioSubTapDriftCompensationKey: true, kAudioSubTapUIDKey: description.uuid.uuidString]
      ],
    ]
    try check(AudioHardwareCreateAggregateDevice(aggregate as CFDictionary, &aggregateID), "create the capture device")

    try check(
      AudioDeviceCreateIOProcIDWithBlock(&procID, aggregateID, queue) { [weak self] _, input, _, _, _ in
        self?.handle(input)
      }, "start reading system audio")
    try check(AudioDeviceStart(aggregateID, procID), "start system audio")
  }

  private func stopTap() {
    if aggregateID != kAudioObjectUnknown {
      if let procID {
        AudioDeviceStop(aggregateID, procID)
        AudioDeviceDestroyIOProcID(aggregateID, procID)
      }
      AudioHardwareDestroyAggregateDevice(aggregateID)
    }
    if tapID != kAudioObjectUnknown { AudioHardwareDestroyProcessTap(tapID) }
    procID = nil
    aggregateID = AudioObjectID(kAudioObjectUnknown)
    tapID = AudioObjectID(kAudioObjectUnknown)
  }

  private func handle(_ input: UnsafePointer<AudioBufferList>) {
    let buffers = UnsafeMutableAudioBufferListPointer(UnsafeMutablePointer(mutating: input))
    guard let first = buffers.first, first.mDataByteSize > 0 else { return }
    var mono: [Float]
    if format.mFormatFlags & kAudioFormatFlagIsNonInterleaved != 0 {
      // One buffer per channel.
      let frames = Int(first.mDataByteSize) / 4
      mono = [Float](repeating: 0, count: frames)
      var used = 0
      for buffer in buffers {
        guard let data = buffer.mData else { continue }
        let p = data.assumingMemoryBound(to: Float.self)
        for i in 0..<min(frames, Int(buffer.mDataByteSize) / 4) { mono[i] += p[i] }
        used += 1
      }
      if used > 1 {
        let scale = 1 / Float(used)
        for i in 0..<frames { mono[i] *= scale }
      }
    } else {
      guard let data = first.mData else { return }
      let channels = max(1, Int(first.mNumberChannels))
      let samples = Int(first.mDataByteSize) / 4
      mono = PCM16.downmix(
        interleaved: UnsafeBufferPointer(start: data.assumingMemoryBound(to: Float.self), count: samples), channels: channels)
    }
    guard let pcm = converter?.convert(mono: mono), !pcm.isEmpty else { return }
    onAudio(pcm)
  }

  private func check(_ status: OSStatus, _ what: String) throws {
    guard status == noErr else {
      stopTap()
      throw CaptureError("Couldn't \(what) (error \(status)).")
    }
  }

  public static func processObject(pid: pid_t) -> AudioObjectID? {
    var address = AudioObjectPropertyAddress(
      mSelector: kAudioHardwarePropertyTranslatePIDToProcessObject, mScope: kAudioObjectPropertyScopeGlobal,
      mElement: kAudioObjectPropertyElementMain)
    var pid = pid
    var object = AudioObjectID(kAudioObjectUnknown)
    var size = UInt32(MemoryLayout<AudioObjectID>.size)
    let status = AudioObjectGetPropertyData(
      AudioObjectID(kAudioObjectSystemObject), &address, UInt32(MemoryLayout<pid_t>.size), &pid, &size, &object)
    return status == noErr && object != kAudioObjectUnknown ? object : nil
  }

  static func defaultOutputUID() throws -> String {
    var address = AudioObjectPropertyAddress(
      mSelector: kAudioHardwarePropertyDefaultSystemOutputDevice, mScope: kAudioObjectPropertyScopeGlobal,
      mElement: kAudioObjectPropertyElementMain)
    var device = AudioObjectID(kAudioObjectUnknown)
    var size = UInt32(MemoryLayout<AudioObjectID>.size)
    guard AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, &device) == noErr,
      device != kAudioObjectUnknown
    else { throw CaptureError("There's no audio output device.") }
    address.mSelector = kAudioDevicePropertyDeviceUID
    var uid: Unmanaged<CFString>?
    size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
    guard AudioObjectGetPropertyData(device, &address, 0, nil, &size, &uid) == noErr, let uid else {
      throw CaptureError("Couldn't read the output device.")
    }
    return uid.takeRetainedValue() as String
  }
}

extension SystemAudioCapture: CaptureInfo {
  public var sampleRate: Double? { tapSampleRate }
  public var deviceName: String? { AudioDevices.defaultOutputName }
  public var voiceProcessingActive: Bool { false }
}
