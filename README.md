# CF ServiceOps v5.8.0

Operator-friendly release based on the **Aug 18, 2026 Code Audit**.

## What changed

- **Dashboard is now read-only** and shows a service-wide snapshot.
- **Operator Queue is the only processing workspace.**
- Only `00 Dashboard` and `03 Operator Queue` are visible during normal operation.
- Webform, Service Request, Striven cache, and System Log sheets remain hidden technical ledgers.
- The migration is **backup-first and in-place**. It does not delete sheets or rebuild the durable Webform/Service Request ledgers.
- Legacy and numbered sheet names are both recognized during the transition so Gravity Forms intake does not break between code deployment and sheet renaming.
- Operator Queue formatting is reset and reapplied on every refresh, fixing formatting drift on new/future rows.
- Gravity Forms reconciliation uses `GRAVITY_FORMS_CONSUMER_KEY` + `GRAVITY_FORMS_CONSUMER_SECRET`; no username/password properties are required.

## Dashboard snapshot

The Dashboard currently includes:

- Total Requests
- New This Week
- Active Queue
- Needs Review
- Scheduled
- To Be Scheduled
- Completed
- Cancelled / Duplicate
- Top 10 Cities by request count
- Top campaigns
- Active workflow distribution
- Top fireplace brands from **Striven Asset Make**

`Scheduled` means an active Service Request has a scheduled date in `Active Work JSON` or a linked Striven operational Work Order. `To Be Scheduled` means an active Service Request has no linked scheduled date.

The current webform does not store fireplace brand as a structured field, so the brand table intentionally uses Striven asset make rather than guessing from free-text `Unit Details`.

## Safe installation order

1. Deploy/push the v5.8.0 source.
2. Run `SETUP_previewLeanWorkbook()`.
3. Run `SETUP_createMigrationBackup()` until it reports `BACKUP_VERIFIED`.
4. Run `SETUP_continueLeanMigration()`.
5. Run `QUEUE_refresh()`.
6. Run `DIAGNOSTICS_run()`.
7. Run `GF_previewReconciliation()` and verify there are no unexpected intake gaps.
8. Submit one controlled Gravity Forms test and verify:
   - one row in `01 Webform Requests`,
   - one linked row in `02 Service Requests`,
   - same Submission ID / Request ID linkage,
   - no duplicate Submission ID or Payload Hash.

## Local clasp release

Copy `.clasp.example.json` to `.clasp.json` and insert the **existing** Apps Script project ID.

Dry-run first:

```bash
node scripts/release.mjs --deployment-id YOUR_EXISTING_WEB_APP_DEPLOYMENT_ID
```

Then execute:

```bash
node scripts/release.mjs --execute --deployment-id YOUR_EXISTING_WEB_APP_DEPLOYMENT_ID --description "CF ServiceOps v5.8.0"
```

The script runs `clasp push --force`, creates an immutable Apps Script version, then **redeploys the existing deployment ID** so the existing web-app deployment is updated instead of silently creating a separate deployment.

## GitHub deployment

A manual GitHub Actions workflow is included at `.github/workflows/deploy.yml`.

Required repository secrets:

- `CLASPRC_JSON`
- `CLASP_JSON`
- `CF_APPS_SCRIPT_DEPLOYMENT_ID`

The workflow is `workflow_dispatch` only; it does not automatically deploy every push.

## Important

This release keeps the existing Phase 5A safety posture. Live Striven mutation remains disabled unless the separate write-gate logic is deliberately changed and verified.
