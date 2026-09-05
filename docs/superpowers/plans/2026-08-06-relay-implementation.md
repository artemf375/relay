# Relay Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Deliver a native iPhone and Raspberry Pi bridge that `relayctl` can use for notifications, interactive replies, and one task Live Activity.

**Architecture:** A Node 22/Hono server owns SQLite state and direct APNs delivery. A native SwiftUI app and ActivityKit widget consume its versioned interface. A TypeScript CLI is the only agent-facing interface.

**Tech Stack:** TypeScript, Hono, Zod, Drizzle, better-sqlite3, Vitest, SwiftUI, UserNotifications, ActivityKit, WidgetKit, Docker Compose, Cloudflare Tunnel, restic.

## Global Constraints

- Bundle ID: `com.example.relay`; minimum iOS version: 17.2.
- Single user and one active iPhone only.
- Direct APNs only; no Expo, OAuth, billing, analytics, or AI runtime.
- All credentials are revocable; token material is never persisted in plaintext.
- Tests distinguish APNs acceptance from user-confirmed responses.

## Tasks

1. Define strict shared contracts and security primitives with red-green tests.
2. Add SQLite migrations/repositories and transactional interaction/activity state machines.
3. Expose authenticated Hono routes and direct APNs adapters with integration tests.
4. Implement `relayctl`, stable JSON/exit codes, configuration permissions, and the Relay agent skill.
5. Implement the SwiftUI pairing/inbox app, actionable notifications, response retry queue, and ActivityKit widget.
6. Add ARM64 Docker, Cloudflare Tunnel, integrity/backup operations, CI, and deployment/runbook documentation.
7. Run complete TypeScript, iOS Simulator, container, and requirements verification; leave physical TestFlight/Pi/APNs/NAS gates explicit.
