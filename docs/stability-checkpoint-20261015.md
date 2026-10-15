# Stability checkpoint — 2026-10-15

## Completed and verified

- Historical source backups 1–201 checked: 200 archived snapshots in full-history-20261009 plus separate version-199 source. All 423 tracked backup blobs matched GitHub at deletion-time recheck.
- Existing production deployment updated to version 202. UI confirmed success and exactly one saved active version after historical cleanup.
- Release retention rule recorded in docs/release-version-retention.md.
- Request SR-20261014113555-5519 contained foreign root and nested journals belonging to SR-20261014112053-1499. Temporarily contained with explicit BLOCKED/manual review state before reconciliation.
- Existing customer, customer-scoped contact, primary location, service work order and downstream task were inspected directly through Striven customer list/dashboard/location list/order screens. No new remote records were created for this repair.
- Replaced operational journal ownership with the actual request ID; preserved the complete foreign journal as a raw forensic string under integrityRecovery.foreignJournalRaw, excluded from operational create sections. Recorded actual existing IDs and source of verification.
- Repaired row returned to CUSTOMER STRUCTURE COMPLETE / OPEN / RERUN SALES ORDER CERTIFICATION with the existing order linked. Readback verified intended fields and no unexpected collateral changes during the main repair batch.

## Acceptance still pending

| Priority | Issue | Status | Required proof |
| --- | --- | --- | --- |
| P0 | Repaired foreign-journal request | Ledger repaired; not completed | Canonical certification of linked existing order; correct queue projection; no create retry |
| P0 | Fresh-request completion and worker continuation | Unknown | Trace new intake through verified order and show bounded recovery |
| P1 | Existing-customer request SR-20261014174558-4305 | Location review remains | Resolve duplicate same-premises locations against authoritative evidence and approved primary-location rule |
| P1 | Receipt-to-order timer | Existing PR 50 remains separate | Merge/deploy only after live parity and appropriate regression checks |
| P1 | API and runtime reduction | Not measured | Per-request and background baseline; remove redundant calls only with correctness preserved |

The live Apps Script execution screen was accessible. A web-app doGet execution was visible, but direct HTTP health response could not be inspected because Browser returned ERR_BLOCKED_BY_CLIENT. Editor runner controls did not become available during this check; do not claim a manual worker execution. Completed Apps Script executions alone do not prove request-level completion.

No claim of end-to-end stability is made at this checkpoint.
