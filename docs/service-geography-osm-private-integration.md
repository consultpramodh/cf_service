# CF Service — OpenStreetMap geography (shadow mode)

Status: **implemented in feature branch, NOT enabled in production**.

## Decision
OpenStreetMap data identifies addresses and municipal boundaries; Classic Fireplace controls the service policy and Striven Zones **custom field 798** (IDs 506–510). Municipal zone selection and physical service eligibility are separate outputs.

The public Nominatim server **must not receive private residential customer addresses**. The official policy prohibits submitting personal or confidential data; requires identification, attribution, caching and very low request rates; disallows regular bulk geocoding. Review: https://operations.osmfoundation.org/policies/nominatim/

Use a **self-hosted or separately contracted/private Nominatim-compatible geocoder**, subject to a proper privacy review and provider agreement. Not the donated public service.

## Implemented

- `CF.ServiceGeo` in existing `src/70_Workflow_Automation.gs` (no extra Apps Script source files / no deployment version added)
- Disabled by default; never called by the Sales Order writer or during intake
- Manual `GEO_TEST_selectedQueueRequest()` runner (select a non-header row in `03 Operator Queue` before running from editor)
- Reads request data from `02 Service Requests`, validates street number, street, province, six-character postal code, and country
- Looks for a durable SHA256-keyed result in hidden technical tab `10 Service Geocodes — Private` and six-hour ScriptCache
- Calls an approved privately operated Nominatim JSONv2 `/search` endpoint *at most once per cache miss*; no public Nominatim host permitted. Single-threaded under Apps Script lock; minimum 15 seconds between calls, no retries/bulk runs
- Must verify exact house number, road, postal, Canadian country code, and return one unambiguous OSM feature
- Disagreed municipality, missing address component, ambiguous match, provider outage or throttling => REVIEW; never guessed
- Compares result with five store pins from `09 Store Locations — Geo Pending`. All five must have valid coordinates and a `VERIFIED...` marker before distance preview is available.
- Core: straight-line distance <=25 km, review buffer: 25–30 km, outside: >30 km; exact boundary policy pending approval. This is *not drive time*.
- Results **PREVIEW_ONLY**, no automatic location approval, no Striven API requests, no Sales Order creation, no silent status rewrites.
- Cache retains only hashed normalized address fingerprint, coordinates, municipality, OSM identity, timestamp, provider marker and match status, not raw customer name/address/phone/email. Hidden Sheet is *not an access-control substitute*: restrict spreadsheet sharing and review retention/access policy.

## Future enabling steps (do NOT turn on prematurely)

1. Verify all five showroom coordinates using a trusted geographic source and update `09 Store Locations — Geo Pending` columns G/H plus the explicit `VERIFIED ...` status in I.
2. Provision an approved private or contracted Nominatim-compatible geocoder, with permitted storage, retention and access.
3. Set **Script Properties** in the bound project (do not add secrets to GitHub):
   - `CF_SERVICE_GEO_PRIVATE_ENABLED=true`
   - `CF_SERVICE_GEO_PRIVATE_ADDRESS_APPROVED=true`
   - `CF_SERVICE_GEO_PRIVATE_ENDPOINT=https://<approved-provider>/search`
   - `CF_SERVICE_GEO_API_KEY=<secret>` when required, sent as X-API-Key
4. Back up the bound Apps Script, reconcile exact live source with production branch and verify a complete same-project deployment before merge. **PR #57 stays draft until this gate passes.**
5. Run `GEO_TEST_selectedQueueRequest()` on one operator row, observe one HTTP call followed by cache hit with zero calls.
6. Compare exact addresses in new requests to OSM-mapped addresses, and validate location eligibility against approved business policy. Only then consider an asynchronous intake hook (do not geocode synchronously in the webhook).
7. Audit OSM attribution and provider privacy terms before exposing any map links or results outside the workbook.

## Policy limitations
- Public OSM raster tiles and public Nominatim are different services; adding a basemap alone does not validate an address.
- If a provider returns a street-level point instead of the exact house number, the result must not be used to infer in/out of service radius.
- Matching a municipal alias such as West Rouge → Toronto can select Striven Zone 508 using separately verified rules; **does not** itself certify that an address is within 25 km.
- Never treat an OSM response as authoritative evidence to overwrite a customer record without review.
- Existing zone/identity rules, no-duplicate guards, and gas-only service restrictions remain intact.

Test: `node tests/service-geo-private.test.cjs` (mock-only, no live external calls).
