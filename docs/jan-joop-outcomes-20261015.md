# Jan and Joop verified outcomes — 2026-10-15

Fresh Service Requests ledger and certification journals read back after recovery:

Jan SR-20261014174558-4305: COMPLETED, Sales Order27741/#586007, SALES_ORDER_CERTIFICATION_PASS, issues=[]; zone798 expected508, returned508 / Zone3 Toronto, matched=true. Used primary service location56354 under customer34748 and contact28974. One create was made through guarded preflight/approval with duplicate/uncertain-write guards. Original pre-write worker11:52:41 was canceled after no order journal/orderID was verified both before and after cancellation; manual selected-row action then resumed. Watchdog launched another canonical worker; final completion was verified from the durable journal, not inferred from execution status.

Joop SR-20261014113555-5519: COMPLETED, existing order27702/#585968 preserved. SALES_ORDER_CERTIFICATION_PASS_WITH_REPAIRABLE_DIFFERENCES. Contact56789 verified; source855 now570 Webform passes. Remaining repairable custom-field differences: manufacturer/model 'unknown' versus default 'Unknown / Not Provided'; staff service level504 (Level2) versus default503 (Level1). Staff choices were preserved, not overwritten just to remove warnings. Existing task19132 retained; no duplicate order/task created by reconciliation.

Runtime follow-up: old CURRENT RELEASE Recovery/Resume invokes fixed September cohort. Canonical worker preflight took many minutes; successful business outcomes do not establish stable latency. Investigate this separately, and preserve duplicate/write-boundary protections.
