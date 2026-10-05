# CF ServiceOps automation

This branch is the permanent release path for CF ServiceOps. Do not create a new branch for each release.

## Release contract

Every release must:

1. Pull the CURRENT live Apps Script HEAD for Script ID `1QZp4NAFeA8LmWBN31ylJYdK4XFepBX1h2lP_APaR-d1lTAC-d8LA9x3g`.
2. Refuse a source older than the minimum verified production version.
3. Snapshot the pulled source before changing anything.
4. Apply only guarded, source-aware transformations.
5. Preserve finalized locks in `automation/release-locks.json`.
6. Syntax-check changed files and reject unexpected changed files.
7. Push the COMPLETE project back to the same Script ID.
8. Pull remote source and SHA-verify parity.
9. Create an immutable Apps Script version.
10. Update the EXISTING production deployment `AKfycbwebnCvczGthe6Z_mvYmukLqFLB-9nk8hjNtNP3lR87CE1m_fEx2d9Bn_vpXMPCLUnPbA`.
11. Verify the production health response.
12. Never lower a safety guard merely to reduce API calls.

## Current API policy

The first API-efficiency release removes the legacy 10-minute idle Operational refresh loop. The Sales Order path already performs an on-demand Operational refresh when its cache is stale, so the periodic poll is not required for correctness.

Customer/Contact bulk cache TTL is deliberately left unchanged in this release. The pre-write duplicate guard still depends on fresh identity evidence; increasing that TTL before a request-scoped lookup is proven would trade API savings for duplicate-customer risk.

## Authentication

The GitHub Action expects the repository secret `CLASPRC_JSON` containing the authenticated clasp credential JSON. Credentials must never be committed to this repository.
