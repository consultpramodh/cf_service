# Apps Script release and retention rule

User-directed rule, effective 2026-10-15. Applies to CF ServiceOps.

1. Pull and back up the live source before changes. Preserve interfaces and unrelated files.
2. Before retiring any saved version, archive its complete source and manifest in GitHub. Verify archive integrity, every source checksum, and remote GitHub file identity. Preserve recovery instructions; exclude secrets.
3. Create the replacement version and update the existing production deployment ID and URL. Confirm that the deployment points to the replacement. Run available runtime and targeted recovery checks; distinguish deployment confirmation from runtime verification.
4. Only after the new deployment is confirmed and backups pass, delete superseded saved Apps Script versions. Keep exactly one latest active production version. Never delete a version still referenced by another active deployment or a known external dependency.
5. Preserve runtime settings, credentials, triggers and spreadsheet data separately; source archives do not restore these. Deleted version numbers cannot be restored; archived source can be republished under a new number.
6. Respect any platform requirement for confirmation at the final permanent-delete action.

## Verified checkpoint — 2026-10-15

Versions 1–201 are archived under backups/apps-script/full-history-20261009, with version 199 separately under backups/apps-script/version-199. All 423 tracked backup files matched GitHub during the deletion-time recheck. Google confirmed the existing production deployment updated to version 202, then confirmed only one saved version remained after removal of version 201. Runtime HTTP health verification was blocked by browser ERR_BLOCKED_BY_CLIENT and remains distinct from deployment success.
