# DB SSOT v1 test map

Source of rules: `docs/implementation-db-ssot-v1.md`

As-of: 2026-03-08

## §1 Implementation profile (minimal core)
- `tests/storage/ssot-db-boundary-and-profile.test.ts`
  - `§1 includes immutable version store + idempotent writes + typed envelope fields in object_versions`
  - `§1 includes explicit structured references + session tracking via session object versions`

## §2 Core invariants
- `tests/storage/ssot-db-core-invariants.test.ts`
  - `§2.1 object identity...`
  - `§2.2 immutability...`
  - `§2.3 version_no...`
  - `§2.4 tx_seq...`
  - `§2.5 single HEAD...`
  - `§2.6 typed envelope...`
  - `§2.7 content_struct_json...`
  - `§2.8 metadata_json...`
  - `§2.9 references derived only...`
  - `§2.10 missing targets...`

## §3 SQLite schema
- `tests/storage/ssot-db-schema-indexes.test.ts`
  - `§3 objects table: exact columns and FK ...`
  - `§3 object_versions table: exact columns + JSON CHECKs + UNIQUEs + FK ...`
  - `§3 doc_references table: exact columns + CHECK/FK contracts`
  - `§3 write_idempotency table: exact columns + PK(request_id)`
  - `§3 trigger: session object_versions insert requires non-empty session_id`
  - `§3 enum/CHECK constraints reject invalid data at DB level`
  - `§3 doc_references pinned/mode/metadata JSON checks reject invalid rows`

## §4 Recommended indexes
- `tests/storage/ssot-db-schema-indexes.test.ts`
  - index existence + key-column checks
- `tests/storage/ssot-db-query-plan.test.ts`
  - query-plan evidence for `idx_versions_session_id`
  - query-plan evidence for `idx_refs_target_version` / `idx_refs_target_hash`
  - query-plan evidence for partial `idx_refs_resolved`

## §5 Write transaction contract (`putVersion`)
- `tests/storage/ssot-db-put-version-contract.test.ts`
  - Step 0 validation (`invalid_session_id`)
  - ordering rule (session validation before idempotency/optimistic checks)
  - Step 1 replay / mismatch
  - ordering rule (idempotency before optimistic conflict)
  - Step 2 object ensure
  - Step 3 optimistic guard conflict
  - Step 4 nextVersionNo
  - Step 5 typed-envelope consistency
  - Step 6 immutable version insert
  - Step 7 head + updated fields update
  - Step 8 ref extraction + per-version storage
  - Step 9 refs_hash deterministic storage
  - Step 10 write_idempotency row insert
  - Step 11 commit + returned success
  - atomic rollback failure-path

## §6 Reference extraction contract
- `tests/storage/ssot-db-refs-session-hashes.test.ts`
  - `§6.1` explicit declared field extraction only
  - `§6.2` Ref runtime contract validation
  - `§6.3` stored ref fields + resolved behavior
- `tests/storage/ssot-db-refs-hash-spec.test.ts`
  - `§6.4` `ref_metadata` excluded from `refs_hash` tuple
  - `§6.4` exact `from_path` sensitivity (array-index position affects hash)

## §7 Session realization
- `tests/storage/ssot-db-refs-session-hashes.test.ts`
  - session object realization
  - session payload shape checks
  - missing/blank `session_id` validation failures
  - `session_id` anchor consistency across session versions
  - no separate mutable `session_state` table

## §8 Hash contract realization
- `tests/storage/ssot-db-refs-session-hashes.test.ts`
  - hash columns stored and non-null as expected
  - `object_hash` preimage contract verification

## §9 StoragePort boundary
- `tests/storage/ssot-db-boundary-and-profile.test.ts`
  - boundary methods exposed
  - `putVersion` union result shape checks (success/validation/conflict)

## §10 Out-of-scope
- `tests/storage/ssot-db-boundary-and-profile.test.ts`
  - no `doc_nodes`
  - no temporal validity columns
  - no field-hash pinning columns
  - no built-in FTS tables
  - no as-of/GC/full-text boundary methods

## Known coverage gaps (current)
1. No direct behavior tests for `getReferrersByTargetVersion()` and `getReferrersByTargetHash()` methods themselves (indirectly covered via `queryReferences` behavior only).
2. No full filter-combination matrix test for `queryReferences` (`targetObjectId`, `targetVersionId`, `targetObjectHash`, `resolved`, `limit` together).
