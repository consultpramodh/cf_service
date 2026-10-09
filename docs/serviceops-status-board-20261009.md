# CF ServiceOps status board
Updated October 9, 2026, America/Toronto.

Statuses record evidence, not planned completion.

| Priority | Work | Status | Evidence / next action |
|---|---|---|---|
| P0 | Worker liveness | IN PROGRESS | [Issue #48](https://github.com/consultpramodh/cf_service/issues/48). Actual helper tested under mocks; missing/invalid timestamps reproduced. Simple replacement rejected after deletion-failure counterexample. Current live queue empty; eligible-request stall not established. |
| P0 | Gas-only backend eligibility | TO VERIFY / CORRECT | October 9 audit found no explicit canonical backend gate; form enforcement unverified. |
| P1 | Sales Order certification / field completeness | TO CORRECT | Repairable custom-field differences can accompany COMPLETED; required repair policy needs explicit verification. |
| P1 | Early Bird cutoff | POLICY CORRECTION PENDING | Audit says EB2026 tag bypasses September 25 cutoff. |
| P1 | Customer / Contact / Location recovery | RECHECK REQUIRED | Historical issues #4, #5, #10; current incidence must be measured. |
| P1 | Existing order 26648 location conflict | LEGITIMATE REVIEW | Direct live snapshot retained BLOCKED and do-not-create-again action. |
| P1 | Scheduling / technician / print / payment handoffs | UNVERIFIED | Canonical dispatcher ends at certified order; verify downstream independently. |
| P2 | Queue / dashboard parity | RECHECK REQUIRED | Compare current ledger and display after mutations. |
| P2 | Runtime and API churn | MEASURE REQUIRED | Live snapshot records repeated stale-worker recovery and a 112191 ms operational refresh; no current cohort baseline. |
| P2 | JEV semantic pilot | NOT INTEGRATED | Skill applied; no model call. Deterministic rules, IDs, retries and writes remain in code. |

## Verified this investigation
- Direct live read-only intake-progress-snapshot: runtime 5.14.4; queue empty; one final worker, one watchdog; workerStale=false.
- Submission 3549 remains COMPLETED with order 27591.
- Submission 3547 remains blocked with existing order 26648.
- Actual extracted ensureWorker_ executed in Node VM; regression harness stored in tests/worker-liveness-investigation-20261009.cjs on this tooling branch.
- No Apps Script code push, version deletion or Striven write performed.

## Release boundary
Read-only web-app access works. A fresh authenticated full Apps Script source pull and deploy-capable access have not been established in this session. GitHub production source and the earlier saved-version backup are evidence, not a substitute for current editable HEAD parity. Keep issue #48 open until safe patch and controlled live acceptance pass.
