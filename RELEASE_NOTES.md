# Release Notes — v5.8.0

## Release goal

Remove operator-facing complexity without losing historical intake/service data or destabilizing Gravity Forms.

## Modified modules

- `00_Config.gs`: v5.8.0 release/schema version; only Dashboard + Operator Queue visible; legacy/canonical sheet aliases; Operator Queue reduced to 10 columns.
- `01_Core_Utilities.gs`: resolves legacy/canonical sheet aliases safely and throws on ambiguity.
- `10_Setup_Admin.gs`: non-destructive migration with backup + identity hashes, in-place rename only, no sheet deletion, post-rename durable identity verification.
- `20_Intake_Processing.gs`: v5.8.0 label, corrected Gravity Forms REST credential documentation, existing fast webhook + reconciliation behavior retained.
- `50_Operator_Queue.gs`: rewritten operator UI; Dashboard is read-only snapshot; Queue is processing workspace; deterministic formatting; scheduled/unscheduled KPI derivation.
- `90_Diagnostics_Tests.gs`: v5.8 operator workspace checks; preservation-friendly warnings; intake linkage metrics.
- `95_Public_Runners.gs`: v5.8.0 web-app/version response; Queue refresh also refreshes Dashboard; `DASHBOARD_refresh()`.

## Unchanged logic retained

Current Striven read caches, matching/profile logic, Phase 5A transaction planning, Customer 360, AI helper, and code audit modules were retained from the Aug 18 source audit unless a dependency required a compatibility change.

## Verification performed

- Extracted all 15 project files from the Aug 18 audit.
- JavaScript syntax check passed for all 14 `.gs` modules.
- Operator Queue header assignments match the new Config header contract.
- No hard-coded deployment ID, Apps Script project ID, Gravity Forms secret, or Striven secret was added.

## Not executed here

- Apps Script runtime execution against the live spreadsheet.
- Gravity Forms live test submission.
- Striven API refresh/matching.
- `clasp push` / Apps Script deployment.
