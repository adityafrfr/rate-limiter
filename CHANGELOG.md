# Changelog

All notable changes to this project are documented here.
This file follows the format: each pull request is recorded with a summary of changes grouped by category.

---

## [PR #1] Add Automatic Session Release on Page Exit

**Date:** 2026-03-24
**Branch:** `copilot/create-adaptive-security-gateway` → `main`
**Files changed:** 4 &nbsp;|&nbsp; +340 additions &nbsp;|&nbsp; -53 deletions

### Session Management

- Added automatic session release when a user navigates away or closes the tab, using the `pagehide` browser event.
- Used `navigator.sendBeacon` as the primary release mechanism (works reliably during page unload), with a `fetch` fallback for browsers that do not support it or when `sendBeacon` returns `false`.
- Refactored the "Leave" button and countdown expiry into a shared `handleSessionEnd()` / `releaseSession()` flow to eliminate duplicated logic.
- Added user-visible error recovery: if the automatic release fails on countdown expiry, the countdown resets to allow a manual retry via the Leave button.
- Added an accessible status element (`role="status"`, `aria-live="polite"`) to surface release errors to screen readers.

### New-User Surge Detection & Onboarding Gate

- Introduced a second, independent anomaly-detection channel that monitors the rate of *new entry attempts* (separate from total request rate).
- Applied rolling-window statistics (standard-deviation multiplier `2.1`, minimum absolute delta `2`) to detect sudden spikes in new-user traffic.
- When a spike is detected, an **onboarding block** is activated for 8 seconds, preventing new admissions while existing sessions continue unaffected.
- Added `onboardingBlocks` and `reputationBlocks` counters to the server metrics.

### Dynamic Session Capacity

- The session cap is no longer a fixed constant; it now adjusts dynamically based on the observed new-user admission rate.
- Capacity scales between `MAX_USERS` (floor) and `MAX_USERS × 5` (ceiling), driven by a configurable factor (`0.35`).
- Capacity changes are logged to the server console.
- The API snapshot now exposes both `dynamicCapacity` (current effective cap) and `baseCapacity` (configured maximum).

### IP Reputation & Strike System

- Added a per-IP reputation tracker (`ipReputation` Map) to the server.
- IPs accumulate strikes for blocked or anomalous requests; reaching **3 strikes** triggers a temporary block (15 s, up to 60 s maximum).
- Strikes decay automatically after 30 s of inactivity, allowing legitimate users to recover.

### Admin UI (`public/admin.js`)

- Capacity display now shows `dynamicCapacity` instead of the static `maxUsers`.
- Added new-user rate metrics (live and last-second) alongside the existing total-request rates.
- Updated the capacity status caption to show **"New-user gated"** when the onboarding block is active.
- Capacity detail text now includes new-user rate, its baseline/threshold, and the current dynamic cap value.
- The capacity progress meter now accounts for the higher of total-request rate or new-user rate.
- Status message now distinguishes between the onboarding guard, surge guard, simulator running, and idle states.

### Visitor UI (`public/gateway.js`)

- Active-user counter now reflects `dynamicCapacity` instead of `maxUsers`.
- Block reason messages are now driven directly from the server's `data.message` field, so new block types (e.g., new-user gated) surface without client-side special-casing.
- Mode indicator extended with a **"New-user gated"** state in addition to surge guard, simulator running, and normal.

---

*This changelog is maintained in the repository root. Each merged pull request should be added as a new section above this line.*

---

> **Rate Limiter Project** — For internal reference only.
> Generated from repository history. See individual commits for full technical detail.
