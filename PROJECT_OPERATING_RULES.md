# CF ServiceOps — Project Operating Rules

## Purpose

This file is the operating contract for engineering work on CF ServiceOps. It is designed to minimize operator intervention while protecting the live spreadsheet-bound Google Apps Script project, Striven data, Google Calendar data, and the existing production deployment.

The default objective is not to produce instructions for the operator. The default objective is to complete the requested work safely, verify it, and report the outcome.

## 1. Authority and source-of-truth order

When evidence conflicts, use this order:

1. The user's explicit current instruction.
2. Current production behavior and exact live source.
3. Current project rules and documented business guardrails.
4. Current authoritative vendor/API documentation.
5. Repository source on the production branch or the active task branch.
6. Historical notes, prior releases, and older scripts.
7. Model memory or assumptions.

Never treat an old script, report cache, prior summary, or remembered behavior as stronger evidence than the current live system.

## 2. Verification-first rule

For every non-trivial change:

1. Inspect the actual source or data that controls the behavior.
2. State the exact failure or change boundary.
3. Identify dependencies and downstream effects before editing.
4. Search for contradictory evidence and edge cases.
5. Recalculate material IDs, dates, counts, filters, thresholds, and file inventories independently where applicable.
6. Implement the smallest sufficient change.
7. Run targeted tests against the changed logic and its dependencies.
8. Verify the live result after deployment.
9. Preserve a rollback checkpoint.

Never say a change is verified, deployed, tested, or fixed unless that action actually occurred.

## 3. Minimal-manual-intervention rule

Repeated deterministic procedures must be automated.

The operator should not be asked to perform a long sequence of routine steps that the release or workflow system can perform safely itself. Manual intervention is reserved for genuine ambiguity, missing authorization, irreversible business decisions, or unsafe writes.

When the user says "fix it", "continue", or equivalent, continue the established task through implementation and verification unless the user explicitly limits the work to review, planning, preview, shadow mode, or no deployment.

## 4. Production Apps Script identity lock

The release system must never guess which Apps Script project or deployment to modify.

Before any production write it must verify:

- the configured Script ID;
- the existing production deployment ID;
- authentication identity;
- a complete live source pull;
- the expected project manifest;
- the expected file inventory or approved removals;
- the intended patch scope.

A mismatch is a hard stop.

## 5. Complete-project push rule

Google Apps Script project updates are whole-project operations. Therefore:

> Patch only the intended files, but push a verified complete local project.

Never construct a partial two-file or single-file project and push it to Apps Script. A partial project push can delete unrelated production files.

The release workflow must first pull the complete live project, apply the targeted patch into that complete copy, verify the resulting inventory, and only then push.

## 6. Automation-first release rule

Any deterministic production deployment procedure that repeats must be encoded once and executed automatically thereafter.

The normal release path must perform all of the following:

1. authenticate;
2. verify project and deployment identity;
3. pull the exact live bound project;
4. create a durable pre-change checkpoint;
5. apply only approved targeted changes;
6. verify file inventory and manifest preservation;
7. syntax-check changed source;
8. run targeted static/behavior checks;
9. reject forbidden legacy source;
10. push the complete project to the same Script ID;
11. pull the remote source back once;
12. verify whole-project source parity;
13. create an immutable Apps Script version;
14. update the existing production deployment rather than creating a new web-app URL;
15. run a read-only production health check;
16. run targeted release acceptance checks;
17. record hashes, deployment version, health result, and acceptance result;
18. automatically restore the exact pre-release source and deployment when a post-push verification failure creates uncertainty.

Manual repetition of these steps is fallback behavior, not the normal workflow.

## 7. Release speed rule

Optimize time-to-verified-outcome, not time-to-first-write.

Allowed optimizations:

- use a permanent release workspace;
- pin clasp locally and reuse it;
- parallelize independent preflight checks where practical;
- test changed files and their dependencies instead of rerunning unrelated test suites;
- perform one authoritative remote parity pull after push;
- perform one read-only health check and one targeted acceptance check after redeployment;
- avoid redundant report refreshes and repeated API reads.

Do not optimize away project identity checks, rollback checkpoints, complete-project inventory protection, remote parity verification, or post-deploy acceptance.

## 8. Rollback rule

A successful push is not the same as a successful release.

If a failure occurs after the remote Apps Script HEAD was changed and the final production state cannot be verified, the release system must restore the exact pre-release project snapshot, verify parity, create a rollback version, and repoint the existing deployment to the rollback version.

Do not leave production in an uncertain HEAD/deployment split state.

## 9. Secret handling

Never put credentials, access tokens, client secrets, API keys, OAuth files, or private Script Properties into:

- GitHub source;
- logs;
- release reports;
- prompts;
- screenshots intended for sharing;
- test fixtures;
- generated documentation.

Repository ignore rules must cover `.clasp.json` and `.clasprc.json` where appropriate. Secret-bearing Script Properties remain server-side.

When reviewing a screenshot or source that contains credential-like values, do not repeat those values in output.

## 10. Read-only health-check rule

A health endpoint must not mutate business data, queue requests, create triggers, refresh large reports, call Striven write endpoints, or alter workflow state.

The release health check may read:

- current application version;
- automation enabled/disabled state;
- trigger topology;
- presence of legacy handlers;
- guard configuration;
- non-mutating queue metadata.

Any endpoint that performs operational work is not a valid release health endpoint.

## 11. Source ownership and module preservation

Preserve existing functions, interfaces, field names, schemas, and public entry points unless the task explicitly requires changing them.

Before modifying a module:

1. identify its public functions;
2. identify callers and dependent modules;
3. identify persistent state/properties it reads or writes;
4. identify external APIs it calls;
5. identify idempotency and duplicate-prevention rules;
6. identify tests or release gates that depend on it.

Do not delete unrelated source to simplify a patch.

## 12. Striven evidence rule

Striven is authoritative for durable business entities.

Shared reports and cached sheets are discovery aids. Cache absence never proves that a Customer, Contact, Location, Sales Order, Work Order, Task, Invoice, or other Striven record does not exist.

Before a destructive or duplicate-creating decision, prefer an authoritative targeted Striven read when one exists.

An uncertain create response must switch to read-only reconciliation. Do not automatically repeat a POST when the first write may have succeeded.

## 13. Request isolation and idempotency

Every automation action must remain request-scoped.

A result for a different Request ID must never advance the current request.

Every create/write path must have:

- a deterministic preflight;
- duplicate protection;
- a write fingerprint or equivalent idempotency guard where applicable;
- a write journal or durable attempt record where applicable;
- authoritative read-back after the write;
- no automatic second POST when success is uncertain.

## 14. Deterministic logic versus JEV semantic judgment

Use deterministic code for facts and rules that can be established exactly, including:

- exact IDs and keys;
- schema validation;
- permissions;
- required business rules;
- API contract rules;
- parsed dates;
- arithmetic;
- retry/idempotency logic;
- destructive writes;
- workflow state transitions.

Use JEV only for bounded semantic judgments where code already has the candidates and evidence but needs interpretation, for example:

- ambiguous identity resolution among a known candidate set;
- semantic comparison of incomplete customer evidence;
- bounded routing/classification;
- support/no-support verification against supplied evidence;
- confidence-aware AUTO versus REVIEW decisions.

JEV never owns writes, permissions, IDs, retry policy, or state transitions.

Before version-sensitive JEV integration work, read the current TypeSafe documentation. Treat live TypeSafe docs as authoritative over remembered SDK/API behavior.

Questions, candidate sets, thresholds, and fallback behavior must be centralized and reviewable. No-match behavior must exist when no candidate may be valid.

## 15. JEV failure policy

For high-impact automation:

```text
hard deterministic rule fails -> BLOCK
hard deterministic rule passes + semantic evidence is sufficient -> AUTO
semantic evidence is ambiguous/conflicting -> REVIEW
JEV/API unavailable -> deterministic fallback or REVIEW; never unsafe AUTO
```

A model confidence score can never override a deterministic prohibition.

## 16. Testing rule

Testing must match the change surface.

Required classes where relevant:

- positive case;
- negative case;
- ambiguous case;
- missing-data case;
- conflicting-data case;
- duplicate/idempotency case;
- stale-cache case;
- API timeout/error case;
- uncertain-write case;
- rerun case.

For Apps Script source, syntax validation must work with `.gs` content rather than assuming Node accepts `.gs` files as modules.

Do not run destructive production tests merely to prove a code path when a read-only or controlled canary can establish the same fact.

## 17. Calendar rule

Google Calendar is a source to read and reconcile unless a specific approved workflow requires a defined write-back such as a task link.

Do not modify unrelated calendar event data.

Calendar write-backs must be idempotent and must not duplicate links or overwrite existing description content beyond the approved rule.

## 18. Operator Queue rule

The Operator Queue is a projection of authoritative request/Striven state, not an independent source of truth.

Keep operator-facing status concise. Show durable IDs and actionable state rather than dumping internal diagnostics into customer-facing or operator-facing cells.

Detailed diagnostics belong in structured logs or audit fields.

## 19. Performance rule

Avoid repeated full-report refreshes inside a single request path when a targeted read can answer the question.

Prefer:

- request-scoped reads;
- bounded candidate retrieval;
- cached shared discovery data with freshness metadata;
- targeted authoritative verification before write;
- one final queue refresh when sufficient.

Do not trade correctness for lower API volume, but do not use a full report as a substitute for a precise read when the precise read is available.

## 20. Logging and observability

Logs must answer:

- Request ID;
- module/action;
- start/end or duration;
- source state;
- resulting state;
- whether a remote write was attempted;
- whether a remote write was verified;
- error class;
- retry/reconciliation action;
- release/application version.

Do not log secrets or raw credential-bearing payloads.

## 21. Change-control rule

Use a dedicated task branch for implementation work unless the user has explicitly designated an existing working branch.

Do not merge to `main` or `production` unless explicitly requested or established by the project's release procedure.

Keep one coherent task on one branch rather than creating unnecessary branch churn for every small revision.

## 22. Definition of done

A technical change is complete only when all applicable items are true:

- source-of-truth inspected;
- change boundary identified;
- dependencies checked;
- patch implemented;
- syntax/static checks pass;
- targeted tests pass;
- unrelated files preserved;
- live project identity verified;
- rollback checkpoint exists;
- complete-project push verified by remote parity;
- existing deployment updated to the intended immutable version;
- read-only production health check passes;
- targeted acceptance check passes;
- release report/checkpoint written;
- operator-facing result is concise and actionable.

If any required item is unknown, the status is not VERIFIED.

## 23. Communication rule

Lead with the actual result.

Use these status meanings precisely:

- **VERIFIED** — checked against authoritative evidence or executed and read back successfully.
- **INFERRED** — logically derived from verified facts.
- **ASSUMED** — necessary assumption not established by evidence.
- **UNKNOWN** — insufficient or conflicting evidence.

Do not bury the next action in a long explanation. If the system can execute the next deterministic step safely, execute it instead of turning it into operator homework.

## 24. Current production release command

Normal production release:

```bash
node scripts/release.mjs --execute --description "<requested change>"
```

Read-only local release validation:

```bash
node scripts/release.mjs --self-test
```

The release script is the implementation of the deployment rules above. The manual process is the fallback specification, not the normal operating path.