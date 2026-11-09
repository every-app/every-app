@preconcurrency import AVFoundation
import HelperCore

/// The microphone through AVAudioEngine, delivered as PCM16 24 kHz mono chunks. Never asks for
/// permission itself: the caller checks first (a prompt from inside capture code is the kind
/// that gets lost).
public final class MicCapture: AudioSource, @unchecked Sendable {
  private let engine = AVAudioEngine()
  private var converter: AudioConverter24k?
  private let onAudio: @Sendable (Data) -> Void
  private var configObserver: NSObjectProtocol?
  private let onInterrupted: @Sendable (String?) -> Void
  /// Apple's voice processing (echo cancellation, noise suppression) on the input. Off by
  /// default until it's been tried on real hardware.
  public let voiceProcessing: Bool
  public private(set) var sampleRate: Double?

  /// `onInterrupted` gets a sentence when the mic stops and can't be restarted, nil when it's back.
  public init(
    voiceProcessing: Bool = false, onAudio: @escaping @Sendable (Data) -> Void,
    onInterrupted: @escaping @Sendable (String?) -> Void = { _ in }
  ) {
    self.voiceProcessing = voiceProcessing
    self.onAudio = onAudio
    self.onInterrupted = onInterrupted
  }

  public func start() throws {
    try startEngine()
    // The engine stops itself when the input device changes (AirPods plugged in, the default mic
    // switched mid-meeting). Start again on the new device, in its format.
    configObserver = NotificationCenter.default.addObserver(
      forName: .AVAudioEngineConfigurationChange, object: engine, queue: .main
    ) { [weak self] _ in self?.restart() }
  }

  private func restart() {
    engine.inputNode.removeTap(onBus: 0)
    engine.stop()
    do {
      try startEngine()
      onInterrupted(nil)
    } catch {
      onInterrupted("The microphone stopped: \(error.localizedDescription)")
    }
  }

  private func startEngine() throws {
    let input = engine.inputNode
    if voiceProcessing {
      // Must be set while the engine is stopped; it's set again after a device change, which
      // rebuilds the engine's I/O. The format is read after, since voice processing changes it.
      if !input.isVoiceProcessingEnabled { try input.setVoiceProcessingEnabled(true) }
      // Don't turn the call down while it's being recorded: the person needs to hear it, and
      // the system tap would hear it quieter too.
      input.voiceProcessingOtherAudioDuckingConfiguration = AVAudioVoiceProcessingOtherAudioDuckingConfiguration(
        enableAdvancedDucking: false, duckingLevel: .min)
    }
    let format = input.outputFormat(forBus: 0)
    guard format.sampleRate > 0, format.channelCount > 0 else { throw CaptureError("No microphone is available.") }
    sampleRate = format.sampleRate
    converter = AudioConverter24k(inputRate: format.sampleRate)
    // ~100 ms buffers; the tap's thread does the conversion, which is cheap.
    let size = AVAudioFrameCount(format.sampleRate / 10)
    input.installTap(onBus: 0, bufferSize: size, format: format) { [weak self] buffer, _ in
      self?.handle(buffer)
    }
    engine.prepare()
    try engine.start()
  }

  public func stop() {
    if let configObserver { NotificationCenter.default.removeObserver(configObserver) }
    configObserver = nil
    engine.inputNode.removeTap(onBus: 0)
    engine.stop()
  }

  private func handle(_ buffer: AVAudioPCMBuffer) {
    guard let channels = buffer.floatChannelData, buffer.frameLength > 0 else { return }
    let frames = Int(buffer.frameLength)
    let total = Int(buffer.format.channelCount)
    // With voice processing the processed voice is channel 0; the others aren't the mic.
    let use = voiceProcessing ? 1 : total
    let mono: [Float]
    if buffer.format.isInterleaved {
      mono = Self.mono(interleaved: UnsafeBufferPointer(start: channels[0], count: frames * total), channels: total, using: use)
    } else {
      mono = Self.mono(planar: (0..<use).map { UnsafeBufferPointer(start: channels[$0], count: frames) })
    }
    guard let data = converter?.convert(mono: mono), !data.isEmpty else { return }
    onAudio(data)
  }

  /// The average of the first `using` channels of interleaved audio with `channels` per frame.
  static func mono(interleaved samples: UnsafeBufferPointer<Float>, channels: Int, using: Int) -> [Float] {
    let channels = max(1, channels)
    let using = min(max(1, using), channels)
    let frames = samples.count / channels
    var out = [Float](repeating: 0, count: frames)
    for i in 0..<frames {
      var sum: Float = 0
      for c in 0..<using { sum += samples[i * channels + c] }
      out[i] = sum / Float(using)
    }
    return out
  }

  /// The average of planar channels.
  static func mono(planar channels: [UnsafeBufferPointer<Float>]) -> [Float] {
    guard let first = channels.first else { return [] }
    var out = [Float](repeating: 0, count: first.count)
    for channel in channels {
      for i in 0..<min(out.count, channel.count) { out[i] += channel[i] }
    }
    if channels.count > 1 {
      let scale = 1 / Float(channels.count)
      for i in 0..<out.count { out[i] *= scale }
    }
    return out
  }
}

extension MicCapture: CaptureInfo {
  public var deviceName: String? { AudioDevices.defaultInputName }
  public var voiceProcessingActive: Bool { voiceProcessing && engine.inputNode.isVoiceProcessingEnabled }
}

public struct CaptureError: Error, LocalizedError {
  public let message: String
  public init(_ message: String) { self.message = message }
  public var errorDescription: String? { message }
}
