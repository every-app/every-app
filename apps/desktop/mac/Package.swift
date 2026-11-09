// swift-tools-version: 6.2
import PackageDescription

let package = Package(
  name: "EveryAppHelper",
  platforms: [.macOS(.v15)],
  products: [
    .executable(name: "everyapp-helper", targets: ["everyapp-helper"]),
  ],
  targets: [
    // No hardware: the API client, segment batching, echo dedupe, resampling, turn detection,
    // chunking, WAV. Tested by `./scripts/test.sh`.
    .target(
      name: "HelperCore",
      path: "Sources/HelperCore",
      swiftSettings: [.swiftLanguageMode(.v5)]
    ),
    // Capture (mic, Core Audio tap), the Realtime sockets and the chunk fallback, the recording
    // pipeline, call detection, and the helper protocol. No UI, no Keychain. Used by everyapp-helper;
    // the hardware-free parts are tested with fakes.
    .target(
      name: "HelperRecording",
      dependencies: ["HelperCore"],
      path: "Sources/HelperRecording",
      swiftSettings: [.swiftLanguageMode(.v5)]
    ),
    // The headless helper the Electron app spawns: protocol v1 over stdin/stdout.
    .executableTarget(
      name: "everyapp-helper",
      dependencies: ["HelperRecording"],
      path: "Sources/everyapp-helper",
      swiftSettings: [.swiftLanguageMode(.v5)]
    ),
    // Drives the API client through a meeting against a running web/ with a bearer token (no
    // audio, no Keychain).
    .executableTarget(
      name: "everyapp-smoke",
      dependencies: ["HelperCore"],
      path: "Sources/everyapp-smoke",
      swiftSettings: [.swiftLanguageMode(.v5)]
    ),
    .testTarget(
      name: "HelperCoreTests",
      dependencies: ["HelperCore"],
      path: "Tests/HelperCoreTests",
      swiftSettings: [.swiftLanguageMode(.v5)]
    ),
    .testTarget(
      name: "HelperRecordingTests",
      dependencies: ["HelperCore", "HelperRecording"],
      path: "Tests/HelperRecordingTests",
      swiftSettings: [.swiftLanguageMode(.v5)]
    ),
  ]
)
