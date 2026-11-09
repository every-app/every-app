import Foundation

public enum AuthError: Error, LocalizedError, Equatable {
  /// The token is gone, expired or revoked and can't be renewed: sign in again.
  case signedOut
  case message(String)

  public var errorDescription: String? {
    switch self {
    case .signedOut: "You're signed out. Sign in again."
    case .message(let m): m
    }
  }
}

/// Hands the API client a bearer token, whatever kind of sign-in made it.
public protocol AuthProvider: Sendable {
  var appURL: URL { get }
  /// A token good for at least the next minute.
  func accessToken() async throws -> String
  /// The server refused `token` with 401: renew if possible, else throw `.signedOut`.
  func tokenRejected(_ token: String) async throws -> String
}

/// The interim sign-in: a pasted personal access token. Nothing to renew.
public struct AccessTokenAuthProvider: AuthProvider {
  public let appURL: URL
  let token: String

  public init(appURL: URL, token: String) {
    self.appURL = appURL
    self.token = token
  }

  public func accessToken() async throws -> String { token }
  public func tokenRejected(_ token: String) async throws -> String { throw AuthError.signedOut }
}
