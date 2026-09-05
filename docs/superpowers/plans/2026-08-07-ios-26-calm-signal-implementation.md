# Relay iOS 26 Calm Signal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a cohesive Calm Signal redesign across Relay pairing, inbox, Live Activity, Dynamic Island, and app icon as an iOS 26+ internal TestFlight build.

**Architecture:** Keep `AppModel`, `NotificationCoordinator`, and `RelayAPI` as the state/transport boundary while extracting small presentation values and focused SwiftUI components from the current monolithic screens. Put semantic colors and the reusable signal mark in `RelayShared` so the app and widget render one identity, and add an app-hosted test target for pairing, grouping, and response-state logic. Preserve the server contract and durable response queue unchanged.

**Tech Stack:** Swift 6, SwiftUI, Combine `ObservableObject`, ActivityKit, WidgetKit, App Intents, Swift Testing/XCTest, XcodeGen 2.45.4, Icon Composer, SF Symbols, GitHub Actions, App Store Connect CLI.

## Global Constraints

- The application and Swift package deployment targets are iOS 26.0.
- Do not add `if #available` compatibility branches, legacy styling, migrations, or fallback paths for releases earlier than iOS 26.
- Preserve one user, one paired iPhone, one active Live Activity, and the existing phone-cannot-initiate-instructions boundary.
- Do not change server endpoints, database schema, deployment behavior, credentials, APNs payload contracts, or response-queue durability semantics.
- Use standard SwiftUI navigation and controls so the system supplies its native Liquid Glass treatment; apply custom glass only to the few important controls identified below.
- Use semantic asset colors, SF Symbols, San Francisco text styles, Dynamic Type, and system accessibility settings. Never encode state by color alone.
- Do not add a tab bar, Activity history screen, dashboard, analytics, account system, or unrelated settings.
- Increment `CURRENT_PROJECT_VERSION` from `5` to `6`; keep `MARKETING_VERSION` at `1.0.1`.
- Keep simulator, signed archive, App Store Connect, and physical iPhone evidence separate.
- Preserve the user's existing `AGENTS.md` change and never stage `.superpowers/` visual-companion files.

---

## File Structure

### Shared identity

- Create `ios/RelayShared/CalmSignal.xcassets/Contents.json`: shared asset catalogue metadata.
- Create `ios/RelayShared/CalmSignal.xcassets/CalmSage.colorset/Contents.json`: adaptive primary-action color.
- Create `ios/RelayShared/CalmSignal.xcassets/CalmCanvas.colorset/Contents.json`: adaptive app background.
- Create `ios/RelayShared/CalmSignal.xcassets/CalmCard.colorset/Contents.json`: adaptive content surface.
- Create `ios/RelayShared/CalmSignal.xcassets/CalmStone.colorset/Contents.json`: adaptive secondary surface.
- Create `ios/RelayShared/CalmSignalStyle.swift`: semantic color and status-style namespace shared by app and widget.
- Create `ios/RelayShared/RelaySignalMark.swift`: scalable SwiftUI relay/signal identity mark.

### App presentation

- Create `ios/RelayApp/PairingInput.swift`: pure pairing normalization and validation.
- Create `ios/RelayApp/InboxPresentation.swift`: inbox grouping, response submission state, and display mappings.
- Create `ios/RelayApp/InteractionCard.swift`: one prompt card and its kind-specific controls.
- Create `ios/RelayApp/NotificationCard.swift`: compact earlier-notification card.
- Modify `ios/RelayApp/PairingView.swift`: Calm Signal pairing container and accessible form.
- Modify `ios/RelayApp/InboxView.swift`: section composition, loading/error/empty states, refresh, permission notice, and unpair confirmation.
- Modify `ios/RelayApp/AppModel.swift`: per-surface errors, per-interaction submission state, notification authorization state, and truthful queued/recorded outcomes.
- Modify `ios/RelayApp/NotificationCoordinator.swift`: report whether an inbox response was recorded remotely or remains durably queued.
- Modify `ios/RelayApp/RelayApp.swift`: remove the generic global error alert and retain only root-state composition.

### Tests and project configuration

- Create `ios/RelayAppTests/PairingInputTests.swift`: pairing validation cases.
- Create `ios/RelayAppTests/InboxPresentationTests.swift`: grouping, ordering, display, and action-state cases.
- Create `ios/RelayAppTests/InteractionSubmissionTrackerTests.swift`: sending/queued/recorded/failure transitions.
- Modify `ios/Package.swift`: iOS 26 package floor.
- Modify `ios/project.yml`: iOS 26 app/widget floor, RelayAppTests target, build 6, and icon input.
- Modify `.github/workflows/ci.yml`: use a runner/Xcode combination with an iOS 26 SDK and execute app tests.

### Live Activity and icon

- Modify `ios/RelayWidget/RelayLiveActivityWidget.swift`: Calm Signal Lock Screen and Dynamic Island composition.
- Create `ios/RelayWidget/RelayLiveActivityComponents.swift`: focused task, checkpoint, acknowledgement, and status views.
- Create `ios/RelayWidget/RelayLiveActivityPreviews.swift`: task/checkpoint/acknowledged visual fixtures.
- Create `ios/RelayApp/IconArtwork/background.svg`: warm adaptive icon foundation source.
- Create `ios/RelayApp/IconArtwork/rear-signal.svg`: rear sage signal layer source.
- Create `ios/RelayApp/IconArtwork/front-signal.svg`: foreground relay mark source.
- Create `ios/RelayApp/AppIcon.icon`: Icon Composer document with Default, Dark, and Mono annotations.
- Remove `ios/RelayApp/Assets.xcassets/AppIcon.appiconset/Contents.json` and `AppIcon.png` only after the `.icon` build succeeds.

### Documentation and release

- Modify `docs/operations/apple-testflight.md`: iOS 26 toolchain, Icon Composer, build 6, and visual/device gates.
- Modify `docs/operations/physical-acceptance.md`: add Calm Signal appearance and accessibility checks.

---

### Task 1: Adopt the iOS 26 Platform Floor and Test Harness

**Files:**
- Modify: `ios/Package.swift`
- Modify: `ios/project.yml`
- Modify: `.github/workflows/ci.yml`
- Create: `ios/RelayAppTests/PairingInputTests.swift`
- Create: `ios/RelayApp/PairingInput.swift`

**Interfaces:**
- Produces: `PairingInput` with `normalizedURL`, `normalizedCode`, and `validationError`.
- Produces: `PairingValidationError: LocalizedError, Equatable` with `.missingURL`, `.invalidHTTPSURL`, and `.invalidCodeLength`.
- Produces: an Xcode unit-test target named `RelayAppTests` hosted by `Relay`.

- [ ] **Step 1: Run the untouched Swift baseline**

Run:

```bash
cd ios
swift test --disable-sandbox --scratch-path /tmp/relay-calm-signal-swift-baseline
xcodegen generate
xcodebuild -project Relay.xcodeproj -scheme Relay -destination 'generic/platform=iOS Simulator' -derivedDataPath /tmp/relay-calm-signal-baseline CODE_SIGNING_ALLOWED=NO build
```

Expected: existing RelayCore tests pass and the current iOS 17.2 app builds. Record any simulator-service failure separately from compilation.

- [ ] **Step 2: Write the failing pairing-validation test**

Add `PairingInputTests.swift`:

```swift
import Testing
@testable import Relay

@Test func pairingInputNormalizesAndValidates() {
    #expect(PairingInput(url: " relay.example.com ", code: " ab12cd34 ").validationError == .invalidHTTPSURL)
    #expect(PairingInput(url: "https://relay.example.com/", code: " ab12cd34 ").normalizedCode == "AB12CD34")
    #expect(PairingInput(url: "https://relay.example.com/", code: "ABC").validationError == .invalidCodeLength)
    #expect(PairingInput(url: "https://relay.example.com/", code: "AB12CD34").validationError == nil)
}
```

- [ ] **Step 3: Add the app test target and verify the test fails**

In `ios/project.yml`, add:

```yaml
  RelayAppTests:
    type: bundle.unit-test
    platform: iOS
    sources:
      - RelayAppTests
    dependencies:
      - target: Relay
    settings:
      base:
        PRODUCT_BUNDLE_IDENTIFIER: com.example.relay.tests
        CODE_SIGN_STYLE: Automatic
```

Run:

```bash
cd ios
xcodegen generate
xcodebuild test -project Relay.xcodeproj -scheme Relay -destination 'platform=iOS Simulator,name=iPhone 17,OS=26.2' -derivedDataPath /tmp/relay-calm-signal-app-tests CODE_SIGNING_ALLOWED=NO
```

Expected: FAIL because `PairingInput` does not exist. If iOS 26.2 is not installed, use an available iOS 26.x iPhone destination and record the exact destination.

- [ ] **Step 4: Implement the minimal pairing input type**

Add `PairingInput.swift` with this interface:

```swift
import Foundation

struct PairingInput: Equatable {
    var url: String
    var code: String

    var normalizedURL: String { url.trimmingCharacters(in: .whitespacesAndNewlines) }
    var normalizedCode: String { code.trimmingCharacters(in: .whitespacesAndNewlines).uppercased() }

    var validationError: PairingValidationError? {
        guard !normalizedURL.isEmpty else { return .missingURL }
        guard let value = URL(string: normalizedURL), value.scheme == "https", value.host != nil else {
            return .invalidHTTPSURL
        }
        guard normalizedCode.count == 8 else { return .invalidCodeLength }
        return nil
    }
}

enum PairingValidationError: LocalizedError, Equatable {
    case missingURL, invalidHTTPSURL, invalidCodeLength

    var errorDescription: String? {
        switch self {
        case .missingURL: "Enter your Relay address."
        case .invalidHTTPSURL: "Relay requires a complete HTTPS address."
        case .invalidCodeLength: "Enter the eight-character pairing code."
        }
    }
}
```

- [ ] **Step 5: Raise the platform floor and make CI select a compatible Xcode**

Change `Package.swift` to `.iOS(.v26)` and `IPHONEOS_DEPLOYMENT_TARGET` to `26.0`. Keep build number 5 until Task 7.

Change the iOS CI job to `runs-on: macos-26`, add `xcodebuild -version`, keep RelayCore tests, generate the project, run `RelayAppTests` on an available iOS 26 simulator, and then run the generic simulator build. Do not pin the current local Xcode 27 beta in CI; the macOS 26 runner provides stable Xcode 26.x images suitable for the iOS 26 floor.

- [ ] **Step 6: Verify and commit**

Run:

```bash
cd ios
swift test --disable-sandbox --scratch-path /tmp/relay-calm-signal-swift-task1
xcodegen generate
xcodebuild test -project Relay.xcodeproj -scheme Relay -destination 'platform=iOS Simulator,name=iPhone 17,OS=26.2' -derivedDataPath /tmp/relay-calm-signal-task1 CODE_SIGNING_ALLOWED=NO
xcodebuild -project Relay.xcodeproj -scheme Relay -destination 'generic/platform=iOS Simulator' -derivedDataPath /tmp/relay-calm-signal-task1-build CODE_SIGNING_ALLOWED=NO build
```

Expected: all Swift tests pass and both app/widget compile for iOS 26.

```bash
git add ios/Package.swift ios/project.yml ios/RelayApp/PairingInput.swift ios/RelayAppTests/PairingInputTests.swift .github/workflows/ci.yml
git commit -m "build: require iOS 26 for Relay"
```

### Task 2: Build the Shared Calm Signal Identity

**Files:**
- Create: `ios/RelayShared/CalmSignal.xcassets/Contents.json`
- Create: `ios/RelayShared/CalmSignal.xcassets/CalmSage.colorset/Contents.json`
- Create: `ios/RelayShared/CalmSignal.xcassets/CalmCanvas.colorset/Contents.json`
- Create: `ios/RelayShared/CalmSignal.xcassets/CalmCard.colorset/Contents.json`
- Create: `ios/RelayShared/CalmSignal.xcassets/CalmStone.colorset/Contents.json`
- Create: `ios/RelayShared/CalmSignalStyle.swift`
- Create: `ios/RelayShared/RelaySignalMark.swift`
- Create: `ios/RelayAppTests/CalmSignalStyleTests.swift`

**Interfaces:**
- Produces: `CalmSignalTone` cases `.neutral`, `.primary`, `.success`, `.warning`, `.destructive`, `.unavailable`.
- Produces: `CalmSignalStatusStyle` with `symbol`, `label`, and `tone`.
- Produces: `RelaySignalMark` as a resolution-independent SwiftUI view.
- Produces: `Color.calmSage`, `.calmCanvas`, `.calmCard`, and `.calmStone` backed by shared assets.

- [ ] **Step 1: Write the failing semantic-style tests**

```swift
import Testing
@testable import Relay

@Test func calmSignalStatusStylesDoNotDependOnColorAlone() {
    #expect(CalmSignalStatusStyle.pending.symbol == "hourglass")
    #expect(CalmSignalStatusStyle.pending.label == "Waiting")
    #expect(CalmSignalStatusStyle.recorded.tone == .success)
    #expect(CalmSignalStatusStyle.queued.symbol == "arrow.triangle.2.circlepath")
    #expect(CalmSignalStatusStyle.failed.tone == .destructive)
}
```

Run the Task 1 `xcodebuild test` command.
Expected: FAIL because the styles do not exist.

- [ ] **Step 2: Add adaptive semantic colors**

Create asset colors with sRGB components:

```text
CalmSage:  light #527369, dark #8DB5A8, high-contrast light #365B51, high-contrast dark #B5D9CD
CalmCanvas: light #F6F2EC, dark #171916, high-contrast light #FFFFFF, high-contrast dark #000000
CalmCard: light #FFFAF4, dark #222620, high-contrast light #FFFFFF, high-contrast dark #111310
CalmStone: light #E7E1DA, dark #30342E, high-contrast light #D7CEC4, high-contrast dark #41473E
```

Each colorset contains `luminosity: dark` and `contrast: high` appearances in addition to the default. Set `idiom` to `universal` and `author` to `xcode`.

- [ ] **Step 3: Implement named styles and the signal mark**

In `CalmSignalStyle.swift`, map semantic status values to SF Symbol plus label plus tone, and expose asset-backed colors. Use system `.green`, `.orange`, and `.red` for success/warning/destructive rendering; use sage only for the brand/primary tone.

In `RelaySignalMark.swift`, compose a central rounded bridge and two offset signal arcs using SwiftUI `Shape`/`Canvas`, `containerRelativeFrame`, and semantic colors. The mark must render at 32, 64, and 160 points without text or raster content and provide the accessibility label “Relay”.

- [ ] **Step 4: Verify shared target membership and appearances**

Run the Task 1 app tests and generic simulator build. In Xcode previews, render the mark and palette in light, dark, increased-contrast, and Reduce Transparency environments. Confirm both Relay and RelayWidget compile the shared asset catalogue once.

- [ ] **Step 5: Commit**

```bash
git add ios/RelayShared/CalmSignal.xcassets ios/RelayShared/CalmSignalStyle.swift ios/RelayShared/RelaySignalMark.swift ios/RelayAppTests/CalmSignalStyleTests.swift
git commit -m "feat: add Calm Signal design system"
```

### Task 3: Make Inbox Presentation and Response Outcomes Truthful

**Files:**
- Create: `ios/RelayApp/InboxPresentation.swift`
- Create: `ios/RelayAppTests/InboxPresentationTests.swift`
- Create: `ios/RelayAppTests/InteractionSubmissionTrackerTests.swift`
- Modify: `ios/RelayApp/NotificationCoordinator.swift`
- Modify: `ios/RelayApp/AppModel.swift`

**Interfaces:**
- Produces: `ResponseDeliveryDisposition: Equatable` with `.recorded` and `.queued`.
- Produces: `InteractionSubmissionState: Equatable` with `.idle`, `.sending`, `.queued`, `.recorded`, and `.failed(String)`.
- Produces: `InteractionSubmissionTracker` keyed by interaction ID.
- Produces: `InboxPresentation` with `waiting`, `earlierInteractions`, and `notifications`, each newest first.
- Changes: `NotificationCoordinator.handleInbox(...) async throws -> ResponseDeliveryDisposition`.
- Changes: `NotificationCoordinator.flush() async throws -> Set<String>` returning IDs removed after confirmed server submission.

- [ ] **Step 1: Write failing grouping and response-state tests**

Decode interaction fixtures through `RelayJSONDecoder.make()` and assert:

```swift
let presentation = InboxPresentation(interactions: interactions, notifications: notifications)
#expect(presentation.waiting.map(\.id) == ["pending-new", "pending-old"])
#expect(presentation.earlierInteractions.map(\.id) == ["done-new", "done-old"])
#expect(presentation.notifications.map(\.id) == ["note-new", "note-old"])
```

Add tracker tests:

```swift
var tracker = InteractionSubmissionTracker()
tracker.start("int_1")
#expect(tracker["int_1"] == .sending)
tracker.finish("int_1", disposition: .queued)
#expect(tracker["int_1"] == .queued)
tracker.fail("int_2", message: "Queue unavailable")
#expect(tracker["int_2"] == .failed("Queue unavailable"))
```

Run app tests.
Expected: FAIL because the presentation and tracker types do not exist.

- [ ] **Step 2: Implement pure presentation values**

Implement sorting by `createdAt` descending. `waiting` contains only `.pending`; `earlierInteractions` contains all other statuses including unsupported future statuses. Provide computed symbol/label/action availability values without storing a second copy of server outcome data.

- [ ] **Step 3: Return recorded versus queued from the coordinator**

Refactor `flush` to return the set of interaction IDs successfully submitted and durably removed. It must continue attempting every pending item, continue leaving transient failures queued, and continue throwing only when queue access/removal persistence fails.

Implement:

```swift
func handleInbox(interactionID: String, response: InteractionResponse) async throws -> ResponseDeliveryDisposition {
    let queue = try requireQueue()
    try queue.enqueue(PendingResponse(interactionID: interactionID, response: response))
    let completed = try await flush()
    return completed.contains(interactionID) ? .recorded : .queued
}
```

Notification-action callers may discard the returned set; inbox callers must display it.

- [ ] **Step 4: Add per-interaction state to AppModel**

Replace one global response busy state with:

```swift
@Published private(set) var submissionStates: [String: InteractionSubmissionState] = [:]
@Published private(set) var inboxErrorMessage: String?
@Published private(set) var pairingErrorMessage: String?
@Published private(set) var unpairErrorMessage: String?
```

`respond` starts only the selected interaction, records queued/recorded/failed state, and then refreshes. A successful server refresh removes transient tracker state only after the corresponding interaction is terminal; queued pending interactions retain `.queued`.

- [ ] **Step 5: Verify queue invariants and commit**

Run:

```bash
cd ios
swift test --disable-sandbox --scratch-path /tmp/relay-calm-signal-swift-task3
xcodegen generate
xcodebuild test -project Relay.xcodeproj -scheme Relay -destination 'platform=iOS Simulator,name=iPhone 17,OS=26.2' -derivedDataPath /tmp/relay-calm-signal-task3 CODE_SIGNING_ALLOWED=NO
```

Expected: RelayCore queue tests and all app tests pass.

```bash
git add ios/RelayApp/InboxPresentation.swift ios/RelayApp/NotificationCoordinator.swift ios/RelayApp/AppModel.swift ios/RelayAppTests/InboxPresentationTests.swift ios/RelayAppTests/InteractionSubmissionTrackerTests.swift
git commit -m "feat: expose truthful inbox response states"
```

### Task 4: Redesign Pairing as a Focused Calm Signal Flow

**Files:**
- Modify: `ios/RelayApp/PairingView.swift`
- Modify: `ios/RelayApp/AppModel.swift`
- Modify: `ios/RelayApp/RelayApp.swift`

**Interfaces:**
- Consumes: `PairingInput`, `RelaySignalMark`, semantic Calm Signal colors, `AppModel.isBusy`, and `AppModel.pairingErrorMessage`.
- Produces: `PairingContent`, a presentation-only view accepting input binding, busy/error values, and a pair action; `PairingView` remains the environment-object container.
- Produces: `AppModel.clearPairingError()` for edit-driven removal of a stale server error.

- [ ] **Step 1: Add failing validation-state assertions**

Extend `PairingInputTests` to assert whitespace normalization, an HTTPS URL with no host is rejected, lowercase code becomes uppercase, and the button is enabled only when `validationError == nil`.

Run app tests.
Expected: the new clear-error behavior fails before AppModel/View wiring is changed.

- [ ] **Step 2: Implement the pairing composition**

Replace `Form` with an edge-to-edge warm canvas containing:

```text
RelaySignalMark (64 pt)
“Relay” title
“Private decisions and progress, delivered from your agent.” supporting copy
Server address field
Pairing code field
Inline validation/server error
Full-width “Pair iPhone” button
Short single-use-code explanation
```

Use `NavigationStack`, `safeAreaPadding`, semantic text styles, URL keyboard behavior, `.textInputAutocapitalization(.never)` for URL, `.textInputAutocapitalization(.characters)` plus monospaced text for code, submit-label progression, and keyboard focus movement. Use `.buttonStyle(.glassProminent)` only for the primary pairing button, tint it with `Color.calmSage`, and show `ProgressView` plus “Pairing…” while busy.

- [ ] **Step 3: Localize errors and remove the global alert**

Make `AppModel.pair` consume normalized values, set only `pairingErrorMessage`, and preserve input on recoverable failure. Add `clearPairingError()` and call it from field `onChange` handlers so editing clears the stale pairing error without clearing inbox or unpair errors. Remove the root `.alert` from `RelayApp`; pairing errors render below the fields with `exclamationmark.circle` and an accessibility announcement.

- [ ] **Step 4: Preview and verify pairing states**

Add previews in `PairingView.swift` for idle, invalid code, server error, and busy. Inspect light/dark, Dynamic Type `accessibility3`, Increased Contrast, Reduce Transparency, landscape, and keyboard appearance. Run app tests and generic simulator build.

- [ ] **Step 5: Commit**

```bash
git add ios/RelayApp/PairingView.swift ios/RelayApp/AppModel.swift ios/RelayApp/RelayApp.swift ios/RelayAppTests/PairingInputTests.swift
git commit -m "feat: redesign Relay pairing"
```

### Task 5: Redesign the Inbox, Cards, Errors, and Unpairing

**Files:**
- Create: `ios/RelayApp/InteractionCard.swift`
- Create: `ios/RelayApp/NotificationCard.swift`
- Modify: `ios/RelayApp/InboxView.swift`
- Modify: `ios/RelayApp/AppModel.swift`
- Modify: `ios/RelayAppTests/InboxPresentationTests.swift`

**Interfaces:**
- Produces: `InteractionCard(interaction:submissionState:reply:onRespond:)`.
- Produces: `NotificationCard(notification:)`.
- Produces: `NotificationAuthorizationState: Equatable` with `.notDetermined`, `.authorized`, `.provisional`, and `.denied`.
- Consumes: `InboxPresentation`, per-interaction submission states, surface-specific errors, and existing `AppModel` actions.

- [ ] **Step 1: Add failing card-state tests**

Test the pure display mapping for:

```text
pending + idle      => controls enabled, “Waiting”
pending + sending   => controls disabled, “Sending…”
pending + queued    => controls disabled, “Queued for retry”
terminal approved   => no controls, “Approved”
expired             => no controls, “Expired”
unsupported kind    => no controls, “Update Relay to answer this prompt.”
failed submission   => controls enabled for retry, explicit failure copy
```

Run app tests.
Expected: FAIL until display/action mapping covers every state.

- [ ] **Step 2: Implement focused cards**

`InteractionCard` uses a `VStack` with the status symbol/title header, full prompt, relative expiry when pending, status copy, and kind-specific controls. Use native prominent styling for the affirmative action, a bordered semantic destructive action for Deny, and neutral bordered styling for No. Text reply uses an axis-growing `TextField`, trims through `InteractionResponse.reply`, and disables Send for empty text.

Apply the Calm Card surface once around content. Do not apply glass to every card. Add `contentShape`, 44-point minimum controls, concise VoiceOver labels, and `sensoryFeedback(.success)` when the state moves to recorded. Respect Reduce Motion for symbol transitions.

`NotificationCard` shows title, body, optional HTTPS link via `Link`, status style, and relative timestamp without exposing raw server status capitalization as the only explanation.

- [ ] **Step 3: Compose inbox sections and truthful failure states**

Build one scrollable inbox with “Waiting for you” and “Earlier” headings. Pending prompts appear first, then terminal prompts and notifications in recency order. Preserve pull-to-refresh.

Render these exact top-level states:

```text
No content + no error: ContentUnavailableView “All quiet” / “Relay prompts and notifications will appear here.”
No content + refresh error: ContentUnavailableView with Retry button.
Existing content + refresh error: non-blocking inline banner above sections; existing content remains.
Notification authorization denied: inline banner with “Open Settings” action.
```

Query `UNUserNotificationCenter.notificationSettings()` when the app becomes active and expose `.authorized`, `.denied`, `.notDetermined`, or `.provisional` through AppModel. Do not represent permission denial as unpairing.

- [ ] **Step 4: Add safe unpair confirmation**

Keep Unpair in the trailing toolbar menu. Present a confirmation dialog with this consequence: “This removes this phone’s Relay access, saved credential, and pending local replies.” Make Cancel the safe default. Disable repeated unpair attempts while revocation is in progress. Show `unpairErrorMessage` inline or in an unpair-specific alert; retain the existing revoke-first behavior and resume coordinators after a failed revoke.

- [ ] **Step 5: Preview and verify the full state matrix**

Add previews for empty, load failure, approval, yes/no, text, sending, queued, completed, expired, unsupported, notification-permission denied, and unpair dialog. Inspect light/dark, 320-point width, landscape, `accessibility3`, Increased Contrast, Reduce Transparency, and Reduce Motion.

Run app tests and generic simulator build.

- [ ] **Step 6: Commit**

```bash
git add ios/RelayApp/InboxView.swift ios/RelayApp/InteractionCard.swift ios/RelayApp/NotificationCard.swift ios/RelayApp/AppModel.swift ios/RelayAppTests/InboxPresentationTests.swift
git commit -m "feat: redesign the Relay inbox"
```

### Task 6: Carry Calm Signal Through Live Activity and Dynamic Island

**Files:**
- Modify: `ios/RelayWidget/RelayLiveActivityWidget.swift`
- Create: `ios/RelayWidget/RelayLiveActivityComponents.swift`
- Create: `ios/RelayWidget/RelayLiveActivityPreviews.swift`
- Modify: `ios/RelayShared/CalmSignalStyle.swift`
- Modify: `ios/RelayAppTests/CalmSignalStyleTests.swift`

**Interfaces:**
- Consumes: unchanged `RelayActivityAttributes`, checkpoint intents, server accent color, and shared Calm Signal styles.
- Produces: focused `RelayTaskActivityView`, `RelayCheckpointActivityView`, `RelayAcknowledgedActivityView`, and `RelayActivityStatusView` components.

- [ ] **Step 1: Write failing Live Activity style tests**

Extend semantic-style tests to assert task, stale, ended, checkpoint, and acknowledged states map to distinct symbol/label/tone combinations. Confirm no state relies only on the server-provided hex accent.

Run app tests.
Expected: FAIL until all activity presentations have semantic styles.

- [ ] **Step 2: Split and restyle Lock Screen content**

Move the current private task/checkpoint/acknowledgement views into `RelayLiveActivityComponents.swift`. Use Calm Card/Canvas-compatible adaptive surfaces, sage for neutral progress, and semantic green/orange/red for completion/delay/decision results. Keep title, progress, detail, stale state, relative expiry, and result labels. Retain the `Color(hex:)` server-accent parser only for valid neutral task accents; invalid values fall back to Calm Sage.

Keep interactive `Button(intent:)` actions, `.requiresLocalDeviceAuthentication`, explicit Approve/Deny or Yes/No labels, disabled expiry behavior, and existing accessibility context. Do not change ActivityKit attributes, intent parameters, credential loading, response semantics, or APNs fields.

- [ ] **Step 3: Refine Dynamic Island regions**

Use the signal/status symbol in leading/minimal regions, monospaced progress in compact trailing for tasks, and the response indicator for checkpoints. Expanded layout keeps title centered and full controls in the bottom region. Verify compact labels never clip at 0%, 100%, or long titles.

- [ ] **Step 4: Add visual fixtures and build the extension**

Create WidgetKit previews for task at 42%, stale task, ended task, approval checkpoint, yes/no checkpoint, and acknowledged result. Run RelayCore tests, app tests, and the generic simulator build. Confirm the widget extension is embedded and its Info.plist extension point remains generated by XcodeGen.

- [ ] **Step 5: Commit**

```bash
git add ios/RelayWidget/RelayLiveActivityWidget.swift ios/RelayWidget/RelayLiveActivityComponents.swift ios/RelayWidget/RelayLiveActivityPreviews.swift ios/RelayShared/CalmSignalStyle.swift ios/RelayAppTests/CalmSignalStyleTests.swift
git commit -m "feat: redesign Relay Live Activities"
```

### Task 7: Create the Layered App Icon and Release Build 6

**Files:**
- Create: `ios/RelayApp/IconArtwork/background.svg`
- Create: `ios/RelayApp/IconArtwork/rear-signal.svg`
- Create: `ios/RelayApp/IconArtwork/front-signal.svg`
- Create: `ios/RelayApp/AppIcon.icon`
- Remove after successful replacement: `ios/RelayApp/Assets.xcassets/AppIcon.appiconset/AppIcon.png`
- Remove after successful replacement: `ios/RelayApp/Assets.xcassets/AppIcon.appiconset/Contents.json`
- Modify: `ios/project.yml`

**Interfaces:**
- Produces: one editable `AppIcon.icon` with Default, Dark, and Mono render modes.
- Keeps: `ASSETCATALOG_COMPILER_APPICON_NAME: AppIcon`.
- Changes: `CURRENT_PROJECT_VERSION: 6`; `MARKETING_VERSION` remains `1.0.1`.

- [ ] **Step 1: Create deterministic vector source layers**

Create 1024×1024 SVGs with no text, external fonts, filters, or embedded raster data:

```text
background.svg: full 1024 square filled #E8DED2; Icon Composer supplies enclosure masking.
rear-signal.svg: two 88-point round-capped sage (#7FA296) arcs centered at (512, 512), radii 300 and 210, open toward the lower-left.
front-signal.svg: a 150-point cream (#FFF9F1) rounded bridge capsule crossing a 126-point sage center disc.
```

Keep every important mark inside the central 760×760 safe region and preserve separate layers for material depth.

- [ ] **Step 2: Compose and annotate the icon**

Open the installed Icon Composer, create an iOS-only 1024×1024 document, import the three SVG layers in background-to-foreground order, and save `ios/RelayApp/AppIcon.icon`. Use restrained refraction/specular settings; the signal must remain legible at Settings and notification sizes.

Configure:

```text
Default: warm stone background, rear sage glass, cream/sage foreground.
Dark: deep #20241F background with the same layer hierarchy and brighter sage.
Mono: one high-contrast signal silhouette with no detail dependent on hue.
```

- [ ] **Step 3: Prove replacement before removing the old icon**

Add `AppIcon.icon` to the generated app target through `RelayApp` sources, run XcodeGen, and build. Inspect build logs for duplicate app-icon or missing-role warnings. Only after `BUILD SUCCEEDED`, remove the old `AppIcon.appiconset` files and build again.

- [ ] **Step 4: Inspect all icon appearances**

Install the simulator app and inspect Home Screen default/dark/tinted appearances, Settings, notification presentation, and Spotlight. Export the App Store rendering from Icon Composer and compare it at 1024, 180, 60, 40, and 20 points. Revise source layers—not flattened pixels—if the mark loses separation.

- [ ] **Step 5: Increment build and commit**

Set `CURRENT_PROJECT_VERSION: 6`. Run app tests and generic simulator build again.

```bash
git add ios/RelayApp/IconArtwork ios/RelayApp/AppIcon.icon ios/project.yml
git add -A ios/RelayApp/Assets.xcassets/AppIcon.appiconset
git commit -m "feat: add the Calm Signal app icon"
```

### Task 8: Full Review, Verification, and Distribution

**Files:**
- Modify: `docs/operations/apple-testflight.md`
- Modify: `docs/operations/physical-acceptance.md`
- Modify: implementation files only when review finds a verified defect.

**Interfaces:**
- Consumes: Tasks 1–7.
- Produces: reviewed commit, green local/CI evidence, signed iOS 1.0.1 (6), internal TestFlight distribution, and an iOS-specific GitHub release record.

- [ ] **Step 1: Run independent code review before release**

Use the repository code-review workflow against the implementation base. Review for spec compliance and code quality separately. Pay particular attention to queue truthfulness, unpair revoke-first behavior, App Group/keychain sharing, notification permission state, ActivityKit credentials, Dynamic Type, and custom-glass restraint. Fix every verified finding through a focused red/green test cycle and commit the fixes.

- [ ] **Step 2: Run the complete local verification suite**

Run:

```bash
pnpm test
pnpm typecheck
pnpm build
sh deploy/test-compose-health.sh
cd ios
swift test --disable-sandbox --scratch-path /tmp/relay-calm-signal-final-swift
xcodegen generate
xcodebuild test -project Relay.xcodeproj -scheme Relay -destination 'platform=iOS Simulator,name=iPhone 17,OS=26.2' -derivedDataPath /tmp/relay-calm-signal-final-tests CODE_SIGNING_ALLOWED=NO
xcodebuild -project Relay.xcodeproj -scheme Relay -destination 'generic/platform=iOS Simulator' -derivedDataPath /tmp/relay-calm-signal-final-build CODE_SIGNING_ALLOWED=NO build
cd ..
git diff --check
```

Expected: every command exits 0. If the exact simulator is unavailable, select an installed iOS 26.x iPhone and record it. Do not substitute a generic build for app tests.

- [ ] **Step 3: Perform simulator visual and accessibility QA**

Install build 6 and capture evidence for pairing idle/error/busy; empty/load-error inbox; approval, yes/no, text, sending, queued, completed, expired, and unsupported cards; notification-permission banner; refresh error with preserved content; and unpair confirmation. Repeat representative states in light/dark, Increased Contrast, Reduce Transparency, Reduce Motion, and `accessibility3`. Inspect all Live Activity fixtures and icon modes.

- [ ] **Step 4: Update operational documentation and commit**

Document the iOS 26 floor, stable-toolchain requirement, Icon Composer source, build 6, visual matrix, and remaining physical gates. State explicitly that no server image or Pi restart is part of this release.

```bash
git add docs/operations/apple-testflight.md docs/operations/physical-acceptance.md
git commit -m "docs: add Calm Signal release checks"
```

- [ ] **Step 5: Push and verify CI**

Push the implementation branch, open/update the pull request, and wait for both Node and iOS jobs. The iOS job must report a stable Xcode 26.x toolchain with an iOS 26 SDK, RelayCore tests, RelayAppTests, and generic app/widget build. Repair CI rather than bypassing it.

- [ ] **Step 6: Archive with an App Store Connect-supported stable toolchain**

Before archiving, run `xcodebuild -version` and verify the selected Xcode is a stable release accepted by App Store Connect. The currently installed Xcode 27 beta is not assumed acceptable. If no acceptable stable Xcode is installed, install/select stable Xcode 26.x through the existing Xcodes app before proceeding.

Generate the project, archive Release build 6, export the IPA, and inspect signed app and widget entitlements for production APNs, `group.com.example.relay`, shared keychain group, and `get-task-allow=false`.

- [ ] **Step 7: Upload and distribute internal TestFlight build 6**

Use the installed App Store Connect release skills/CLI to upload iOS 1.0.1 (6), wait for `VALID`, and distribute it to the existing internal `Dev` group. Release notes describe Calm Signal, iOS 26 minimum, redesigned inbox/pairing/Live Activity, and new icon. APNs acceptance, App Store processing, TestFlight distribution, installation, and device behavior remain separate evidence.

- [ ] **Step 8: Run physical iPhone gates through Relay**

Send a concise Relay notice asking the operator to install build 6. Then verify pairing, ordinary notification, approval/deny/yes/no/text, offline response retry, Live Activity task/checkpoint/acknowledgement, locked-device authentication, Dynamic Island appearance, unpair/re-pair, light/dark/tinted icon, and accessibility settings. Record untested gates rather than implying they passed.

- [ ] **Step 9: Merge and publish the applicable release record**

After CI and release gates pass, merge the pull request and create an iOS-specific GitHub release tag `ios-v1.0.1-build.6`. Do not bump or redeploy the unchanged Node/SQLite server packages. Send a final Relay notification with TestFlight availability and any remaining physical limitations.
