// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "persephone-live",
    platforms: [.macOS(.v13)],
    targets: [
        // Text stitching and message framing live in their own target so they
        // can be tested without MacWhisper or Chrome running.
        .target(name: "LiveCore"),
        .executableTarget(name: "persephone-live", dependencies: ["LiveCore"]),
        // Fixtures are recordings of what MacWhisper's captions panel showed, read by read.
        .testTarget(name: "LiveCoreTests", dependencies: ["LiveCore"], resources: [.copy("Fixtures")]),
    ]
)
