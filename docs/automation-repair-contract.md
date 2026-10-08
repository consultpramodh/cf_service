# CF ServiceOps automation contract and repair record

Updated 2026-10-08. Primary goal: process requests with minimal human intervention, using the existing production system.

## Intended request lifecycle

| Step | Required result before advancing | Recovery behavior |
| --- | --- | --- |
| Intake | One Gravity Forms submission maps to one durable webform row and service request; submission ID and payload hash retained | Backstop retrieves the individual entry when the collection response lacks usable fields; reject wrong entry/form IDs |
| Queue | Request ID is durably queued for AUTO_FINAL_ServiceOps | Five-minute watchdog restores recent eligible requests; no-progress requests yield their position |
| Matching | Customer and location caches contain data; customer/contact/location identities are resolved | Empty caches use the existing report refresh; configured reports alone do not prove cache readiness |
| Customer structure | Durable customer, location and customer-scoped contact IDs are confirmed | Read and reconcile uncertain writes before retrying; preserve write journals and identity evidence |
| Order | Exactly one intended sales order exists, with required references and standard fields | Reconcile an existing order; never blindly repeat an uncertain create |
| Certification | Required order fields are read back and checked; warnings remain visible | Repair deterministic differences; escalate genuine identity conflicts with a specific reason |
| Handoff | Scheduling and downstream task stages follow the existing order status rules | Tasks start after the sales order moves to In Progress |

Terminal COMPLETED rows are not proof that newly received requests traverse this lifecycle. The frozen ten-request cohort used in the deployment workflow already consists of terminal requests.

## Confirmed findings and repairs

- GitHub production permissions and source deployment work. The main branch only contains the README; production is canonical.
- The original release reached the existing live deployment before failing its intake recovery check.
- Recent-entry collection mapping failed for submissions 3541–3543. Individual-entry fallback restored their durable local requests.
- Recovery mutation no longer runs automatically in parallel with a source deployment; push diagnostics are read-only.
- Client timeout did not establish that server work failed. Recovery must check durable state before retrying.
- Live matching readiness showed zero customer/contact cache rows while location and operational caches remained populated.
- The workbook had 19,999,992 allocated cells. The historical system log alone used 1,139,962 rows by 14 columns.
- Unused cache columns were reclaimed, freeing 509,811 cells without deleting records or allocated cache rows.
- Healthy production guards are verified without reinstalling them or competing for the installation lock.
- Readiness checks now count worksheet rows without loading full datasets.
- New requests can initiate empty-cache recovery while preserving normal API cooldowns.
- A cache refresh records its attempt before acquiring its lock. Lock failures can therefore cause a long cooldown; capacity repair resets this attempt once only when an empty customer cache gains space.

## Durable logging and cache protection

New system-log writes use a separate spreadsheet after the active log exceeds 100,000 rows. Earlier sheets and workbooks remain intact. Script Properties record the current sink ID and each historical sink. Existing ten-minute maintenance checks rotate future writes before log growth blocks request storage.

The live core utility module is patched narrowly rather than replaced wholesale. Worksheet allocation is checked before existing data is cleared, so a grid expansion failure preserves the old cache. This does not make a multi-batch worksheet replacement transactional.

## Verified live outcomes on 2026-10-08

- Customer cache restored to 68,732 rows; matching readiness has no required missing caches.
- Submissions 3540–3546 reached COMPLETED. Submission 3545 created order 27565 and passed all certification checks. Six others retain visible repairable differences on existing orders; completion is not complete field parity.
- Submission 3547 is a follow-up on existing In Progress order 26648. Exact certification found different nonzero location IDs and a different item. The request remains in review; no duplicate order should be created and existing technician/service-level values must not be replaced with intake defaults.
- Canonical Gravity Forms webhook feed 7 is active, targets the existing deployment, and matches the configured query secret. Three other active Apps Script feeds target different deployments; their purposes remain unverified.
- Source deployment 199 passed runtime checks. A later repair bounds unchanged failed review probes to once per 30 minutes and rebuilds the full queue once after draining rather than after each completed request. Its deployment result must be checked separately.

## Evidence limits and remaining verification

- Root workbook capacity and later cache-refresh lock contention are confirmed. The exact error that originally emptied the cache was not captured.
- HTTP 404 responses occurred during post-deploy checks; they do not prove source synchronization failed.
- The historical warning backlog and differences on already-completed orders require separate validation.
- Feed configuration/authentication matching is verified; delivery from a fresh real submission has not been tested independently.
- Relevant retrieved project history was used; inaccessible chats were not claimed to have been inspected.
