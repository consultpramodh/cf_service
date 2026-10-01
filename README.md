# CF ServiceOps — Production v5.14.2

This branch is the **only supported production ServiceOps model** for Classic Fireplace & BBQ Store.

## One automatic path

```
Gravity Forms / Webhook
        ↓
Durable intake + normalization
        ↓
Customer identity resolution
        ↓
Customer reuse / guarded create
        ↓
Customer-scoped Contact resolution / guarded create
        ↓
Primary Location reuse / guarded create / targeted reconciliation
        ↓
Customer + address enrichment
        ↓
History + Assets
        ↓
Existing Service Work Order reconciliation
        ↓
Guarded Service Work Order create only if absent
        ↓
Exact GET certification
        ↓
Operator Queue projection
```

ServiceOps ends at the certified Service Work Order. Service Task creation remains downstream and begins after the Work Order is moved to **In Progress**.

## The only ServiceOps automation model

The Apps Script source contains exactly one workflow controller:

- `CF.EventDrivenServiceAutomation` in `70_Workflow_Automation.gs`

It uses exactly two public automation handlers:

- `AUTO_FINAL_ServiceOps` — the request worker
- `AUTO_98_E2E_Recovery_Watchdog` — liveness/recovery

Customer/Contact/Location structure is handled by one internal request-scoped helper:

- `CF.CustomerStructureEngine`

The source contains **no** historical `AUTO_00`–`AUTO_05` phase handlers, no old `AUTO_processCustomerStructure`, no old `CF.AutoCustomerStructure`, and no runtime worker monkey-patching layer.

## Intake

`20_Intake_Processing.gs` owns durable webhook receipt and normalized Service Request creation.

It does **not** run staged Customer/Location/Operational report refreshes. A successfully created request calls:

`CF.EventDrivenServiceAutomation.kick(requestId)`

and the final request worker takes over.

## Customer

- Exact deterministic identity evidence first.
- Same surname alone never establishes identity.
- Approved exact-address household rules may reuse an existing Customer.
- Genuine ambiguity stops safely.
- Customer creation is guarded and idempotent.

## Contact

- The canonical Contact is customer-scoped under the resolved Customer.
- A global duplicate Contact is evidence only.
- A customer-scoped Contact ID is never blindly treated as a global `/v1/contacts/{id}` ID.
- v5.14.2 persists the verified Customer-scoped Contact ID separately in the request write journal as `contactIdentity.customerScopedContactId`.
- The Operator Queue uses the Customer-scoped ID for `/next/crm#/accounts/{customerId}/contacts/{customerScopedContactId}`.
- When only a global Contact ID is known, the Queue uses the legacy `/CRM/ContactInfo.aspx?ContactID={globalContactId}` route instead of constructing an invalid Customer-scoped URL.
- The existing recovery watchdog refreshes Contact report evidence and backfills Customer-scoped Contact IDs while the live request queue is idle.
- Customer enrichment can still run when Contact write enrichment is deferred.
- Uncertain writes are not automatically repeated.

## Primary Location

- Primary Location name is exactly `Primary Location`.
- Street belongs in Address fields.
- Matching uses resolved Customer + canonical premises identity.
- Same street/city with blank or placeholder historical postal is treated as incomplete data, not automatically as a different Location.
- If same-premises duplicates exist and exactly one is `Primary Location`, that Location is preferred.
- Genuine conflicting addresses remain blocked.
- Per-request reconciliation uses targeted Customer-Location reads, not a full Location report refresh.

## Address enrichment

The structured webform address is preserved.

When Striven contains an obviously incomplete version of the same premises, Customer address fields may be enriched from the complete submitted Street, City, Province, Postal Code and Country.

A genuinely different address is not overwritten.

## History and Assets

History and Assets remain part of Work Order preparation and are associated with the resolved Customer/Location.

Shared Striven reports are candidate/discovery caches. **Cache absence never proves that a Striven entity does not exist.**

## Service Work Order

Before CREATE:

1. durable Customer must exist;
2. durable customer-scoped Contact must exist;
3. durable Location must exist;
4. existing/durable Work Order evidence is reconciled;
5. service details, Assets, Internal Notes and required fields are built;
6. duplicate/open-work safety must pass;
7. write journal/idempotency safeguards must pass.

Production defaults retained by the guarded writer include:

- standard service item `41481`
- Sales Order type `44938`
- payment term `13`
- initial status Quoted `19`
- Internal Notes `{NotesHtml, NotesText}`
- resolved Location for Bill To and Ship To

A create write is attempted once. The resulting Work Order is then certified by authoritative read. An uncertain write switches to read-only reconciliation; it does not automatically POST again.

For an existing Service Work Order that was created manually rather than by ServiceOps, v5.14.2 runs the proven official-API Internal Notes reconciliation before certification. It builds the canonical `WEBFORM SERVICE REQUEST` notes from the normalized request, performs GET → one guarded POST → GET verification, preserves Custom Fields, and never automatically retries an uncertain write. The idle watchdog also works through existing manual Work Orders in bounded steps.

## Request isolation

Every operation is request-scoped.

A result that references a different Request ID is rejected and cannot advance or park the current request.

The watchdog contains a narrow recovery rule for the known false `PREFLIGHT_BLOCKED` state only when no durable IDs or remote write attempts exist.

## Recovery

The permanent watchdog is:

`AUTO_98_E2E_Recovery_Watchdog`

It can recover recent safe incomplete requests and schedule:

`AUTO_FINAL_ServiceOps`

Genuine review/identity conflicts are not silently cleared.

## Shared-cache maintenance

`99_Production_Hardening.gs` contains no workflow wrappers.

Its only automation role is the independent idle maintenance function:

`CFH_refreshOperationalCacheIfIdle`

It refreshes the shared Operational cache only while the live request queue is empty and the cache is stale.

## Production deployment

Apps Script Script ID:

`1QZp4NAFeA8LmWBN31ylJYdK4XFepBX1h2lP_APaR-d1lTAC-d8LA9x3g`

Existing web-app deployment:

`AKfycbwebnCvczGthe6Z_mvYmukLqFLB-9nk8hjNtNP3lR87CE1m_fEx2d9Bn_vpXMPCLUnPbA`

Authenticated production release:

```bash
node scripts/release.mjs --execute
```

The release script:

1. authenticates with clasp 3.3.0;
2. pulls the exact live bound project;
3. creates a complete checkpoint;
4. replaces only the seven finalized modules;
5. verifies inventory and patch scope;
6. rejects any legacy automation handler source;
7. syntax-checks the release;
8. pushes the complete project to the same Script ID;
9. pulls it back and verifies exact source parity;
10. rejects any legacy automation source in the remote project;
11. versions and redeploys the existing web app.

The seven finalized modules are:

- `src/20_Intake_Processing.gs`
- `src/40_Matching_Profile.gs`
- `src/50_Operator_Queue.gs`
- `src/60_Striven_Write.gs`
- `src/70_Workflow_Automation.gs`
- `src/95_Public_Runners.gs`
- `src/99_Production_Hardening.gs`

After deployment, the existing watchdog trigger retains the same public function name and will execute the v5.14.2 watchdog. Its first run removes obsolete automation triggers, recovers safe recent requests, and schedules `AUTO_FINAL_ServiceOps`.

Run `FINALIZE_20260930_verifySingleServiceOpsModel()` to verify the trigger topology. A passing result is:

- `singleModel = true`
- `legacyAutomationTriggerCount = 0`
- exactly one recovery watchdog
- at most one one-shot `AUTO_FINAL_ServiceOps` worker

Do not add phase-specific ServiceOps automation back into the project.
