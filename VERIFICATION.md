# Verification report — v5.14.1

## Final result

**ONE_MODEL_LIVE_VERIFIED_PASS**

Verified on the live bound Apps Script project on 2026-09-30.

- Script ID: `1QZp4NAFeA8LmWBN31ylJYdK4XFepBX1h2lP_APaR-d1lTAC-d8LA9x3g`
- Web-app deployment: `AKfycbwebnCvczGthe6Z_mvYmukLqFLB-9nk8hjNtNP3lR87CE1m_fEx2d9Bn_vpXMPCLUnPbA`
- Apps Script version: **129**
- GitHub verification workflow run: **36745717775**
- Production commit carrying the runtime gate: `f6a2f21e5e0a3fdfc97e85166f861956378f6f7f`

## Live source verification

The release pipeline authenticated with clasp 3.3.0, pulled the exact bound Apps Script project, checkpointed it, and verified the final source after push by pulling it back from Google.

Verified results:

- `CANONICAL_MODULE_PARITY_PASS` for:
  - `20_Intake_Processing`
  - `40_Matching_Profile`
  - `50_Operator_Queue`
  - `60_Striven_Write`
  - `70_Workflow_Automation`
  - `95_Public_Runners`
  - `99_Production_Hardening`
- `REMOTE_OBSOLETE_V2_SOURCE_ABSENT`
- `LEGACY_AUTOMATION_SOURCE_ABSENT`
- `V2_GENERATION_SOURCE_ABSENT`
- `SELF_TEST_PASS`
- `DEPLOY_SOURCE_VERIFY_PASS`

The obsolete V2 shadow generation was removed from the live Apps Script project:

- `CF_ServiceOps_V2_Core_Ensurers`
- `CF_ServiceOps_V2_Migration`
- `CF_ServiceOps_V2_Orchestrator`
- `CF_ServiceOps_V2_Shadow_Resolver`
- `CF_ServiceOps_V2_Sheet_Runners`
- `CF_ServiceOps_V2_Worker_Bridge`
- `V2_Installer`

## Deployment verification

The existing web-app deployment was updated using the clasp 3.3.0 `redeploy` option syntax and then independently checked.

Verified result:

`DEPLOYMENT_PIN_PASS: AKfycbwebnCvczGthe6Z_mvYmukLqFLB-9nk8hjNtNP3lR87CE1m_fEx2d9Bn_vpXMPCLUnPbA @129`

## Live runtime verification

The deployed web app now exposes a non-sensitive runtime health result. The production workflow queried the live `/exec` deployment and received:

```json
{
  "ok": true,
  "service": "CF ServiceOps",
  "version": "5.14.1",
  "automationModel": "SINGLE",
  "singleModelVerified": true,
  "automationEnabled": true,
  "finalWorkerTriggers": 1,
  "watchdogTriggers": 1,
  "legacyAutomationTriggerCount": 0,
  "status": "SINGLE_SERVICEOPS_MODEL_VERIFIED"
}
```

The CI gate returned:

`LIVE_SINGLE_MODEL_VERIFY_PASS`

## Canonical production topology

There is one ServiceOps automation model:

- Workflow controller: `CF.EventDrivenServiceAutomation`
- Request worker: `AUTO_FINAL_ServiceOps`
- Recovery watchdog: `AUTO_98_E2E_Recovery_Watchdog`
- Customer structure engine: `CF.CustomerStructureEngine`

Historical `AUTO_00`–`AUTO_05` phase handlers, the old `AUTO_processCustomerStructure`, old `CF.AutoCustomerStructure`, runtime worker monkey patches, and the V2 shadow generation are not present in the verified live source.

---

## Historical verification — v5.13.5

## Source integrity

- Rebuilt the branch from the current 17-file Code Audit Source snapshot.
- Targeted changes are limited to `00_Config.gs` and `60_Striven_Write.gs`.
- Current v5.13.x/V2-era files are preserved instead of deploying the historical v5.8 source set.

## Static verification

- `00_Config.gs` passed JavaScript syntax validation.
- `60_Striven_Write.gs` passed JavaScript syntax validation.
- Verified `CUSTOMER_LOCATIONS_GET: '/v1/customers/{customerId}/locations'`.
- Verified Customer-create PrimaryLocation uses the exact name `Primary Location`.
- Verified standalone Location creation uses the exact name `Primary Location`.

## Targeted Location regression tests

Using the actual patched standalone Location module with mocked Striven responses:

1. Existing Customer-profile Location 58290 is found and linked with zero Location POSTs.
2. No Customer-profile Location + matching Contact 56553 address results in exactly one guarded Location POST.
3. The Location POST payload uses `Name: 'Primary Location'`.
4. A second run reads the Location from the Customer profile and reconciles it without a second POST.
5. A mismatched Contact address blocks automatic Location creation.
6. A failed authoritative Customer-profile GET blocks Location creation.
7. New-Customer reconciliation suppresses standalone creation when PrimaryLocation was already included in the Customer-create write.

Result: `LOCATION_RECOVERY_TESTS_PASS`.

## Production deployment

The corrected source is committed and verified in the fix branch. The bound Apps Script project has not been pushed from this environment because authenticated Apps Script/clasp write access is currently unavailable.
