# Zone deployment 203 verification

Deployment run: https://github.com/consultpramodh/cf_service/actions/runs/38757387476
Source commit: 6682a24e5bd7f844ddbe112182ebbfc952ff077a (PR 55).

Checked job logs: exact live 17-file baseline parity passed against immutable release-202 source commit 6f971250952a1a055d6df04c4acffac7a7f0aa99 with release transforms. All eight release module source read-backs passed. Existing deployment was updated to Apps Script version 203.

Live health response: singleModelVerified=true, automationEnabled=true, finalWorkerTriggers=1, watchdogTriggers=1, legacyAutomationTriggerCount=0. Entire workflow completed successfully.

Previous source remains in immutable Git history and a pre-change workflow artifact (artifact retention is 30 days; do not rely on artifacts as the permanent backup). Old version 202 deletion has NOT been performed or verified in this session.

Christine SR-20261015093621-2471: verified prior order POST HTTP400 REJECTED_VALIDATION with remoteWriteMayHaveSucceeded=false and no order ID. Released only the row's review/status controls to CUSTOMER STRUCTURE COMPLETE / OPEN / Manual Review NO for the existing watchdog to retry. Original write journal preserved. Customer62897, contact56799, location58515. Whitby maps to zone506. Actual new order creation/certification still pending at checkpoint time.

Jan location ambiguity and Joop order585968 contact/custom-field certification remain separate unresolved blockers. Do not create another order for Joop.
