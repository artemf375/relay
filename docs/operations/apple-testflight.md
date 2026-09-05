# Apple and TestFlight setup

1. Set `RELAY_BUNDLE_ID` in `ios/project.yml` to your own app ID. The default `com.example.relay` is a placeholder. Register that app ID under your Apple team. Its Live Activity push topic is `<bundle-id>.push-type.liveactivity`.
2. Enable Push Notifications, Live Activities, App Groups, and Keychain Sharing for the app and extension. Register App Group `group.<bundle-id>`. Both targets use keychain group `$(AppIdentifierPrefix)<bundle-id>.shared`. Set the same bundle ID as `APNS_BUNDLE_ID` on the server. Put your Apple Team ID and APNs key ID in `.env`; mount the downloaded `.p8` only through `deploy/secrets/AuthKey.p8`.
3. Set `DEVELOPMENT_TEAM` in `ios/project.yml`, regenerate with XcodeGen, and inspect signing for both Relay and RelayWidget. App and widget storage groups derive from the bundle ID and signing prefix. Keep your signing values private when publishing your fork.
4. Archive and upload a Release build, then install it through private TestFlight.

## Calm Signal release

Relay 1.0 (7) requires iOS 26 or later. Its pairing, inbox, Live Activity,
Dynamic Island, and Rose Knot app icon share the Calm Signal design system. The
editable icon source is `ios/RelayApp/AppIcon.icon`; `ios/RelayApp/IconArtwork`
contains matching source vectors but is excluded from the application bundle.

Archive build 7 with the installed Xcode 27 beta toolchain used for this
single-user app. Before upload, run the Relay app tests on the installed iOS 27
simulator, build the generic app/widget target, and inspect the signed archive's
app and widget entitlements for production APNs, App Group
`group.<bundle-id>`, shared keychain access, and
`get-task-allow=false`.

Simulator QA covers pairing idle/error/busy states; empty, loaded, queued,
recorded, failed, expired, and unsupported inbox states; permissions and
refresh errors; unpair confirmation; the Live Activity preview matrix; and the
Rose Knot's Default, Dark, and Tinted icon renditions. Physical notification,
locked-device, Dynamic Island, and Home Screen checks remain separate
acceptance gates.

Build 7 displays all active task activities in the inbox and lets the user end
one display without canceling its agent. It requires the schema-5 Relay 0.2.0
server, which stores a separate ActivityKit update token for each activity.

Debug builds installed directly from Xcode register sandbox device tokens. TestFlight builds use production APNs. The server deployment is deliberately configured for `APNS_ENVIRONMENT=production`; use a separate database and server configuration for sandbox development. Never mix sandbox and production tokens or assume a successful APNs request proves device delivery.

Pair the TestFlight app using the public HTTPS hostname and a 10-minute single-use code from `relayctl pair create`. The app stores its device credential in Keychain, registers notification categories, uploads the production APNs token, and observes ActivityKit push-to-start and update tokens.

Build 3 and later advertise interactive Live Activity support during device-token registration. The Lock Screen and expanded Dynamic Island can show Approve/Deny or Yes/No buttons through `LiveActivityIntent`; iOS requires local-device authentication before running the action while locked. The intent reads the paired credential through the shared keychain group and never serializes it into widget state or an APNs payload. Older builds remain notification-only because the server checks the advertised capability before sending checkpoint content.

If rollback is required, disable Live Activity presentation with `--no-live-activity` or deploy the previous server image. Pending interactions remain answerable through notifications and the inbox; reconcile or end any visible checkpoint before downgrading the app.

Before treating a release as operational, complete every item in [physical acceptance](physical-acceptance.md) over cellular.
