# William Foster service scope review

Request SR-20261015094101-3886 / submission3575 explicitly asks: Wood burning fireplace. Looking for a WETT inspection and cleaning.

Live source row327 verified no Work Order ID. Prior salesOrderCreate journal shows HTTP400 REJECTED_VALIDATION and remoteWriteMayHaveSucceeded=false. The prior attempted gas Clean and Service payload was inappropriate for the gas-only workflow, irrespective of the missing Zones field.

Kept NEEDS REVIEW / BLOCKED / Manual Review YES, replaced misleading zone error with OUT OF SCOPE — WOOD/WETT, and set Next Action to review outside-scope request / do not create a gas service order. Preserved customer62895, contact56797, location58514 and the full prior write journal. No Sales Order was created or retried. Updated visible Operator Queue reason and next step. No customer notification was sent.

Source inspection found no wood/WETT/gas-only eligibility guard in the local src modules. A durable intake/preflight eligibility guard is a separate code fix; this row-level hold does not claim system-wide prevention. The displayed elapsed timer remains a separate known issue.
