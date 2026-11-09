import Foundation

/// A RIFF WAVE file around PCM16 mono samples, built in memory (never on disk).
public enum WAV {
  public static func encode(pcm16: Data, sampleRate: Int = 24_000, channels: Int = 1) -> Data {
    var out = Data(capacity: 44 + pcm16.count)
    func u32(_ v: Int) { withUnsafeBytes(of: UInt32(v).littleEndian) { out.append(contentsOf: $0) } }
    func u16(_ v: Int) { withUnsafeBytes(of: UInt16(v).littleEndian) { out.append(contentsOf: $0) } }
    out.append(contentsOf: Array("RIFF".utf8))
    u32(36 + pcm16.count)
    out.append(contentsOf: Array("WAVEfmt ".utf8))
    u32(16)
    u16(1)  // PCM
    u16(channels)
    u32(sampleRate)
    u32(sampleRate * channels * 2)
    u16(channels * 2)
    u16(16)
    out.append(contentsOf: Array("data".utf8))
    u32(pcm16.count)
    out.append(pcm16)
    return out
  }
}

/// multipart/form-data, RFC 7578: text fields and one file.
enum Multipart {
  static func encode(boundary: String, fields: [(String, String)], file: (name: String, filename: String, type: String, data: Data)) -> Data {
    var out = Data()
    for (name, value) in fields {
      out.append(Data("--\(boundary)\r\nContent-Disposition: form-data; name=\"\(name)\"\r\n\r\n\(value)\r\n".utf8))
    }
    out.append(Data("--\(boundary)\r\nContent-Disposition: form-data; name=\"\(file.name)\"; filename=\"\(file.filename)\"\r\nContent-Type: \(file.type)\r\n\r\n".utf8))
    out.append(file.data)
    out.append(Data("\r\n--\(boundary)--\r\n".utf8))
    return out
  }
}
