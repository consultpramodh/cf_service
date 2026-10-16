# Geography implementation status — 2026-10-16

This is an execution record, not production acceptance. No Apps Script push, deployment, customer/Sales Order write, or live geocoding was performed by this session.

## Checked evidence

- Main workbook: `1m4cIZAkDMrN1lfm_Pash636xSIb4xS_TAKTfU73QsZs`; actual tab metadata, geographic reference rows, service-request IDs, stage/status fields and stored write journals read through the connected Sheets API.
- PR #57: feature `feat/service-area-sheet-reference-20261016`, target `production`; left draft.
- Geographic reference: 26 provisional areas; 11 entire-core, 10 partial-core, 5 buffer-only. All are labeled provisional, not live eligibility approvals.
- All five showroom coordinate cells are blank and explicitly unverified. The private geocode sheet contains headers only.
- The October 9–15 cohort has 26 records: 24 marked COMPLETED and 2 BLOCKED. West Rouge is blocked by SERVICE_CITY_UNMAPPED / required Zone 798; wood/WETT is blocked by the gas-only rule. These are current workbook states, not fresh ERP readbacks. Old missing/zero zone journal values do not prove the current ERP field is wrong.
- Latest inspected P0 live-read job `117068638415` successfully pulled 17 live source files. It found seven files divergent from the October 14 checkpoint; no missing or extra files. Its backup push failed non-fast-forward because it targeted an existing repair branch.

## Corrections

| Component | Correction | Evidence | Production status |
|---|---|---|---|
| Geographic cache identity | HMAC-SHA256 with a separately provisioned secret; preserve installed column schema | Exact Node crypto comparison; missing-secret regression | Feature branch only |
| Provider destination | Exact approved-host list in addition to explicit enable/privacy flags; IP/local hosts denied, redirects still off | Mock transport tests | Feature branch only |
| Cached evidence | Reject invalid coordinates and future timestamps; report cache hit as zero calls | Adversarial cache regressions | Feature branch only |
| Candidate uniqueness | Require valid OSM type and positive feature ID | Missing-ID regression | Feature branch only |
| API accounting | Count attempted provider call even when durable persistence subsequently fails | Injected cache-write failure | Feature branch only |
| Live backup conflict | Run-specific snapshot path and backup branch; remote commit and every source SHA checked | YAML and shell syntax checks; Actions acceptance tracked in PR | Live backup verified; no Apps Script write |

Local validation: all three geographic/zone suites passed and the entire automation module parsed. GitHub geography run `38929453876` passed at commit `4ed3ed80f533179ab951fed67e4d1772f4d6bd9f`. The broader P0 verification job `117069403186` also passed. Subsequent reconciliation verified 16 source files byte-for-byte by Git blob identity; `30_Striven_Data.gs` matched after the existing `patchReadinessCounts` release transform. The core transform was independently checked as already applied. Live snapshot commit: `d795183115260550ad946ebf43e11179875044a1`, branch `backup/live-serviceops-38929462350-1`. Its workflow logged `REMOTE_SOURCE_SNAPSHOT_VERIFIED files=17`.

The stale-checkpoint guard is corrected to compare a freshly fetched current production source plus the known readiness transform. The deployment script's immutable approved baseline is now the independently reconciled production commit `60d2a6f6089cd5ffe5266427ec8a87030036b8c4`. Unexpected live differences still stop writes. These corrections require a fresh Actions run; no live deployment is implied.

## Remaining dependency order

1. DONE: verify the new live snapshot backup and reconcile all 17 files with current production. PENDING: fresh Actions evidence for the corrected current-production parity check and immutable release baseline. Retain the mismatch stop.
2. Verify precise coordinates for all five showrooms. Official business addresses alone do not establish precise map pins.
3. Obtain the approved private/contracted OSM provider endpoint, permitted retention terms and secure configuration. Never send private residential addresses to public Nominatim. Provision the allowlisted host and HMAC secret in Script Properties, not GitHub.
4. Obtain business approval for 25 km core / 25–30 km review / over-30 km treatment and unmapped administrative zones. Keep municipality classification separate from eligibility.
5. Extend current modules with a bounded asynchronous geographic stage only after its prerequisites are proven; do not add geographic latency to webhook acknowledgment. Preserve gas-only, identity and uncertain-write guards.
6. Run full integration and read-only historical checks; then controlled new-request production acceptance and independent ERP reconciliation. Measure receipt-to-verified-order time and actual per-provider calls.

## Source references

- PR: https://github.com/consultpramodh/cf_service/pull/57
- Geography checks: https://github.com/consultpramodh/cf_service/actions/runs/38929453876
- Original live drift/conflict evidence: https://github.com/consultpramodh/cf_service/actions/runs/38929198967
- Provider policy: https://operations.osmfoundation.org/policies/nominatim/
- Apps Script HMAC API: https://developers.google.com/apps-script/reference/utilities/utilities

No live API-budget/latency improvement or end-to-end production success is claimed. Private provider approval, final boundary policy, exact showroom pins and live acceptance are outstanding.
