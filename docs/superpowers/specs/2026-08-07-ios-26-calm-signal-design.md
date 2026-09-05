# Relay iOS 26 Calm Signal Design

## Summary

Relay's iPhone experience will adopt a cohesive **Calm Signal** identity: warm, quiet, and personal while remaining unambiguous when the operator must make an operational decision. The redesign covers pairing, the inbox, Live Activities, the Dynamic Island, and the app icon. It raises the minimum deployment target to iOS 26.0 and uses native SwiftUI behavior instead of maintaining compatibility branches or imitating system materials.

The redesign does not change Relay's server API, persistence model, security boundaries, or delivery semantics. It is a presentation and interaction-quality release for the existing single-user, single-iPhone product.

## Goals

- Make the app feel intentionally designed and at home on iOS 26 and later.
- Establish one recognizable Calm Signal identity across every iPhone surface.
- Make pending decisions, response progress, outcomes, and errors immediately understandable.
- Preserve the existing durable offline-response and notification behavior.
- Improve accessibility, state feedback, and destructive-action clarity.
- Deliver the result through the existing internal TestFlight path without manual follow-up work for the operator.

## Non-goals

- New server endpoints, database fields, deployment behavior, or multi-device support.
- Phone-initiated agent instructions, activity history, analytics, accounts, or settings unrelated to this redesign.
- A decorative tab bar or an Activity screen without meaningful local activity data.
- Compatibility code, fallback styling, or migrations for releases earlier than iOS 26.
- Claims that simulator checks validate physical notification, ActivityKit, signing, or device behavior.

## Design Principles

### Calm, not vague

Warm surfaces and friendly language must not soften critical distinctions. Approval, denial, expiry, unsupported prompts, failed delivery, and destructive unpairing remain explicit. Semantic meaning takes precedence over brand color.

### Content before material

The system owns navigation and control chrome. Standard SwiftUI components receive the current Liquid Glass treatment automatically. Custom glass is reserved for a small number of important controls where it improves hierarchy; message cards remain readable content surfaces rather than decorative translucent layers.

### One focused product

Relay is an inbox for agent-originated notifications and bounded questions. The redesign will strengthen that purpose instead of adding dashboards, tabs, metrics, or configuration that the product does not need.

### Native adaptability

The interface uses semantic colors, Dynamic Type, system spacing, SF Symbols, VoiceOver labels, and system accessibility settings. Light, Dark, Increased Contrast, Reduce Transparency, and Reduce Motion must all produce a complete usable interface.

## Visual System

### Color

- **Primary action:** a restrained sage green that remains legible in light and dark appearances.
- **Warm neutral surfaces:** adaptive parchment and stone tones for content backgrounds.
- **Destructive and denial actions:** system semantic red, visually separate from the primary sage action.
- **Success, warning, and unavailable states:** system semantic colors so meaning survives appearance and accessibility changes.
- **Navigation and glass:** minimal tint. Underlying content supplies atmosphere; controls do not become a field of colored glass.

Exact asset and semantic color values will be selected during implementation and verified in every supported appearance. Components consume named semantic colors rather than raw color literals.

### Typography and iconography

- Use San Francisco through SwiftUI semantic text styles.
- Prefer sentence case and short human labels.
- Use SF Symbols for interface actions and statuses.
- Reserve the custom relay/signal mark for identity surfaces such as pairing and the app icon.
- Never encode status by color alone; pair it with text and/or a symbol.

### Shape and depth

- Content cards use modest continuous corners, clear grouping, and restrained separation.
- Controls use native iOS shapes and button styles.
- Shadows are subtle and only support hierarchy; they do not simulate floating dashboard tiles.
- Motion is brief and state-driven, with Reduce Motion respected.

## Information Architecture

The app retains its two root states:

1. **Unpaired:** a focused pairing experience.
2. **Paired:** a single inbox within a `NavigationStack`.

The inbox has two meaningful groups:

- **Waiting for you:** pending approval, yes/no, and text prompts.
- **Earlier:** completed prompts and recent notifications ordered by recency.

There is no tab bar. Account-like controls are not introduced. Unpair remains available from the trailing toolbar menu and requires confirmation.

## Pairing Experience

The pairing screen introduces Relay with the signal mark, a concise statement of purpose, and one vertical task flow:

1. Enter the HTTPS Relay address.
2. Enter the eight-character, single-use pairing code.
3. Pair the iPhone.

The server address uses URL keyboard behavior and disables capitalization. The code uses an appropriate text-content treatment, capitalization, and monospaced presentation where helpful. The primary action is full width and becomes a progress state while pairing.

Validation appears near the relevant field. A malformed URL, non-HTTPS URL, incomplete code, expired code, and network failure must have distinct human-readable feedback where the API provides enough information to distinguish them. The entered values remain available after a recoverable failure.

Successful pairing transitions directly into the inbox. Notification authorization remains part of configuration, but denial must not make the app appear unpaired or broken; the inbox can explain that notification permission is required for remote alerts.

## Inbox Experience

### Empty state

When no content exists, the inbox presents a calm system empty state explaining that Relay prompts and notifications will appear there. Refresh remains available. The empty state must not imply the service is disconnected when the inbox is merely empty.

### Pending prompt cards

Each card presents, in order:

- Prompt kind/status symbol.
- Title.
- Prompt text.
- Expiry context when useful.
- Controls appropriate to the prompt kind.

Approval and yes/no controls are equally understandable but not equally styled: the affirmative action is primary and the negative/destructive action is explicit without becoming visually dominant. Text replies use a growing text field and a clear Send action.

Submitting a response immediately disables that card's controls and shows a local sending state. Only the affected interaction is busy; unrelated prompts remain actionable. On success, a subtle symbol transition and sensory feedback acknowledge the response before the card settles into its terminal result. Reduce Motion suppresses nonessential animation.

The existing response queue remains the durable delivery mechanism. The UI must not report a response as delivered merely because it was accepted locally for retry. Copy distinguishes queued, sending, recorded, and failed states when those states are available.

### Earlier content

Completed prompts and ordinary notifications use compact cards with their result or delivery status secondary to the title and body. Unsupported interaction kinds remain visible and non-actionable with an explicit update-required explanation.

### Refresh and errors

Pull to refresh remains available. A refresh failure preserves existing content and exposes a non-blocking retry/status treatment. Empty-content load failures use a system unavailable state with a retry action. Pairing failures stay local to pairing. Irrecoverable cross-screen errors may use an alert, but the generic global alert is not the default error surface.

## Unpairing

Unpair is a destructive toolbar-menu action followed by a confirmation dialog. The dialog explains that this phone's Relay access, locally stored credential, and pending local responses will be removed. Cancellation is the default safe path.

The existing revoke-first safety behavior remains unchanged: if server revocation fails for a reason other than an already-revoked device, local credentials stay intact and Relay resumes normal operation. The UI communicates the failure without presenting the phone as unpaired.

## Live Activity and Dynamic Island

The Live Activity shares the Calm Signal system without sacrificing glanceability:

- Sage is the activity accent for neutral task progress.
- System semantic colors communicate completion, warning, delay, approval, and denial.
- Progress, stale state, and terminal state remain labeled, not color-only.
- Lock Screen content prioritizes status and detail; checkpoint prompts prioritize the question and actions.
- Dynamic Island compact regions remain minimal and recognizable.
- Interactive buttons retain explicit Approve/Deny or Yes/No labels in expanded and Lock Screen contexts.
- Expired controls remain disabled and provide an accessibility explanation.

The widget continues to use shared configuration and intents. No credential enters widget state or APNs content. The redesign must preserve capability advertisement, stale-token handling, monotonic activity sequences, and competing-response behavior.

## App Icon

The new icon uses a simple layered relay/signal mark rather than a miniature interface or text. Artwork is prepared as clean independent layers and composed with Apple's Icon Composer so the system can render material, depth, and platform appearances.

The icon must be inspected in:

- Default appearance.
- Dark appearance.
- Mono/tinted appearance.
- Home Screen at common sizes.
- Settings and notification sizes.
- App Store export.

The mark must remain identifiable without relying on a warm background or fine detail. Image generation may be used for concept exploration, but final production artwork must use deliberate, editable layers suitable for Icon Composer.

## iOS 26 Adoption

The application and Swift package deployment targets become iOS 26.0. No `if #available` compatibility branches are added for older releases.

The implementation should prefer standard `NavigationStack`, `List`, toolbar, menu, confirmation-dialog, text-field, and button behavior. Native Liquid Glass APIs such as glass button styles and `glassEffect` are available for the few custom controls that justify them. `GlassEffectContainer` is used only if multiple custom glass shapes need coordinated rendering or morphing; it is not a requirement by itself.

The interface should also use native symbol effects and sensory feedback for acknowledgements when they improve comprehension, with accessibility settings respected. Features are adopted because they serve the interaction, not to demonstrate every new API.

## Component Boundaries

Implementation will keep state and transport behavior separate from presentation:

- **Calm Signal tokens and reusable surfaces:** semantic colors, spacing, card treatment, status presentation, and shared button treatment.
- **Pairing screen and fields:** pairing-only presentation, validation display, and busy state.
- **Inbox screen:** grouping, empty/loading/error states, refresh, and toolbar composition.
- **Interaction card:** prompt presentation and kind-specific controls.
- **Notification/result card:** compact earlier-content presentation.
- **Live Activity components:** task, checkpoint, acknowledgement, and compact/expanded island layouts.
- **App model and coordinators:** remain responsible for API calls, stored configuration, notification registration, response queuing, and ActivityKit token handling.

Presentation components receive values and actions through narrow interfaces. Networking and credential storage do not move into SwiftUI view bodies.

## State and Data Flow

1. `AppModel` restores paired configuration and selects pairing or inbox root state.
2. Pairing validates local input, enrolls through `RelayAPI`, saves configuration, configures coordinators, and transitions to the inbox.
3. Inbox refresh replaces server-backed interaction and notification snapshots only after a successful response.
4. A card response enters a per-interaction local sending state and goes through `NotificationCoordinator`, which retains durable offline-queue behavior.
5. Refresh reconciles the local presentation with the server's winning terminal state.
6. Unpair revokes the device before clearing shared local state and ending visible activities.

UI-only transient state must not become a competing source of truth for interaction outcomes.

## Accessibility

- Support all Dynamic Type sizes without truncating actionable prompt text or overlapping controls.
- Maintain minimum touch targets and native focus order.
- Provide concise VoiceOver labels and values for status, expiry, progress, and actions.
- Do not repeat the entire prompt in every action label when that makes navigation unusably verbose; preserve enough context to disambiguate prompts.
- Pair color with symbols or text for every state.
- Verify Increased Contrast, Reduce Transparency, Reduce Motion, Bold Text, and light/dark appearances.
- Keep destructive confirmation explicit and place cancellation in the safe default position.

## Verification

### Automated

- Add unit coverage for derived card groups and presentation/action states at stable seams.
- Retain and run the full RelayCore Swift test suite.
- Regenerate the Xcode project and build the app and widget for an iOS simulator.
- Run the repository's TypeScript tests, typecheck, and build before release because the repository is released as one product, while reporting iOS-specific and server checks separately.
- Run `git diff --check` and an independent code review before committing the implementation.

### Visual and accessibility QA

- Exercise pairing, empty inbox, pending approval, pending yes/no, text reply, sending, queued, completed, expired, unsupported, refresh failure, and unpair-confirmation states.
- Inspect light, dark, increased-contrast, reduced-transparency, and representative Dynamic Type sizes.
- Inspect Lock Screen and Dynamic Island task, checkpoint, acknowledgement, stale, and ended states.
- Inspect every app-icon rendering mode and small-size legibility.

### Release gates

- Increment the iOS build number; the marketing version does not need to change solely for this redesign.
- Archive using an App Store Connect-supported toolchain.
- Inspect the signed release app and widget entitlements, including production APNs, shared App Group, shared keychain group, and `get-task-allow=false`.
- Upload to the existing internal TestFlight group and verify processing/distribution status.
- Treat physical iPhone pairing, push delivery, offline response retry, Live Activity interaction, and final appearance as separate device gates.
- Publish the applicable GitHub release record. A server restart or Pi deployment is unnecessary unless implementation changes a server artifact, which is outside this design.

## Approved Decisions

- Visual direction: **Calm Signal**.
- Scope: pairing, inbox, Live Activity, Dynamic Island, and app icon.
- Minimum deployment target: iOS 26.0.
- Navigation: one inbox, no decorative tab bar or invented Activity screen.
- Materials: native system chrome with sparse custom Liquid Glass.
- Delivery: full review, verification, build-number increment, and internal TestFlight release.

## References

- [Apple Human Interface Guidelines: Materials](https://developer.apple.com/design/human-interface-guidelines/materials)
- [Apple: Liquid Glass](https://developer.apple.com/documentation/TechnologyOverviews/liquid-glass)
- [Apple: GlassEffectContainer](https://developer.apple.com/documentation/swiftui/glasseffectcontainer)
- [Apple: Creating your app icon using Icon Composer](https://developer.apple.com/documentation/Xcode/creating-your-app-icon-using-icon-composer)
