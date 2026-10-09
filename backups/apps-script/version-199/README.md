# Apps Script version 199 — exact source backup

This backup contains all 17 files from the deployment verification artifact for Apps Script version 199. File bytes are preserved, including the freshly pulled live modules that differ from canonical src files. SHA256.json records SHA-256 and Git blob hashes for every file.

Source run: https://github.com/consultpramodh/cf_service/actions/runs/37812168092

## Recovery

Copy all files under source/ into an isolated clasp checkout configured for the existing script ID recorded in SHA256.json. Verify every SHA-256 before a complete-project push. Use the existing checkpoint, push, remote read-back, version, and same-deployment procedure. Restore runtime settings and secrets from their existing secure configuration; this backup contains source only, not script properties, spreadsheet data, triggers, or credentials.

Deleting historical version 199 cannot restore its original version number. These files allow its exact source to be published as a new version. Do not deploy this backup merely to inspect it.
