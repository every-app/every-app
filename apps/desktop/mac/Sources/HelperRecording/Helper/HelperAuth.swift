import Foundation
import HelperCore

/// The access token the app handed the helper. On a 401 it asks the app for a new one
/// (`token.needed`) and waits for `token.update`; the API client then retries the request once.
public actor HelperAuth: AuthProvider {
  public nonisolated let appURL: URL
  private var token: String
  private var waiters: [CheckedContinuation<String?, Never>] = []
  private var closed = false
  private var cycle = 0
  private let timeout: Duration
  private let onTokenNeeded: @Sendable () -> Void

  public init(appURL: URL, token: String, timeout: Duration = .seconds(60), onTokenNeeded: @escaping @Sendable () -> Void) {
    self.appURL = appURL
    self.token = token
    self.timeout = timeout
    self.onTokenNeeded = onTokenNeeded
  }

  public func accessToken() async throws -> String { token }

  public func tokenRejected(_ rejected: String) async throws -> String {
    if closed { throw AuthError.signedOut }
    // The app already sent a newer one.
    if rejected != token { return token }
    let first = waiters.isEmpty
    let renewed: String? = await withCheckedContinuation { continuation in
      waiters.append(continuation)
      if first {
        cycle += 1
        let current = cycle
        onTokenNeeded()
        let timeout = self.timeout
        Task { [weak self] in
          try? await Task.sleep(for: timeout)
          await self?.expire(current)
        }
      }
    }
    guard let renewed else { throw AuthError.signedOut }
    return renewed
  }

  /// `token.update`.
  public func update(_ newToken: String) {
    token = newToken
    resumeAll(newToken)
  }

  /// No more tokens are coming (the app went away, or the recording ended): fail anyone
  /// waiting, and later 401s at once. The current token is still used.
  public func close() {
    closed = true
    resumeAll(nil)
  }

  private func expire(_ waited: Int) {
    guard waited == cycle else { return }
    resumeAll(nil)
  }

  private func resumeAll(_ value: String?) {
    let pending = waiters
    waiters = []
    for waiter in pending { waiter.resume(returning: value) }
  }
}
