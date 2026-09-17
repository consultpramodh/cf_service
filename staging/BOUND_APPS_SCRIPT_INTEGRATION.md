# Bound Apps Script Integration Checklist

Target Script ID (must be re-verified at release): `1QZp4NAFeA8LmWBN31ylJYdK4XFepBX1h2lP_APaR-d1lTAC-d8LA9x3g`

## Source installation

Add the V2 candidate modules to the complete local production source. Do not push a partial project.

Recommended load order:
1. existing production files through `60_Striven_Write.gs`
2. `CF_ServiceOps_V2_Shadow_Resolver.gs`
3. `CF_ServiceOps_V2_Core_Ensurers.gs`
4. `CF_ServiceOps_V2_Orchestrator.gs`
5. `CF_ServiceOps_V2_Migration.gs`
6. `CF_ServiceOps_V2_Worker_Bridge.gs`
7. existing public runners
8. `CF_ServiceOps_V2_Sheet_Runners.gs`
9. existing hardening / audit files

Apps Script file order is not guaranteed, so each module resolves dependencies at call-time rather than installation-time.

## Existing-source edits

Only two integration edits are required.

### 1. Existing onOpen

Add:
```javascript
try { if (typeof V2_addMenu === 'function') V2_addMenu(); } catch (ignoredV2Menu) {}
```

### 2. `CF.EventDrivenServiceAutomation.worker`

Immediately after the worker sets `activeRequestId=queued.id` and before the current call to `CF.AutoCustomerStructure.process`, add the bridge block documented in `V2_BUILD_STATUS.md`.

Legacy behavior remains unchanged when mode is `OFF` or `SHADOW`.

## Safe rollout

1. Install source with `CF_SERVICEOPS_V2_MODE=SHADOW`, `CF_SERVICEOPS_V2_WRITE_ENABLED=FALSE`.
2. Run `V2_TEST_selectedRow` on the known regression cases.
3. Run `V2_CERTIFY_selectedRowContracts` on a representative new-customer case.
4. Configure the single certified relationship payload mode.
5. Enable `SELECTED` for one explicitly chosen request.
6. Verify one-action-at-a-time progression, write journal, direct GETs, customer/contact phone/email, relationship and Sales Order.
7. Expand SELECTED regression set.
8. Run migration readiness.
9. Enable LIVE only when readiness passes.
10. Keep legacy modules installed during the observation period because V2 intentionally reuses their proven write boundaries.

## Rollback

Set:
- `CF_SERVICEOPS_V2_MODE=OFF`
- `CF_SERVICEOPS_V2_WRITE_ENABLED=FALSE`

With the worker bridge in place, OFF mode immediately returns control to the legacy production workflow. No source rollback is required for operational rollback.
