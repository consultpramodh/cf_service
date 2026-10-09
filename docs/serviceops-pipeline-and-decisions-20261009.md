# CF ServiceOps: verified pipeline and decision rules
Checked October 9, 2026, America/Toronto. Runtime release 5.14.4; active saved version 201.

## What this system actually completes
The canonical path receives a service request, resolves or creates Customer, Location and Contact records, synchronizes required information, creates or reuses one Service Sales Order, reads it back and certifies it. COMPLETED is completion of intake/order certification. It is not proof that a technician was assigned, a calendar appointment was created, the work was performed, printing occurred, or payment was collected.

The latest worker, intake, matching, writer and hardening source was fetched from GitHub. SHA-256 of the five corresponding source strings matched the live Apps Script version-201 backup. The current Public Runners has an additional bounded maintenance runner compared with saved version 201. JEV is not a runtime dependency found in these sources; its skill was applied to the proposed decision boundary below.

## Trigger inventory
Installed trigger UI showed six records at approximately 11:27 AM Toronto time:

| Entry point | Starts when | Responsibility | Verified nuance |
| --- | --- | --- | --- |
| doPost -> CF.Intake.handlePost | Gravity Forms sends an HTTP POST to the production web app | Validate secret, normalize and durably store request, kick canonical worker | Successful receipt does not mean a Striven order exists |
| AUTO_FINAL_ServiceOps | A request kick schedules a one-shot worker; continuations schedule another | Run request-scoped stages | UI showed the installed worker expired; Google says it fired once and was disabled |
| AUTO_98_E2E_Recovery_Watchdog | Every 5 minutes in installer source | Normalize worker topology, recover eligible recent requests, schedule continuation | Present and recently executing; existing trigger presence alone does not prove worker liveness |
| AUTO_00_GF_Intake_Backstop | Every 5 minutes in installer source | Inspect newest 25 form entries, recover up to 5 missing/incomplete local pairs, within 60 seconds | Not a full historical replay; recent pending NEW INTAKE records can also be kicked |
| CFH_refreshOperationalCacheIfIdle | Every 10 minutes in installer source | Refresh operational cache if queue empty and cache at least 18 minutes old | Skips Striven report refresh while queue active |
| AUTO_CF_QUEUE_SYNC_AFTER_SERVICE_REQUEST_MUTATION | Deferred one-shot after request-ledger mutation | Project changed request rows into operator queue | UI showed expired |
| CFH_refreshOperatorQueueDeferred | Deferred one-shot queue refresh | Refresh operator projection | UI showed expired |
| Selected-row manual rerun | Operator selects a request and invokes testing/menu action | Queue the same Request ID | Uses canonical pipeline; does not authorize a duplicate order |

The webhook is not an installed time trigger. Therefore the table contains one HTTP entry point and six installed trigger records, not seven installed triggers. Source cadence is distinguished from the observed last-run times. Apps Script after(1000) is a requested delay, not a guaranteed one-second SLA.

## Stage 1: receipt and idempotent storage
Trigger: doPost(e) -> CF.Intake.handlePost(e).

Conceptual pseudocode, not executable:
~~~text
IF payload cannot be parsed OR webhook secret fails
    reject; do not create a request
ELSE strip sensitive transport fields and normalize submitted fields
    look up Submission ID / payload identity in both intake ledgers
    IF both ledger records exist
        reuse the existing Request ID
        acknowledge duplicate receipt
        do not append another request
        current handlePost does not kick duplicate receipts
    ELSE IF one ledger record exists
        repair the missing side using the same Request ID
    ELSE
        store Webform Request and Service Request durably
    IF receipt succeeded AND it is not a duplicate
        kick the canonical worker for this Request ID
    return receipt acknowledgement
~~~

The fast HTTP path does not do matching, refresh reports, create Striven entities, or refresh the whole dashboard. The backstop uses the same durable identity and rehydrates incomplete data instead of duplicating submissions.

## Stage 2: queue and continuation
Trigger: CF.EventDrivenServiceAutomation.kick(requestId).

~~~text
IF Request ID is blank
    return REQUEST_ID_REQUIRED
ELSE ensure canonical automation flags are enabled
    IF already queued
        preserve queue position and healthy worker
    ELSE
        put this request at the front
    ensure exactly one watchdog
    ensure a one-shot worker exists
~~~

The worker does at most 12 internal steps within a 220-second budget. After a live write it normally yields and requests a continuation around 10 seconds later. No durable progress rotates the request behind other requests; if none can progress, continuation delay is at least 60 seconds. A worker considered stale by source logic after 10 minutes can be replaced by the watchdog.

Current gap: ensureWorker checks handler existence and stored scheduled time. The UI can show an expired one-shot record while the health endpoint still counts that handler. Trigger count is a topology check, not proof that work will run.

## Stage 3: dispatch the correct stage
Trigger: AUTO_FINAL_ServiceOps -> worker -> step_.

~~~text
IF request does not exist
    remove it from work queue
ELSE attempt only explicitly proven technical-state recovery
    IF completed/cancelled
        dequeue; no new entity creation
    ELSE IF genuine review or duplicate risk remains
        normal worker dequeues it; keep operator review visible
    ELSE IF durable Work Order ID exists
        certify that existing order; never create another
    ELSE IF Customer Structure is not complete
        run CustomerStructureEngine.step for this request
    ELSE IF Customer + Contact information is not confirmed
        run CustomerContactInfoSync.reconcile
    ELSE
        run guarded Work Order preflight/create/certification
~~~

Direct acceptance/scoped recovery can recertify a known order even when a row was parked. The normal worker checks genuine review before step_, so a conflict does not grant automatic permission to rewrite an existing order.

## Stage 4: Customer matching
Trigger: CustomerStructureEngine sees NEW INTAKE -> CF.Matching.recheckRequest.

~~~text
IF required matching-cache configuration is absent
    do not guess
ELSE IF required customer/location cache is empty and recoverable
    refresh the relevant cache; rerun this stage
ELSE build exact normalized candidate sets
    IF matched email/phone signals point to disjoint Customers
        REVIEW
    ELSE IF all matched primary signals identify one Customer
        IF exact address+name identifies a different Customer
            REVIEW
        ELSE reuse the primary Customer
    ELSE IF shared primary candidates contain one exact address+name match
        reuse that Customer
    ELSE IF primary evidence remains ambiguous
        REVIEW
    ELSE IF exact address+name identifies exactly one Customer
        reuse
    ELSE IF exact service address+surname identifies one household Customer
        reuse that household
    ELSE IF those corroborated rules return several Customers
        REVIEW
    ELSE
        no corroborated match; prepare new Customer creation
        name-only/address-only candidates are informational, not auto-links
~~~

No record is linked purely because a name sounds similar.

## Stage 5: service Location
Matching evaluates Customer, Contact and Location together. When records are missing, execution generally resolves Customer -> Location -> Contact, not Customer -> Contact -> Location.

~~~text
IF Customer is unresolved
    resolve/create Customer first
ELSE IF an operator-selected Location is not owned by that Customer
    reject selection
ELSE IF one canonical full-address match exists
    reuse
ELSE IF one exact street+postal match exists
    reuse
ELSE IF exact street+city matches a Location with missing/placeholder postal
    IF one candidate OR one uniquely named Primary Location among candidates
        reuse
    ELSE REVIEW
ELSE IF exact matching returns multiple viable Locations
    REVIEW
ELSE
    guarded create/reconcile a new Location on the resolved Customer
~~~

Postal-only or fuzzy location matching cannot auto-link. A real nonblank postal conflict is not treated as missing data.

## Stage 6: person Contact
Contact candidate search is scoped to the resolved Customer.

~~~text
IF no durable Customer/Location
    finish those records first
ELSE IF supplied email/phone identifies one compatible person/household member
    reuse and verify association
ELSE IF identifier belongs to another named person and no safe fallback resolves it
    REVIEW
ELSE IF one compatible exact name exists within this Customer
    reuse; later synchronize submitted phone/email
ELSE IF multiple compatible contacts remain
    REVIEW
ELSE
    guarded create Contact and verify its Customer association
~~~

Current policy difference: exact name within a resolved Customer can reuse the existing Contact and enrich its phone/email. This is not an unconditional “new email or phone -> new Contact” rule. Distinguish a changed phone for the same person from a different household member.

## Stage 7: guarded entity writes and information synchronization
Used by Customer, Location and Contact creators, plus CustomerContactInfoSync.

~~~text
IF a durable entity ID already exists
    GET/reconcile it
ELSE IF a previous POST may have succeeded
    search/GET the remote result; never blindly repeat POST
ELSE IF preflight, identity or association rules fail
    retain precise blocking reason
ELSE
    record write intent in durable journal
    perform one guarded write
    IF response or outcome is uncertain
        record uncertainty; future work is reconciliation
    ELSE GET and verify before advancing
~~~

Customer + Contact information reconciliation fetches the current records, preserves the DTO contract, writes only through its guarded path, and confirms required information. A documented collateral Customer custom-field validation can bypass optional enrichment; it must not be described as every Customer field having been fully updated.

## Stage 8: active-work duplicate check and order draft
Trigger: structure and required information are ready, with no durable order ID.

~~~text
IF active work/task is proven at this same service location
    block new order; link/reconcile existing work where proven
ELSE active work at other locations is informational
    prepare one Service Sales Order
    IF uniquely resolved asset can supply manufacturer/model
        use it
    ELSE IF webform supplies make/model/age
        use explicit submitted details
    ELSE IF no asset exists and webform detail is blank
        current draft can use "Unknown / Not Provided"
    ELSE IF ambiguous/conflicting asset is needed to supply missing detail
        REVIEW
    serial remains blank unless sourced from a resolved asset
    map source, preferred days, notes and dropdowns to verified field/list IDs
~~~

Current item policy:
~~~text
IF Campaign Code == EB2026 OR Toronto business submission date <= 2026-09-25
    select Early Bird item 41434
ELSE
    select standard item 41481
read current item information/price; do not invent it
~~~

The campaign condition overrides the cutoff. A post-cutoff EB2026-tagged request still receives Early Bird. Invalid/unparseable submission dates currently fall back to the current date, another boundary to tighten if strict historical eligibility is required.

Gas-only is the business requirement. No explicit gas/wood/electric eligibility gate was located in the inspected canonical pipeline source. Form-side enforcement has not been established here. Therefore gas-only intake cannot be claimed as independently enforced by this backend.

## Stage 9: approve and create one Sales Order
Trigger: no known order ID, no duplicate risk, structure and draft are valid.

~~~text
IF live/readiness or operational evidence fails
    refresh evidence where the code explicitly supports it; rerun
ELSE IF required draft/contract fields fail
    REVIEW with precise blockers
ELSE approve current payload fingerprint
    immediately recheck for an order created meanwhile
    IF an order is now known
        certify existing order
    ELSE IF prior uncertain write journal exists
        read-only reconciliation, not another create
    ELSE record POST intent
        create once as Quoted (status 19)
        GET the result and certify it
~~~

“Approval” here is the guarded code/journal authorization of a payload, not a required manual click for every eligible request. Final certification does not automatically flip the Striven order to In Progress.

## Stage 10: certification, metadata and final status
Trigger: order POST returned an ID, a prior ID was recovered, or an existing order was linked.

~~~text
IF order GET fails transiently
    preserve known ID; retry GET later
ELSE compare actual order with durable request and expected payload
    IF wrong Customer/identity, different nonzero Location, or another hard conflict
        NEEDS REVIEW / BLOCKED
        Next Action = REVIEW EXISTING SALES ORDER - DO NOT CREATE AGAIN
    ELSE
        current policy accepts certain repairable differences:
        - custom-field mismatches
        - both order location representations blank/0 with proven identity
        - specified task-backed line/contact representation cases
        IF missing Request Source is blank and certified WEBFORM evidence is exact
            guarded one-field repair; preserve other order fields; GET verify
            recertify if repair verified
        mark local request COMPLETED
        persist order ID/number/link and certification journal
~~~

Important: every custom-field mismatch is currently categorized as repairable for certification. “COMPLETED with repairable differences” must not be presented as all fields matching. Blank bill/ship representations are different from the confirmed nonzero Location conflict on order 26648.

## Stage 11: operator projection and downstream boundary
Request-ledger mutations mark operator rows dirty. Deferred mutation sync refreshes selected requests, or a coalesced whole queue for more than eight dirty rows. The canonical worker also refreshes the queue at the end.

The queue and dashboard are projections, not a separate authority to create Striven records. A projection mismatch calls for refresh/parity verification, not recreating entities.

Service scheduling, technician assignment, service task/calendar mapping, printing and collection belong to downstream processes. The canonical request dispatcher inspected here ends at certified order completion. Their existence in other projects is not evidence that this request automatically passed those downstream stages.

## Example: normal route versus conflict route
Illustrative normal case, not a claim about an actual customer's intermediate history:
1. A person submits a gas fireplace service request.
2. New Submission ID is stored in both ledgers.
3. Exact email/phone identifies one Customer.
4. Service street/postal identifies one Location.
5. The compatible Contact is reused or a missing Contact is created after Location confirmation.
6. Required information is reconciled.
7. No active work is found at that service location.
8. A post-September-25 request without EB2026 selects standard item 41481.
9. One Quoted order is created, GET-verified and certified.
10. Intake status becomes COMPLETED; scheduling remains a separate operational obligation.

Observed real cases:
- Submission 3549 -> SR-20261008220059-3832 -> order 27591: local snapshot reported COMPLETED / SALES ORDER VERIFIED.
- Submission 3547 -> SR-20261008130055-2412 -> order 26648 (number 584918): scoped recheck retained PROVEN_LOCATION_CONFLICT_RETAINED, NEEDS REVIEW, BLOCKED, no Striven write. Request's expected Location was 58437. The conflicting order Location ID was not supplied by that endpoint and must not be invented.
- Five order Request Source field-855 repairs (27517, 27542, 27546, 27562, 27564) completed with VERIFIED, otherFieldsPreserved:true. This establishes that field repair, not that every remaining custom field is exact.

## How JEV simplifies the decision boundary
Applied the installed JEV skill and read live TypeSafe Choice/Noul documentation. No Jev API call or production integration was executed. Installing a skill does not automatically make it part of Apps Script.

Use deterministic code first. Only ambiguous semantic evidence reaches JEV.

| Narrow judgment | Evidence supplied | Primitive | Allowed outcome |
| --- | --- | --- | --- |
| Is this a minor variation of the same person's name under our policy? | Parsed names plus corroborating identifier evidence | Noul | Support compatible person; uncertainty -> review |
| Is this the same household but a different person? | Submitted person and known household member candidates | Choice | SAME_PERSON, OTHER_HOUSEHOLD_MEMBER, NO_MATCH, UNCERTAIN |
| Which supplied asset does the submitted make/model refer to? | Existing asset candidates at verified Customer/Location | Choice | Supplied candidate or NO_MATCH/UNCERTAIN |
| Do these notes preserve the same submitted service details? | Original request and read-back notes | Noul | Support semantic equivalence; code separately checks required exact fields |
| Does free text clearly identify a gas fireplace? | Submitted appliance description | Choice | GAS, WOOD, ELECTRIC, OTHER, UNCERTAIN; code applies gas-only policy |

Central proposed rule, not deployed:
~~~text
IF deterministic prohibition/conflict exists
    BLOCK or REVIEW
ELSE IF deterministic rules uniquely resolve the action
    proceed without JEV
ELSE provide only known candidates and relevant evidence to JEV
    IF service error, uncertainty, uncalibrated threshold or out-of-set answer
        REVIEW; no write
    ELSE validate answer against candidate set and hard policy
        use existing guarded code to perform allowed action
~~~

Do not invent a universal confidence percentage. Calibrate question-specific auto-action thresholds on real positive, negative, ambiguous, changed-contact, conflicting-location, no-match and service-failure cases. Until calibrated, semantic cases remain review/shadow recommendations.

JEV must not choose arbitrary IDs, alter dates/prices, authorize a duplicate POST, overwrite staff decisions, delete versions, or clear order 26648's proven Location conflict.

## Version backup and prepared cleanup
All 200 currently saved versions (1-198, 200, 201) plus editable HEAD were exported. Source strings, archive bytes and manifests were read back from GitHub and hash-verified. Backup commit:
90c9cbcbe10ed8874e7e859e830ff93ccafd912d

Directory: backups/apps-script/full-history-20261009/
Run: https://github.com/consultpramodh/cf_service/actions/runs/37951731848
Version 199 was previously archived exactly at commit 31bc136135233a71163543cecfed2fef64ddeb35 and deleted.

One active versioned deployment uses version 201 at the existing production deployment ID/URL. An unversioned system deployment record also exists; it is not an older numbered code snapshot. Archived deployment history is distinct from saved source versions.

Prepared permanent cleanup: retain 201; delete versions 1-198 and 200, 199 source versions in total. UI permits at most 100 deletions per batch. First batch selected is 200 and 100-198; second would be 1-99. No new deletion performed at this checkpoint; action-time confirmation required.

Backups restore source into a new version; deleted numeric version IDs cannot be resurrected. Script Properties, credentials, spreadsheet data, installed triggers and external records are not included in a source-version export, and are not deleted by this cleanup. UI warns consumers pinned to old library versions may be affected; absence of those consumers has not been established.

## Evidence links
- Current orchestration: https://github.com/consultpramodh/cf_service/blob/90c9cbcbe10ed8874e7e859e830ff93ccafd912d/src/70_Workflow_Automation.gs
- Current matching: https://github.com/consultpramodh/cf_service/blob/90c9cbcbe10ed8874e7e859e830ff93ccafd912d/src/40_Matching_Profile.gs
- Current writer: https://github.com/consultpramodh/cf_service/blob/90c9cbcbe10ed8874e7e859e830ff93ccafd912d/src/60_Striven_Write.gs
- Current intake: https://github.com/consultpramodh/cf_service/blob/90c9cbcbe10ed8874e7e859e830ff93ccafd912d/src/20_Intake_Processing.gs
- Live endpoint evidence: https://github.com/consultpramodh/cf_service/actions/runs/37950608365
- TypeSafe Choice: https://docs.typesafe.ai/primitives/choice
- TypeSafe Noul: https://docs.typesafe.ai/primitives/noul
- Google source versions/deletion: https://developers.google.com/apps-script/guides/versions

## Next correction path
Worker-liveness proof -> explicit gas eligibility -> settle Early Bird campaign/cutoff rule -> separate intake-complete from service-complete -> calibrate semantic JEV decisions in shadow mode -> verify downstream scheduling/task/printing independently. Version cleanup is prepared after successful source backup, not a substitute for these behavioral corrections.
