// swift-tools-version: 6.2
import PackageDescription

let package = Package(
    name: "RelayCore",
    platforms: [.iOS(.v26)],
    products: [.library(name: "RelayCore", targets: ["RelayCore"])],
    targets: [
        .target(name: "RelayCore", path: "RelayCore"),
        .testTarget(name: "RelayCoreTests", dependencies: ["RelayCore"], path: "RelayCoreTests"),
    ]
)
