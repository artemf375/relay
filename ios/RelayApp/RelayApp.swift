import SwiftUI

@main
struct RelayApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @StateObject private var model = AppModel()
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            Group {
                if model.isPaired { InboxView() }
                else { PairingView() }
            }
            .environmentObject(model)
            .onChange(of: scenePhase) { _, phase in
                if phase == .active { Task { await model.becameActive() } }
            }
        }
    }
}
