// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "cleancopy-helper",
    platforms: [.macOS(.v12)],
    targets: [
        .executableTarget(name: "cleancopy-helper", path: "Sources/cleancopy-helper")
    ]
)
