# Processing time contract

Issue evidence: uploaded Pasted text(7).txt and actual source50_Operator_Queue.gs show unfinished elapsed duration used Last Striven Sync, freezing on review rows. Completed durations also used Last Striven Sync before Completed At, so certification/maintenance could change the measured endpoint.

New display: unfinished requests show Elapsed since submission, recalculated at each queue refresh, with Last activity separate. Requests with an order use matching request/order creation evidence: existing certification GET dateCreated is retained, or matching create-verification body dateCreated reused. Neither a later Last Striven Sync nor Completed At substitutes for creation. Missing evidence is explicitly unavailable; order before submission is labeled as predating the request. Explicit ISO offsets are honored.

Runtime correction: canonical workOrderStep previously called global reconcileAll repeatedly (up to five sites). It now calls reconcileRequest(requestId), running identical existing matching/duplicate reconciliation against only the current request and existing operational cache. Missing scoped implementation fails closed. Manual global maintenance remains available. No new Striven API call was introduced.

All15 local test scripts passed before merge, with targeted regression execution for moving clock, unchanged last activity, immutable completed endpoint, foreign journal, explicit timezone offset, pre-existing order and scoped reconciliation. This does not establish a new end-to-end latency SLA; future eligible live requests must be measured. Review waits and out-of-scope requests are not successful automatic-run samples.

PR56 / source7add261451c6a94f620f24db8537d4c2c1b86e2e. Deployment and live UI verification pending at checkpoint.
