import Foundation

/// Any JSON value, so requests and events stay Sendable and round-trip ids exactly.
public enum JSONValue: Sendable, Equatable, Codable, ExpressibleByStringLiteral, ExpressibleByIntegerLiteral,
  ExpressibleByBooleanLiteral, ExpressibleByDictionaryLiteral, ExpressibleByArrayLiteral, ExpressibleByFloatLiteral
{
  case null
  case bool(Bool)
  case int(Int)
  case double(Double)
  case string(String)
  case array([JSONValue])
  case object([String: JSONValue])

  public init(stringLiteral value: String) { self = .string(value) }
  public init(integerLiteral value: Int) { self = .int(value) }
  public init(booleanLiteral value: Bool) { self = .bool(value) }
  public init(floatLiteral value: Double) { self = .double(value) }
  public init(arrayLiteral elements: JSONValue...) { self = .array(elements) }
  public init(dictionaryLiteral elements: (String, JSONValue)...) {
    self = .object(Dictionary(elements, uniquingKeysWith: { $1 }))
  }

  public init(from decoder: Decoder) throws {
    let c = try decoder.singleValueContainer()
    if c.decodeNil() {
      self = .null
    } else if let v = try? c.decode(Bool.self) {
      self = .bool(v)
    } else if let v = try? c.decode(Int.self) {
      self = .int(v)
    } else if let v = try? c.decode(Double.self) {
      self = .double(v)
    } else if let v = try? c.decode(String.self) {
      self = .string(v)
    } else if let v = try? c.decode([JSONValue].self) {
      self = .array(v)
    } else {
      self = .object(try c.decode([String: JSONValue].self))
    }
  }

  public func encode(to encoder: Encoder) throws {
    var c = encoder.singleValueContainer()
    switch self {
    case .null: try c.encodeNil()
    case .bool(let v): try c.encode(v)
    case .int(let v): try c.encode(v)
    case .double(let v): try c.encode(v)
    case .string(let v): try c.encode(v)
    case .array(let v): try c.encode(v)
    case .object(let v): try c.encode(v)
    }
  }

  public subscript(key: String) -> JSONValue? {
    if case .object(let o) = self { return o[key] }
    return nil
  }

  public var string: String? {
    if case .string(let s) = self { return s }
    return nil
  }

  public var bool: Bool? {
    if case .bool(let b) = self { return b }
    return nil
  }

  public var int: Int? {
    switch self {
    case .int(let i): i
    case .double(let d) where d == d.rounded(): Int(exactly: d)
    default: nil
    }
  }
}

/// One request line: `{ "id", "cmd", "params"? }`.
public struct HelperRequest: Sendable, Equatable {
  public var id: JSONValue
  public var cmd: String
  public var params: JSONValue

  public init(id: JSONValue, cmd: String, params: JSONValue = .object([:])) {
    self.id = id
    self.cmd = cmd
    self.params = params
  }
}

public struct HelperError: Error, Sendable, Equatable {
  public var code: String
  public var message: String

  public init(_ code: String, _ message: String) {
    self.code = code
    self.message = message
  }

  public static func badParams(_ message: String) -> HelperError { HelperError("bad_params", message) }
}

/// Newline-delimited JSON (docs/desktop-plan.md "Helper protocol (v1)"): requests in, one
/// response per request and id-less events out.
public enum HelperCodec {
  public static let protocolVersion = 1

  public enum DecodeFailure: Error, Equatable {
    /// Not JSON, or not an object. No id to answer to.
    case notJSON
    /// An object without a usable `cmd`; answer `id` (null if it had none).
    case badRequest(id: JSONValue, message: String)
  }

  public static func decode(_ line: String) -> Result<HelperRequest, DecodeFailure> {
    guard let value = try? JSONDecoder().decode(JSONValue.self, from: Data(line.utf8)), case .object(let o) = value else {
      return .failure(.notJSON)
    }
    let id = o["id"] ?? .null
    guard let cmd = o["cmd"]?.string, !cmd.isEmpty else { return .failure(.badRequest(id: id, message: "Missing cmd")) }
    switch id {
    case .int, .string: break
    default: return .failure(.badRequest(id: id, message: "id must be a number or a string"))
    }
    return .success(HelperRequest(id: id, cmd: cmd, params: params(o["params"])))
  }

  private static func params(_ value: JSONValue?) -> JSONValue {
    if case .object = value { return value! }
    return .object([:])
  }

  public static func encode(_ value: JSONValue) -> String {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
    // JSONValue always encodes.
    let data = (try? encoder.encode(value)) ?? Data("{}".utf8)
    return String(decoding: data, as: UTF8.self)
  }

  public static func success(id: JSONValue, result: JSONValue) -> String {
    encode(["id": id, "ok": true, "result": result])
  }

  public static func failure(id: JSONValue, _ error: HelperError) -> String {
    encode(["id": id, "ok": false, "error": ["code": .string(error.code), "message": .string(error.message)]])
  }

  public static func event(_ name: String, _ fields: [String: JSONValue] = [:]) -> String {
    var object = fields
    object["event"] = .string(name)
    return encode(.object(object))
  }
}
