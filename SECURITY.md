# Security policy

## Report a vulnerability privately

Use [Report a vulnerability](https://github.com/artemf375/relay/security/advisories/new) to contact the maintainer through GitHub private vulnerability reporting. Do not put exploit details or credentials in public issues or pull requests.

Include the affected commit or release, deployment type, steps to reproduce, expected impact, and a small example with made-up credentials. Test only systems and data you own or have permission to test. Do not send live keys, database exports, or private notification content.

The maintainer will review the report, ask for details if needed, and coordinate a fix and disclosure. This is a volunteer project; there is no guaranteed response time or paid bug bounty. If private reporting is unavailable, open an issue asking for a private contact method without including vulnerability details.

## Supported code

Security fixes target the current `main` branch. Update to a commit that contains the fix when an advisory is published. Older releases do not have a separate maintenance or backport commitment.

## If a credential is exposed

Revoke or rotate it with its issuing service. Removing a file or commit does not revoke a credential. Report any related Relay defect through the private channel above. Do not attach the exposed value to the report.

Relay's database encryption key and token-hash key protect stored data and credentials. Replacing them without a recovery plan can make existing data unusable. See [recovery](docs/operations/recovery.md) before changing those keys.
