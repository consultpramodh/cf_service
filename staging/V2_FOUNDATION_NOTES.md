# CF ServiceOps V2 Foundation — Shadow Resolver

**Status:** STAGED ONLY — NOT DEPLOYED TO GOOGLE APPS SCRIPT  
**Date:** 2026-09-17  
**Branch:** `refactor/v2-shadow-resolver-20260917`

## Scope of this update

This stage introduces a read-only canonical resolver. It does not modify Striven, Service Request rows, Sales Orders, Contacts, Customers, Locations, or Contact associations.

The resolver establishes one ordered set of business facts:

1. Customer confirmed
2. Customer phone confirmed
3. Customer email confirmed
4. Location confirmed
5. Contact confirmed
6. Contact phone confirmed
7. Contact email confirmed
8. Customer–Contact relationship confirmed
9. Sales Order confirmed
10. Complete

It uses direct Striven GET reads for durable Customer and Contact IDs. Worksheet/cache data is supporting evidence only.

## Production-source findings that drove this design

Current `CF.CustomerContactInfoSync` already synchronizes Customer phones and Contact phones/email, but Customer email is not included in the current Customer DTO or completion criteria.

The current Customer update path can also skip the entire Customer update when unresolved/invalid required custom fields are present. This means core Customer details such as submitted phone/address may remain unsynchronized because an unrelated custom-field contract is unresolved.

The current Contact create/recovery code correctly detects a duplicate Contact, verifies its identity with a direct GET, and preserves the canonical Contact ID. The remaining hard stop is the Customer–Contact association step.

Recent Contacts discovered by direct Striven GET are not consistently present in the Customer/Contact cache, so cache-only resolution is not sufficient for the V2 state model.

## Customer email rule

Customer email is now a required V2 business fact. The shadow resolver does not invent a Striven Customer email payload shape. If Customer GET does not expose a supported email field/collection, the fact is reported as `API_FIELD_UNRESOLVED` and the next required fact remains `CUSTOMER_EMAIL_CONFIRMED`.

This prevents a false "complete" state until the Customer email API contract is certified.

## Tests

The staged module passed automated tests for:

- fully complete structure
- missing Customer email
- Customer email API field not observable
- missing Customer–Contact relationship
- missing Contact email
- missing Customer phone
- conflicting durable Customer IDs
- GET-only Striven access / no mutation calls

## Next implementation gate

Before enabling any V2 Striven writes, certify these two contracts against the live API without changing normal production orchestration:

- supported Customer email read/write representation
- exact Contact-to-Customer association payload + read-back verification

After those contracts are proven, the existing guarded Customer/Contact writer can be refactored into field-level `ensureCustomerDetails` / `ensureContactDetails` operations, with core phone/email updates decoupled from optional custom-field enrichment.
