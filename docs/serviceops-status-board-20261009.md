# CF ServiceOps status board
Updated October 9, 2026, America/Toronto.

Primary objective: reduce actual Striven HTTP attempts per successful request, without weakening duplicate prevention, ownership verification or required post-write read-back.

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
| P0 | Striven API call reduction | FIRST OPTIMIZATION | Count actual HTTP attempts, including retries and report pages. Inspect unchanged-conflict recertification and redundant broad refreshes before adding calls or JEV. Existing conflict preview already has a 30-minute fingerprint cooldown; audit downstream recertification for repeat GETs. No savings quantified yet. |
| P2 | JEV semantic pilot | NOT INTEGRATED | Skill applied; no model call. Deterministic rules, IDs, retries and writes remain in code. |

## Verified this investigation
- Direct live read-only intake-progress-snapshot: runtime 5.14.4; queue empty; one final worker, one watchdog; workerStale=false.
- Submission 3549 remains COMPLETED with order 27591.
- Submission 3547 remains blocked with existing order 26648.
- Actual extracted ensureWorker_ executed in Node VM; regression harness stored in tests/worker-liveness-investigation-20261009.cjs on this tooling branch.
- No Apps Script code push, version deletion or Striven write performed.

## Release boundary
Read-only web-app access works. Authenticated Apps Script editor access was verified after secure Google sign-in. A fresh full source backup, live-to-patch parity comparison and deployment remain pending. GitHub production source and the earlier saved-version backup are evidence, not a substitute for current editable HEAD parity. Keep issue #48 open until safe patch and controlled live acceptance pass.

## API reduction correction order
1. Inspect the shared Striven HTTP wrapper and existing counters. Count each network attempt, retry and report page by request/stage/endpoint without extra Striven requests.
2. Stop repeated reads for unchanged proven conflicts while retaining an explicit evidence-invalidation/resume path. Do not assume a trigger execution equals an API call.
3. Prefer request-scoped evidence retrieval to broad report refreshes where freshness and identity checks remain satisfied. Reuse reads within one execution; invalidate cached entities after writes.
4. Keep dashboard/queue projection local wherever possible; confirm dependencies before eliminating refreshes.
5. Preserve one necessary post-write GET and exact duplicate/ownership gates. Report before/after attempts and completion outcomes; do not invent savings.

## Execution update
- #49: IMPLEMENTED / LOCAL TESTS PASS / NOT DEPLOYED. Draft PR #50 on fix/serviceops-api-and-timing-20261009. Receipt-to-order acknowledgment timing, refreshed pending duration, zero HTTP calls in helper tests.
- #51: IMPLEMENTED / LOCAL TESTS PASS / NOT DEPLOYED. Terminal HTTP errors retried 3 times in original mocked test; patched result 1 attempt. Retryable failures preserved. Same branch/PR.
- #48: DIAGNOSED / SAFE PATCH PENDING. Missing schedule metadata and ignored deletion outcome reproduced.
- Access restored: secure Google sign-in completed and the CF Service - July 2026 editor was visibly verified under pramodh@classicfireplace.ca. Deployment has not occurred; no issue is closed as live resolved.
