import Foundation

/// Streaming sample-rate converter for mono Float audio: a windowed-sinc (Blackman) low-pass
/// interpolator, so downsampling 48 kHz to 24 kHz doesn't fold the top octave back into speech.
/// Chunks can be any size; feeding a signal in pieces gives the same output as feeding it whole.
public struct Resampler: Sendable {
  public let inputRate: Double
  public let outputRate: Double
  /// Zero crossings of the sinc on each side.
  let zeroCrossings: Int
  /// Input samples per output sample.
  let step: Double
  /// The filter's cutoff relative to the input Nyquist: 1 when upsampling.
  let cutoff: Double
  /// Half the filter's span in input samples.
  let halfWidth: Int

  /// Unconsumed input, including `halfWidth` samples of history.
  var buffer: [Float]
  /// Where the next output sample sits, in `buffer` coordinates.
  var position: Double

  public init(from inputRate: Double, to outputRate: Double, zeroCrossings: Int = 16) {
    precondition(inputRate > 0 && outputRate > 0)
    self.inputRate = inputRate
    self.outputRate = outputRate
    self.zeroCrossings = zeroCrossings
    step = inputRate / outputRate
    cutoff = min(1, outputRate / inputRate) * 0.95
    halfWidth = Int((Double(zeroCrossings) / cutoff).rounded(.up))
    // Silence before the first sample, so the first output is centered on input sample 0.
    buffer = [Float](repeating: 0, count: halfWidth)
    position = Double(halfWidth)
  }

  public mutating func process(_ input: [Float]) -> [Float] {
    if inputRate == outputRate { return input }
    buffer.append(contentsOf: input)
    var output: [Float] = []
    output.reserveCapacity(Int(Double(input.count) / step) + 2)
    let cutoff = self.cutoff
    let width = Double(halfWidth)
    while Int(position) + halfWidth < buffer.count {
      let center = Int(position)
      let frac = position - Double(center)
      var sum = 0.0
      for k in (center - halfWidth + 1)...(center + halfWidth) {
        let t = Double(k - center) - frac  // distance from the output point, in input samples
        sum += Double(buffer[k]) * Self.kernel(t, cutoff: cutoff, width: width)
      }
      output.append(Float(sum))
      position += step
    }
    // Keep halfWidth samples of history behind the next output point.
    let drop = Int(position) - halfWidth
    if drop > 0 {
      buffer.removeFirst(drop)
      position -= Double(drop)
    }
    return output
  }

  /// Windowed sinc: cutoff·sinc(cutoff·t), tapered by a Blackman window over ±width.
  static func kernel(_ t: Double, cutoff: Double, width: Double) -> Double {
    guard abs(t) < width else { return 0 }
    let x = Double.pi * cutoff * t
    let sinc = x == 0 ? 1 : sin(x) / x
    let n = (t / width + 1) / 2  // 0…1 across the window
    let window = 0.42 - 0.5 * cos(2 * .pi * n) + 0.08 * cos(4 * .pi * n)
    return cutoff * sinc * window
  }
}

public enum PCM16 {
  /// Float samples in [-1, 1] to little-endian 16-bit PCM, clipped.
  public static func encode(_ samples: [Float]) -> Data {
    var data = Data(count: samples.count * 2)
    data.withUnsafeMutableBytes { raw in
      let out = raw.bindMemory(to: Int16.self)
      for (i, s) in samples.enumerated() {
        let scaled = (Double(s) * 32_767).rounded()
        out[i] = Int16(max(-32_768, min(32_767, scaled))).littleEndian
      }
    }
    return data
  }

  public static func decode(_ data: Data) -> [Int16] {
    let count = data.count / 2
    var samples = [Int16](repeating: 0, count: count)
    data.withUnsafeBytes { raw in
      for i in 0..<count {
        samples[i] = Int16(littleEndian: raw.loadUnaligned(fromByteOffset: i * 2, as: Int16.self))
      }
    }
    return samples
  }

  /// Averages interleaved channels to mono.
  public static func downmix(interleaved: UnsafeBufferPointer<Float>, channels: Int) -> [Float] {
    guard channels > 1 else { return Array(interleaved) }
    let frames = interleaved.count / channels
    var mono = [Float](repeating: 0, count: frames)
    let scale = 1 / Float(channels)
    for f in 0..<frames {
      var sum: Float = 0
      for ch in 0..<channels { sum += interleaved[f * channels + ch] }
      mono[f] = sum * scale
    }
    return mono
  }
}

/// Native-rate float audio in, the Realtime API's PCM16 24 kHz mono out.
public struct AudioConverter24k: Sendable {
  public static let outputRate = 24_000.0
  var resampler: Resampler

  public init(inputRate: Double) { resampler = Resampler(from: inputRate, to: Self.outputRate) }

  public var inputRate: Double { resampler.inputRate }

  public mutating func convert(mono: [Float]) -> Data { PCM16.encode(resampler.process(mono)) }
}
