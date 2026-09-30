# CF ServiceOps — Production v5.14.0

This branch is the **canonical production source** for the Classic Fireplace & BBQ Store ServiceOps pipeline.

There is one supported automatic path:

```
Gravity Forms / Webhook
        ↓
Durable intake + normalized Service Request
        ↓
Customer identity resolution
        ↓
Customer reuse / create
        ↓
Contact ownership / create / reconcile
        ↓
Primary Location reuse / create / reconcile
        ↓
Customer address/contact enrichment
        ↓
History + assets
        ↓
Authoritative existing Service Work Order check
        ↓
Guarded Service Work Order create if absent
        ↓
Exact GET certification
        ↓
Operator Queue projection
```

Task creation is intentionally outside this ServiceOps boundary. Service Tasks are created by the downstream Task Mapping workflow after the Service Work Order moves to **In Progress**.

## Canonical automation handlers

Only two automation concepts are active in v5.14.0:

- `AUTO_FINAL_ServiceOps` — the single end-to-end request worker.
- `AUTO_98_E2E_Recovery_Watchdog` — the permanent liveness/recovery watchdog.

Historical handlers such as `AUTO_processCustomerStructure`, `AUTO_00_E2E_Route_Request`, `AUTO_01_E2E_Customer_Match_Create`, through `AUTO_05_E2E_Sales_Order_Create_Verify`, and `AUTO_99_E2E_Safe_Stop_Review` are compatibility aliases only. They enter `AUTO_FINAL_ServiceOps`; they no longer own separate workflow behavior.

The canonical worker automatically replaces legacy phase triggers with the canonical worker/watchdog topology.

## Deterministic rules

### Customer
- Exact deterministic identity evidence is evaluated first.
- Same surname alone never establishes identity.
- Exact address + compatible household identity may reuse the household Customer under the approved identity policy.
- New phone/email may require a new Contact rather than a new Customer.
- Genuine identity conflicts route to review.

### Contact
- Customer-scoped Contacts are resolved under the Customer.
- A global duplicate Contact ID is evidence only; it does not prove Customer ownership.
- Customer-scoped Contact references are never blindly treated as global `/v1/contacts/{id}` IDs.
- Uncertain writes are never automatically repeated.

### Primary Location
- Primary service Location name is exactly `Primary Location`.
- Street belongs in the Address fields, not the Location Name.
- Same Customer + same canonical street/city + blank/placeholder postal means incomplete historical data, not automatically a different Location.
- A unique existing `Primary Location` is preferred over creating another same-premises Location.
- A real populated conflicting address/postal blocks unsafe reuse.
- Per-request verification uses targeted Customer-Location reads; full Location reports are discovery caches only.

### Address enrichment
- Structured webform Street, City, Province, Postal Code and Country are preserved.
- An obviously incomplete same-premises Customer address may be enriched.
- A genuinely different Customer address is preserved.
- Geocoding is not required when the submitted structured address is already complete.

### History / Assets
- History and asset data are contextual evidence and must be associated with the resolved Customer/Location.
- Cache absence does not prove that a Striven entity does not exist.

### Service Work Order
Before CREATE, the pipeline performs authoritative existing-record reconciliation.

Required structure:
- durable Customer ID
- durable customer-scoped Contact
- durable Primary Location ID
- service details / price
- duplicate/open-work safety
- idempotency/write journal

Default Service Work Order rules retained from the production project include:
- standard service item `41481`
- Sales Order type `44938`
- payment term `13`
- initial status Quoted `19`
- Internal Notes and approved custom-field mapping
- resolved Location ID for Bill To and Ship To

The writer performs at most one mutating POST for the create attempt, then certifies by read. If a write may have succeeded, the system reconciles by read and does not automatically POST again.

### Queue
`02 Service Requests` is the durable workflow ledger.
`03 Operator Queue` is the operator-facing projection.
Shared Striven reports are caches for discovery and display; absence from a report is never authoritative proof of non-existence.

## Request isolation

v5.14.0 enforces Request-ID integrity at the orchestration boundary.

A result generated for a different Request ID cannot advance, park, or mutate the current request. Cross-request results are rejected and logged.

The recovery watchdog has a narrow self-healing rule for the known false `PREFLIGHT_BLOCKED` technical-park pattern when:
- there is no durable Customer/Contact/Location/Work Order ID,
- no corresponding POST attempt occurred,
- duplicate risk is NONE,
- the row itself still requires CREATE actions.

Genuine ambiguity/review states are not auto-cleared.

## API-call policy

Use the least expensive authoritative evidence:

1. durable request/journal IDs
2. current request-scoped targeted GET/search
3. shared caches for candidate discovery
4. full report refresh only for scheduled shared-cache maintenance, not per-request verification

Do not refresh an entire report merely to verify one Customer, Contact, Location, or Work Order.

## Production deployment

Script ID:

`1QZp4NAFeA8LmWBN31ylJYdK4XFepBX1h2lP_APaR-d1lTAC-d8LA9x3g`

Existing web-app deployment:

`AKfycbwebnCvczGthe6Z_mvYmukLqFLB-9nk8hjNtNP3lR87CE1m_fEx2d9Bn_vpXMPCLUnPbA`

Normal local release is one command:

```bash
node scripts/release.mjs --execute
```

The release script performs:

1. authenticate with pinned clasp 3.3.0
2. pull the current live bound project
3. create a complete pre-change checkpoint
4. replace only the five v5.14.0 modules
5. verify file inventory and changed-file scope
6. syntax/self-test the release
7. push the complete project to the same Script ID
8. pull the remote project back and verify content parity
9. create an immutable Apps Script version
10. redeploy the existing `/exec`

A manual GitHub Actions deployment is also available in `.github/workflows/deploy.yml`.

## Finalized v5.14.0 modules

- `src/40_Matching_Profile.gs`
- `src/50_Operator_Queue.gs`
- `src/60_Striven_Write.gs`
- `src/70_Workflow_Automation.gs`
- `src/95_Public_Runners.gs`

Do not create a new Apps Script file for incremental ServiceOps stages. Extend/consolidate the existing modules unless a genuinely separate subsystem requires a new module.
