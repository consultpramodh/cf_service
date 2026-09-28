# Release Notes — v5.13.5

## Customer-profile Location reconciliation

This patch changes ServiceOps Location resolution so the Customer profile is authoritative before any Location creation.

### Updated logic

- Added `GET /v1/customers/{customerId}/locations` as the first Location lookup.
- Exact service-address matching is performed against the Customer profile Location `Data[]`.
- Existing matching Locations are linked immediately; no Location POST is issued.
- If the Customer profile has no matching Location, ServiceOps reads the confirmed Customer/Primary Contact and checks the Contact address.
- Contact fallback is allowed only when the Contact address matches the submitted service address.
- A second Customer-profile/legacy duplicate check runs immediately before the single guarded Location create.
- New primary Locations are named exactly `Primary Location`.
- After a Location POST, ServiceOps requires a Customer-profile read-back before marking the Location reconciled.
- A prior Location POST is never automatically repeated.
- If the authoritative Customer-profile GET fails, Location creation is blocked.
- If the Contact address differs from the submitted service address, automatic Location creation is blocked.
- A Customer created by ServiceOps already includes PrimaryLocation; if its Location read-back is delayed, the system waits and does not create a second Location.

## Source basis

The branch was rebuilt from the current 17-file production source snapshot in the bound workbook's Code Audit Source before applying the two targeted module changes.

## Modified modules

- `00_Config.gs`
- `60_Striven_Write.gs`
