# Release Notes — v5.14.1

## Single ServiceOps production model

v5.14.1 removes the stacked ServiceOps automation generations and establishes one canonical production path.

### Production model

- `CF.EventDrivenServiceAutomation` is the workflow controller.
- `AUTO_FINAL_ServiceOps` is the request worker.
- `AUTO_98_E2E_Recovery_Watchdog` is the recovery/liveness handler.
- `CF.CustomerStructureEngine` owns request-scoped Customer/Contact/Location resolution.

### Live cleanup

The following obsolete V2 shadow files were removed from the bound Apps Script project:

- `CF_ServiceOps_V2_Core_Ensurers`
- `CF_ServiceOps_V2_Migration`
- `CF_ServiceOps_V2_Orchestrator`
- `CF_ServiceOps_V2_Shadow_Resolver`
- `CF_ServiceOps_V2_Sheet_Runners`
- `CF_ServiceOps_V2_Worker_Bridge`
- `V2_Installer`

Legacy phase-specific ServiceOps automation source is rejected by the release pipeline.

### Release hardening

- The production release is idempotent: already-canonical modules no longer cause a false patch-scope failure.
- clasp 3.3.0 deployment updating uses the current `redeploy <deploymentId> --versionNumber ... --description ...` syntax.
- The release verifies that the existing web-app deployment is actually pinned to the newly created Apps Script version.
- Every production deployment now queries the live web app and fails unless the runtime reports:
  - v5.14.1
  - automation enabled
  - exactly one watchdog
  - at most one final worker trigger
  - zero legacy automation triggers
  - `singleModelVerified: true`

### Verified production state

On 2026-09-30:

- Apps Script version **129** was created.
- The existing web-app deployment was pinned to **129**.
- Exact remote source parity passed.
- Obsolete V2 source was absent.
- Legacy automation source was absent.
- Live runtime verification returned `SINGLE_SERVICEOPS_MODEL_VERIFIED`.

---

## Historical release notes — v5.13.5

## Customer-profile Location reconciliation

This patch changes ServiceOps Location resolution so the Customer profile is authoritative before any Location creation.

### Updated logic

- Added `GET /v1/customers/{customerId}/locations` as the first Location lookup.
- Exact service-address matching is performed against the Customer profile Location `Data[]`.
- Existing matching Locations are linked immediately; no Location POST is issued.
- If the Customer profile has no matching Location, ServiceOps reads the confirmed Customer/Primary Contact and checks the Contact address.
- Contact fallback is allowed only when the Contact address matches the submitted service address.
- A second Customer-profile/legacy duplicate check runs immediately before the single guarded Location create.
- New primary Locations are named exactly `Primary Location`.
- After a Location POST, ServiceOps requires a Customer-profile read-back before marking the Location reconciled.
- A prior Location POST is never automatically repeated.
- If the authoritative Customer-profile GET fails, Location creation is blocked.
- If the Contact address differs from the submitted service address, automatic Location creation is blocked.
- A Customer created by ServiceOps already includes PrimaryLocation; if its Location read-back is delayed, the system waits and does not create a second Location.

## Source basis

The branch was rebuilt from the current 17-file production source snapshot in the bound workbook's Code Audit Source before applying the two targeted module changes.

## Modified modules

- `00_Config.gs`
- `60_Striven_Write.gs`
