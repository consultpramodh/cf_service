# Service city zone mapping — 2026-10-15

Field 798 (Zones), list 104 (Service Zones). Option IDs verified from live Striven order radio input values: Durham 506; East 507; Toronto 508; North 509; Other 510.

Enabled exact cities: Whitby, Ajax, Pickering, Oshawa → 506; Toronto → 508. Case, surrounding spaces and periods normalize. No substring matching. Service-location cache City takes precedence over intake service City and must belong to the resolved Customer/Location. Request City fallback is the submitted service city, never customer billing city.

East/North/Other and ambiguous Toronto aliases are intentionally unmapped pending business boundaries. Unmapped/blank cities and explicit non-Ontario/non-Canada addresses block new order POST. No default to Other. This mapping does not define service eligibility or technician assignment.

New order validation requires an allowed option ID. Creation verification and certification compare field 798 when an expected zone exists; older orders without a saved expectation are preserved. No existing order is rewritten by this patch.

All 14 local test scripts executed successfully. Live deployment and Christine retry must be verified separately. Jan location ambiguity and Joop existing-order certification are separate unresolved issues.

PR: https://github.com/consultpramodh/cf_service/pull/55
