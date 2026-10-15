# Processing time live verification — version204

PR56 merged as7add261451c6a94f620f24db8537d4c2c1b86e2e. Deployment run38777270462 completed successfully. Logs verified all17 live baseline files against immutable203 source, remote content parity, existing deployment pinned204 and LIVE_SINGLE_MODEL_VERIFY_PASS. All15 local regression scripts passed; processing-time and zone checks also required in deployment workflow.

Live Queue readback after refresh:
- William SR-20261015094101-3886: last activity10:05 remains distinct; elapsed since submission advanced3h57m to3h59m on subsequent refresh. Original display was frozen33m.
- Christine: actual creation11:30, request-to-order1h56m; later sync does not supply endpoint.
- Jan: creationOct15 12:13, request-to-order18h31m, including overnight review wait.
- Joop: original displayed24h29m ended at later certificationOct15 12:03. Operational cache row3444 / SERVICE_WORK_ORDERS explicitly identifies order27702, customer62888, Created At serial46309.59652777778 = Oct14 14:19 America/Toronto. Matching certification timing field backfilled with this cache evidence and provenance. Queue now shows request-to-order2h44m. No Striven API call for the backfill.
- SR-20261015122054-9166 order27747: stored certification predates creation-timestamp retention and contains no dateCreated; current operational cache lacks that order. Display remains creation time unavailable. Do not substitute Completed At/Last Sync or call it57m without creation evidence.

Canonical worker no longer invokes full-history reconcileAll during a request. It invokes identical matching logic on one source request with existing operational cache; global maintenance remains separate. Faster real-world latency is not yet measured or guaranteed. No new business request/order was fabricated for a speed test.

The first separate Queue refresh workflow got HTTP404 after85seconds. One safe projection-only retry was submitted; actual Sheet reads above establish live display behavior independently of that job's conclusion.
