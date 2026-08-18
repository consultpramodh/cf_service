# Post-deploy checklist

- [ ] `SETUP_previewLeanWorkbook()` reports no sheet-name conflicts.
- [ ] `SETUP_createMigrationBackup()` reports `BACKUP_VERIFIED`.
- [ ] `SETUP_continueLeanMigration()` reports `durableDataPreserved: true`.
- [ ] Only `00 Dashboard` and `03 Operator Queue` are visible.
- [ ] `01 Webform Requests` historical row count is unchanged.
- [ ] `02 Service Requests` historical row count is unchanged.
- [ ] `QUEUE_refresh()` completes and every row has consistent wrapping/height/dropdown/checkbox formatting.
- [ ] `DIAGNOSTICS_run()` has zero errors.
- [ ] `GF_previewReconciliation()` does not show unexpected missing entries.
- [ ] One controlled Gravity Forms submission creates exactly one Webform row and one linked Service Request row.
- [ ] `doGet()` reports version `5.8.0` after the existing web-app deployment is redeployed.
