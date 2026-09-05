# Physical acceptance gates

Record the TestFlight build number, server commit, iOS version, Pi image, tunnel hostname, and test time. Run over cellular with the app terminated where specified.

- Receive a standard notification with Relay terminated.
- From a locked notification: approve, deny, yes, no, and submit text; verify the exact waiting CLI result and exit code.
- Verify interaction expiry, explicit cancellation, timeout without cancellation, and late retrieval.
- Disable networking before responding; confirm the reply is queued and submitted after reconnection/foregrounding.
- Remotely start, update, mark stale, replace, and end the task Live Activity.
- Run at least two agent task activities concurrently; update and end each independently and verify the other remains active.
- End one activity from the app and verify its agent continues running; swipe-dismiss another and verify server state reconciles.
- While a task activity is active, surface approval and yes/no checkpoints; test every button from the Lock Screen and expanded Dynamic Island, then confirm the newest task state is restored.
- Start a temporary interaction activity with `--live-activity`, answer it, and confirm it ends. Exercise checkpoint cancellation, expiry, duplicate notification/activity taps, and a late tap.
- Confirm locked-device authentication and button operation while the Relay UI is not open.
- Restart the Pi and interrupt/reconnect the tunnel with pending state present.
- Reinstall the app, revoke credentials, re-pair, and rotate the CLI credential.
- Restore the service from the restricted NAS restic repository and repeat a notification/response round trip.

For each push, record APNs HTTP acceptance separately from confirmed on-device presentation and confirmed user action. A simulator build and an APNs 200 response do not satisfy these gates.

Keep release evidence, device identifiers, production hostnames, and backup locations in a private operations log. Do not commit them to this repository.
