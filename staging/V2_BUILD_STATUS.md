# CF ServiceOps V2 — Build Status

Date: 2026-09-17
Candidate package: 0.6.x

## What is built

The V2 candidate architecture is implemented as isolated modules:

- `CF_ServiceOps_V2_Shadow_Resolver.gs` — direct-GET, read-only fact resolver.
- `CF_ServiceOps_V2_Core_Ensurers.gs` — fact-to-action planner plus guarded ensure adapters.
- `CF_ServiceOps_V2_Orchestrator.gs` — one-fact-at-a-time canonical state controller.
- `CF_ServiceOps_V2_Migration.gs` — OFF / SHADOW / SELECTED / LIVE feature gate.
- `CF_ServiceOps_V2_Worker_Bridge.gs` — bridge into the existing one-shot production worker.
- `CF_ServiceOps_V2_Sheet_Runners.gs` — selected-row Google Sheet test surface and contract probes.
- `tests/test_v2_shadow_resolver.js` — foundation tests.
- `tests/test_v2_controller.js` — controller / write-gate / one-post tests.

## Production components intentionally reused

V2 wraps the existing proven write boundaries instead of rewriting them:
- `CF.StrivenControlledCustomerCreate.executeAutoCustomerCreate`
- `CF.StandaloneLocationCreateV5128.process`
- `CF.StrivenControlledContactCreate.executeAutoContactCreate`
- `CF.OrderPreflight.previewRequest / approveRequest / executeApproved`

This preserves existing duplicate protection, write fingerprints, journals, Sales Order payload behavior and read-back verification.

## Canonical state chain

`CUSTOMER_CONFIRMED`
→ `CUSTOMER_PHONE_CONFIRMED`
→ `CUSTOMER_EMAIL_CONFIRMED`
→ `LOCATION_CONFIRMED`
→ `CONTACT_CONFIRMED`
→ `CONTACT_PHONE_CONFIRMED`
→ `CONTACT_EMAIL_CONFIRMED`
→ `RELATIONSHIP_CONFIRMED`
→ `SALES_ORDER_CONFIRMED`
→ `COMPLETE`

Actions are recalculated from verified facts every run. The initial Transaction Plan is not used as live state.

## Guardrails

- V2 Striven writes default OFF.
- Every V2 mutation requires both `CF_SERVICEOPS_V2_WRITE_ENABLED=TRUE` and explicit `confirmLiveWrite`.
- Exactly one V2 remote mutation boundary per orchestrator execution.
- No automatic mutation-contract probing.
- Customer-email mutation stops if the live Customer GET does not reveal a certified email shape.
- Contact association stops until one payload mode is explicitly certified.
- Every core update is read back and verified.
- Existing custom fields are excluded from the V2 core phone/email payload so unrelated custom-field failures cannot suppress mandatory core synchronization.
- Relationship conflicts become business review; technical contract/read failures do not automatically become human business review.

## Live contract gates

Two live facts must be certified from the bound project before LIVE mode:
1. Customer email write/read shape.
2. Contact → Customer association payload shape.

The read-only Sheet runner captures the evidence without mutating Striven. The relationship writer accepts exactly one configured mode; it never tries multiple POST bodies.

## Production integration point

The current `CF.EventDrivenServiceAutomation.worker` remains the queue/trigger owner.

After it selects `queued.id` and before it calls `CF.AutoCustomerStructure.process`, insert a small V2 bridge branch:

```javascript
var v2 = CF.V2WorkerBridge && typeof CF.V2WorkerBridge.tryProcess === 'function'
  ? CF.V2WorkerBridge.tryProcess(queued.id)
  : {handled:false};

if (v2.handled) {
  if (v2.dequeue) {
    try { dequeue_(queued.id); } catch (ignoredV2Dequeue) {}
  }
  if (v2.shouldContinue) {
    v2.nextTrigger = scheduleNext_(v2.continuationReason, currentUid);
  } else {
    v2.nextTrigger = {ok:true,scheduled:false,reason:v2.complete?'V2_COMPLETE':'V2_TERMINAL_STOP',liveWriteExecuted:false};
  }
  finalReason = v2.status;
  finalResult = v2;
  return finalResult;
}
```

This keeps the existing queue, one-shot scheduling, final operator-queue refresh, and E2E logs.

The existing production `onOpen()` should call `V2_addMenu()` once so Sheet testing is directly available.

## Test result

`test_v2_controller.js`: PASS (9 controller scenarios).

Static syntax check: PASS for every new `.gs` candidate file.

## Not yet claimed

This package is **not** called production-complete until:
- it is installed into the bound Apps Script project,
- selected-row Sheet tests execute direct Striven GETs,
- live contract gates are certified,
- SELECTED mode passes known successful and blocked requests,
- LIVE mode is enabled through the guarded migration gate,
- final production regression and timing checks pass.
