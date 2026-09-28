# Verification report — v5.13.5

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
