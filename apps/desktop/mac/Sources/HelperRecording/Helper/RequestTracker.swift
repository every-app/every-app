import Foundation

/// Counts requests being handled, so an exit can let them answer without being held up by one
/// that is only waiting: a mic permission prompt nobody will click, a key fetch for an app that
/// went away. Recording state is made safe by `HelperServer.shutdown()` first; this is only
/// about getting already-read requests their answers.
@MainActor
public final class RequestTracker {
  public nonisolated static let defaultGrace: Duration = .milliseconds(250)

  public private(set) var pending = 0
  private var finishDrain: ((Bool) -> Void)?
  private let sleep: @Sendable (Duration) async -> Void

  public init(sleep: @escaping @Sendable (Duration) async -> Void = { try? await Task.sleep(for: $0) }) {
    self.sleep = sleep
  }

  public func begin() { pending += 1 }

  public func end() {
    pending = max(0, pending - 1)
    if pending == 0 { finishDrain?(true) }
  }

  /// Waits until nothing is pending or `grace` has passed. True when everything answered.
  public func drain(grace: Duration = RequestTracker.defaultGrace) async -> Bool {
    if pending == 0 { return true }
    return await withCheckedContinuation { (continuation: CheckedContinuation<Bool, Never>) in
      finishDrain = { [weak self] drained in
        self?.finishDrain = nil
        continuation.resume(returning: drained)
      }
      let sleep = self.sleep
      Task { @MainActor [weak self] in
        await sleep(grace)
        self?.finishDrain?(false)
      }
    }
  }
}
