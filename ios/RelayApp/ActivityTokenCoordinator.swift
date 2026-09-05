import ActivityKit
import Foundation
import RelayCore

@MainActor
final class ActivityTokenCoordinator {
    private static let observedActivityIDsKey = "relay.observedActivityIDs"
    private var rootTasks: [Task<Void, Never>] = []
    private var activityTasks: [String: [Task<Void, Never>]] = [:]
    private var observedActivityIDs = Set(
        UserDefaults.standard.stringArray(forKey: ActivityTokenCoordinator.observedActivityIDsKey) ?? []
    )

    func start(api: RelayAPI, environment: APNSEnvironment) {
        stop()
        for activity in Activity<RelayActivityAttributes>.activities {
            observe(activity, api: api, environment: environment)
        }
        rootTasks = [
            Task {
                if let token = Activity<RelayActivityAttributes>.pushToStartToken {
                    try? await api.register(DeviceTokenUpdate(
                        pushToStartToken: token.hex,
                        environment: environment,
                        capabilities: .liveActivityInteractionsV1
                    ))
                }
                for await token in Activity<RelayActivityAttributes>.pushToStartTokenUpdates {
                    try? await api.register(DeviceTokenUpdate(
                        pushToStartToken: token.hex,
                        environment: environment,
                        capabilities: .liveActivityInteractionsV1
                    ))
                }
            },
            Task {
                for await activity in Activity<RelayActivityAttributes>.activityUpdates {
                    self.observe(activity, api: api, environment: environment)
                }
            },
        ]
    }

    func reconcile(api: RelayAPI, environment: APNSEnvironment) async {
        let localActivities = Activity<RelayActivityAttributes>.activities
        let localIDs = Set(localActivities.map(\.attributes.relayActivityId))
        for activity in localActivities {
            observe(activity, api: api, environment: environment)
            if let token = activity.pushToken {
                try? await api.registerActivityToken(.init(
                    activityPushToken: token.hex,
                    activityId: activity.attributes.relayActivityId,
                    environment: environment
                ))
            }
        }
        guard let serverActivities = try? await api.activities() else { return }
        for activity in serverActivities
        where observedActivityIDs.contains(activity.id) && !localIDs.contains(activity.id) {
            if activity.state == "active" {
                do {
                    try await api.reportActivityDismissed(activityID: activity.id)
                    forget(activity.id)
                } catch {}
            } else {
                do {
                    try await api.removeActivityToken(activityID: activity.id)
                    forget(activity.id)
                } catch {}
            }
        }
    }

    private func observe(
        _ activity: Activity<RelayActivityAttributes>,
        api: RelayAPI,
        environment: APNSEnvironment
    ) {
        let id = activity.attributes.relayActivityId
        guard activityTasks[id] == nil else { return }
        remember(id)
        let tokenTask = Task {
            if let token = activity.pushToken {
                try? await api.registerActivityToken(.init(
                    activityPushToken: token.hex,
                    activityId: id,
                    environment: environment
                ))
            }
            for await token in activity.pushTokenUpdates {
                try? await api.registerActivityToken(.init(
                    activityPushToken: token.hex,
                    activityId: id,
                    environment: environment
                ))
            }
        }
        let stateTask = Task {
            for await state in activity.activityStateUpdates {
                switch state {
                case .dismissed:
                    do {
                        try await api.reportActivityDismissed(activityID: id)
                        self.forget(id)
                    } catch {}
                    self.finishObserving(id)
                    return
                case .ended:
                    do {
                        try await api.removeActivityToken(activityID: id)
                        self.forget(id)
                    } catch {}
                    self.finishObserving(id)
                    return
                default: break
                }
            }
        }
        activityTasks[id] = [tokenTask, stateTask]
    }

    private func finishObserving(_ id: String) {
        activityTasks.removeValue(forKey: id)?.forEach { $0.cancel() }
    }

    private func remember(_ id: String) {
        guard observedActivityIDs.insert(id).inserted else { return }
        persistObservedActivityIDs()
    }

    private func forget(_ id: String) {
        guard observedActivityIDs.remove(id) != nil else { return }
        persistObservedActivityIDs()
    }

    private func persistObservedActivityIDs() {
        UserDefaults.standard.set(Array(observedActivityIDs), forKey: Self.observedActivityIDsKey)
    }

    func reset() {
        stop()
        observedActivityIDs.removeAll()
        UserDefaults.standard.removeObject(forKey: Self.observedActivityIDsKey)
    }

    func stop() {
        rootTasks.forEach { $0.cancel() }
        rootTasks.removeAll()
        activityTasks.values.flatMap { $0 }.forEach { $0.cancel() }
        activityTasks.removeAll()
    }
}

private extension Data { var hex: String { map { String(format: "%02x", $0) }.joined() } }
